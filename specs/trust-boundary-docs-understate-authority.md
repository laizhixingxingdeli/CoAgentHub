# Spec: 信任边界的文档描述小于实际授权范围

> **状态**: Landed(`03482f24`,2026-09-08 检视者 L3 通过)
> **版本**: 1.0
> **日期**: 2026-09-08
>
> **L3 收口记录(检视者独立复核)**:
> - **零代码改动**:`git show --name-only` 只有 3 个 `.md`。硬约束满足。
> - **ADR 决策段未改(R1)**:该文件的 diff **只有 `+` 行,没有 `-` 行** ——
>   是纯追加的「2026-09-08 补记:决策做出后新增的授权面」一节,
>   决策与背景段零 diff。做法正确:让读者看得出这是后补的。
> - **四项全覆盖**:注册执行器(任意 bin/args/env + 自动注册 participant)、
>   spawn 环境继承、任意 `project_path` 写 git ref、`/api/file/*` 无鉴权读写。
> - **不与报告 §7 冲突**:ADR 补记结尾原句 ——
>   「**这些不是待修缺陷,而是同一「局域网全信」决策在执行器与文件能力落地后的
>   自然外延**」;README 仍以「Run it on a LAN you trust」收束,
>   无 bug / TODO / should add auth 类措辞。
> - **中英一致(R3)**:英文
>   「Anyone who can reach the port can **make this machine run arbitrary
>   programs**」,中文「任何能访问该端口的人都能**让这台机器执行任意程序**」,
>   四项授权逐条对应。
>
> **连带**:本票同时把
> [executor-config-fields-saved-but-never-honored.md](executor-config-fields-saved-but-never-honored.md)
> L3 中记录的那处张力(server spawn 继承 `process.env`,而
> `POST /api/executors` 无鉴权 —— 「已配置」不等于「可信」)在文档层面说准了。
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` §13.7 **D4**
> **性质**: **纯文档准确性**问题。
> **不推翻**报告 §7「LAN 全信边界是决策而非缺陷」的结论,
> **不引入认证**,**不改任何实现**。

## 1. 背景与目标

### 1.1 现状证据(检视者已复核)

`README.md` 第 16–18 行的警告:

> **No authentication.** Anyone who can reach the port can **register a
> participant and send messages**. Run it on a LAN you trust; never expose it to
> the public internet.

**但实际授权范围远大于此**:

| 能力 | 出处 | 后果 |
|---|---|---|
| `POST /api/executors` 无鉴权,接受任意 `bin` / `args` / `env`,并**自动注册对应 participant** | `routes/executor/index.ts:20-30` 注释明确写着「无鉴权…LAN 内任何客户端都能读取/新增/删除/编辑执行器配置」 | **让这台机器执行任意程序** |
| spawn 时**继承后端进程的完整环境变量** | AGENTS.md 还要求后端必须能拿到代理变量 | 被 spawn 的程序拿得到 server 的全部 env |
| 在**任意 `project_path`** 下写 git ref | checkpoint 机制 | 可在机器上任意仓库写 ref |
| `/api/file/*` 无鉴权读写磁盘 | `routes/file.ts` | 任意读写 |

**准确的表述是:任何能访问该端口的人都能让这台机器执行任意程序。**

`docs/adr/0002-lan-trust-model-and-local-user.md` 写于该项目还是**聊天应用**的时候。
它「安全边界 = 局域网信任」的结论**仍然成立**,
但它**没有记录后来加入的执行器注册与 spawn 能力**。

### 1.2 危害

读者(包括未来的自己)会按 README 的描述估计风险。
「能发消息」和「能让这台机器跑任意程序」是**完全不同量级**的授权 ——
按前者判断「放在家里 WiFi 上没事」是合理的,按后者就未必。

**文档没跟上实现,导致基于文档做的风险判断是错的。**

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `docs/adr/0002-lan-trust-model-and-local-user.md` | 「后果」段补齐当前实际授权的操作类别 |
| `README.md` | 警告改为覆盖执行能力 |
| `README_CN.md`(若存在) | 同步 |

**不改**:任何实现;不引入认证;不改 ADR-0002 的**结论**
(「安全边界=局域网信任」仍然成立);不改报告 §7 的立场。

## 3. 详细改动

### R1. ADR-0002 补「后果」,不改「决策」

在**后果**段列明当前实际授权的操作类别(至少 §1.1 表里那四项)。

⚠️ **不要改 ADR 的决策与理由段**。ADR 是决策记录 ——
当时的决策没错,错的是它写下之后系统长出了新能力而没有回记。
用**追加**的方式(例如一节「2026-09-08 补记:决策做出后新增的授权面」),
让读者能看出这是后来补的,而不是假装当时就想到了。

### R2. README 的警告改为覆盖执行能力

现在的「register a participant and send messages」要扩到
「**让这台机器执行任意程序**」这个量级。

保持**原有的语气与结构**(它已经是一段醒目的 blockquote 警告),
只是把授权范围说准。不要写成长篇安全分析 —— README 里它应该还是一段。

### R3. 中英文同步

`README_CN.md` 若存在,同步同一处。两份的**含义必须一致**,
不要一份说「执行任意程序」另一份说「运行命令」。

## 4. 验收标准

1. **覆盖四项**:ADR-0002 与两份 README 的描述能覆盖
   ① `POST /api/executors`(任意 bin/args/env + 自动注册 participant)
   ② spawn 环境继承
   ③ 任意 `project_path` 写 git ref
   ④ `/api/file` 无鉴权读写。
   在汇报里逐项指出**写在哪一句**。
2. **不与 §7 冲突**:改后的文字**不得**把无认证描述成实现缺陷或待修项 ——
   它是决策。在汇报里引用你写的原句自证。
3. **ADR 决策段未改**:`git diff` 中 ADR-0002 的决策/理由段无改动(R1)。
4. **中英一致**(R3):在汇报里把两份的对应句子并排贴出来。
5. **零代码改动**:`git show --stat` 只含 `.md` 文件。**硬约束。**

## 5. 不涉及的改动

- **不引入认证**、不改任何实现、不改路由。
- **不推翻** ADR-0002 的结论,不改其决策段。
- 不改报告 §7 的立场(无认证在当前定位下是决策不是缺陷)。
- 不处理 D3(spec 目录知识分散)—— 另票。

## 6. 兼容性

- 纯文档,无行为变更。
