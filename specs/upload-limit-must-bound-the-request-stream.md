# Spec: 上传上限没有约束请求流本身,无 Content-Length 的请求可以无限缓冲

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-07
> **来源**: [docs/implementation-optimization-review-2026-09-07.md](../docs/implementation-optimization-review-2026-09-07.md)
> R10 的**上传**部分(Windows 运行契约那半已拆走,与本票无关)。

## 1. 背景与目标

### 1.1 现状证据

[`file.ts`](../packages/backend/server/src/routes/file.ts) 的 `POST /api/file/upload`
按这个顺序做事:

| 步骤 | 代码 | 能挡住什么 |
|---|---|---|
| ① | `Number(c.req.header("content-length"))` 超限 → 400 | 只挡**声明了**长度且超限的请求 |
| ② | `await c.req.formData()` | **把整个请求体解析进内存/临时区** |
| ③ | `file.size > MAX_FILE_UPLOAD_BYTES` → 400 | 已经在 ② 之后 |
| ④ | `streamFileToDisk` 流式写盘 | 只省了「再拷贝一份 Buffer」,与请求体大小无关 |

### 1.2 缺口

**① 是唯一的事前闸,而它可以被绕过:**

- **无 `Content-Length` 的请求**(HTTP chunked / `Transfer-Encoding: chunked`)——
  `Number(undefined)` = `NaN`,`Number.isFinite(NaN)` 为 false,**整个预检被跳过**,
  直接进 ②。请求体多大,就缓冲多大。
- **谎报 `Content-Length`**:声明一个小值、实际发更多,同样跳过预检。
- **多 part 请求**:预检看的是整体 `content-length`,而 ③ 只校验
  `formData.get("file")` **一个字段**。其余 part(或多个同名 part)的字节
  在 ② 里已经被读完、被计入内存,却从不参与任何上限判断。

④ 的流式写盘是**解析之后**的事:`formData()` 返回时,字节早就进来了。
报告原话:「**不以流式写盘替代解析前限制**」。

### 1.3 危害

LAN 全信边界不等于「任意一台机器可以让 server 进程 OOM」。一条 chunked 上传
就能让 server 无上限地吃内存/临时磁盘,而且**没有任何日志能说明它为什么死** ——
预检从未触发,`file.size` 从未被读到。

### 1.4 目标

**上限必须作用在实际的请求字节流上**,与是否声明 `Content-Length`、
声明是否属实、有几个 part 都无关。超限时**尽早终止**,不留半成品。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/routes/file.ts` | `POST /upload`:在解析前对请求流施加累计字节上限 |
| `packages/backend/server/test/file.test.ts` | 新增定向用例(见 §4) |

**不改**:`MAX_FILE_UPLOAD_BYTES` 的取值与 env 覆盖(`maxFileUploadBytes()`);
`MULTIPART_FRAMING_ALLOWANCE` 的语义(仍需要余量,只是不再是唯一的闸);
`sanitizeFileName` / `resolveFilePath` 的路径穿越校验;`streamFileToDisk`
(它解决的是另一个问题,保留);GET/DELETE 两个端点;`group-file` 相关路由。

## 3. 详细改动

### R1. 在解析前给请求流套累计字节上限

`c.req.formData()` 之前,把请求体换成一个**会计数并在超限时中止**的流。
上限 = `MAX_FILE_UPLOAD_BYTES + MULTIPART_FRAMING_ALLOWANCE`(与现有预检同一口径,
避免恰好等于上限的文件被误拒)。

要求:

- **不依赖 `Content-Length`**:无论请求是否声明长度、声明是否属实,计数都以
  **实际读到的字节**为准;
- **超限即停**:达到上限就中止读取并返回 **400 + `{ message: "文件过大" }`**
  (文案与现有两处逐字一致,前端/调用方不需要区分是哪一道闸拦的);
- **不得先读完再判断** —— 那等于没修。

`Content-Length` 预检(①)**保留**:它能在一个字节都不读的情况下拒掉诚实的大请求,
是廉价的快速路径。本票加的是它挡不住的那部分。

### R2. 多 part 的累计计入

上限是**整个请求体的累计字节**,不是单个 part。多 part / 多个同名 `file` part
的字节全部计入同一个计数器。

`file.size > MAX_FILE_UPLOAD_BYTES` 的逐文件校验(③)**保留不变**。

### R3. 不留半成品

超限终止时:

- **不得**在 `FILE_DIR` 留下任何文件或临时文件(此时还没走到写盘,天然满足;
  实现若引入了临时落盘,必须自己清理);
- 已建立的连接按 400 正常结束,不得让调用方看到连接被硬断而无响应体;
- 不得抛未捕获异常导致 500(超限是可预期的客户端错误,不是服务端故障)。

### R4. 失败要可诊断

超限拒绝时记一条可检索的日志,至少含:实际读到的字节数、上限值、
是否声明过 `Content-Length`。现状的问题之一就是**进程死了也不知道为什么**。

## 4. 验收标准

**本机基线(检视者 2026-09-07 21:47 实测,先量后写)**:

```
cd packages/backend/server && npx vitest run test/file.test.ts test/group-file.test.ts
→ Test Files 2 passed (2) | Tests 12 passed (12)
```

**这两个文件是全绿基线,因此本票的验收口径是「保持全绿」**,不是「失败数不增加」。

1. **无 Content-Length 的超大请求被拦(核心)**
   构造一个 `Transfer-Encoding: chunked`(或等价地:构造 Request 时不设
   `content-length`)、实际字节数超过上限的 multipart 上传。
   断言:响应 **400**、body 为 `{ message: "文件过大" }`;
   `FILE_DIR` 下**没有新增文件**;进程未抛未捕获异常。
   ⚠️ **这条用例在改动前必须是红的** —— 汇报里给出「改前红、改后绿」的对照。
   (改前的表现应是:请求被完整缓冲后才因 `file.size` 拒绝,或直接超时/OOM;
   如果改前它恰好也返回 400,说明用例没有真正绕过预检,**必须重构造**。)

2. **谎报 Content-Length**:声明一个小于上限的值,实际发送超过上限的字节。
   断言:400 + `文件过大`,无新增文件。

3. **多 part 累计**:两个 part 各自不超限、**合计**超限。
   断言:400 + `文件过大`,无新增文件。

4. **正常上传不受影响(回归)**:小文件上传仍 200,返回 `{name,size,url}`,
   文件确实落在 `FILE_DIR`,内容逐字节一致。

5. **恰好等于上限的文件仍可上传**(framing 余量的既有语义不被破坏):
   构造 `size === MAX_FILE_UPLOAD_BYTES` 的文件(测试里用 env 把上限调小,
   不要真的传 200MB),断言 200。

6. **诚实的超大请求仍被 Content-Length 预检拒**(快速路径回归):
   声明超限且实际超限 → 400,且断言**没有读取请求体**
   (可用「服务端计数器为 0」或等价手法证明走的是快速路径;
   若无法直接观测,在汇报中说明如何论证)。

7. **定向测试保持全绿**:
   ```
   cd packages/backend/server && npx vitest run test/file.test.ts test/group-file.test.ts
   ```
   贴改动前后计数,**改动后必须 0 failed**,新增用例全绿。

8. `cd packages/backend/server && npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- **不改上限取值**:200MB 默认与 `MAX_FILE_UPLOAD_BYTES` env 覆盖不动。
- **不改 R10 的 Windows 那半**(临时目录、进程树终止),那是另外的票。
- **不改 GET/DELETE、不改路径穿越校验、不改 group fileRef 信令**。
- **不引入新依赖**(AGENTS.md:无正当理由不加依赖)。
- 不为提速而放宽任何既有校验。

## 6. 兼容性

- 合法上传行为逐字不变(验收 4/5 锁定)。
- 行为变更:此前能把 server 缓冲到死的 chunked / 谎报长度 / 多 part 请求,
  现在在读到上限时即 400。依赖这种行为的客户端属于依赖缺陷,不予兼容。
- 无 schema 变更,无迁移,无配置变更。
