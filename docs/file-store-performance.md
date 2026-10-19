# 状态文件落盘性能基线（合成负载）

本文记录一次**合成负载**的落盘耗时基线，用来判断「每次写都整份落盘」这件事值不值得现在动。它**不是**生产压测，不能用来推断真实 Mission 的吞吐。

## 怎么复跑

```bash
node scripts/benchmark-file-store.ts                      # 默认 --sizes 1,10,50 --samples 4
node scripts/benchmark-file-store.ts --sizes 1 --samples 2
```

- 只新增 `scripts/benchmark-file-store.ts`，**不改**生产存储逻辑（`src/application/file-store.ts` 原样使用）。
- 脚本用 Node 内置的 `FileStateStore`，在系统临时目录里 `mkdtempSync('coagent-persist-bench-')` 建隔离目录，每个档位一个 `synthetic-N.json`。
- 事件全是合成的：`kind=synthetic.benchmark`，project/mission 固定为 `synthetic-project` / `synthetic-mission`，每 MB 1024 条、每条 `data.payload = 'x'.repeat(1024)`。
- 每档对**真实** `store.flush()` 调用 `samples` 次，用 `performance.now()` 计时，并 `stat` 出文件大小；逐档输出 JSON：`{source:'synthetic-only', sizeMB, flushMs, fileMB}`。
- 参数范围：`--sizes` 每项 1..64，`--samples` 1..10；参数不合法直接非 0 退出。
- 清理：`finally` 里先 `realpath` 核实目录确实在系统临时目录下、且目录名以 `coagent-persist-bench-` 开头，才 `rmSync`；否则拒绝清理。
- 不读、不写本仓库的 `.coagent-state.json`、archive 目录或任何凭据文件。

## 本轮实测（2026-10-19，主 agent 隔离环境）

`samples=4`，每档 `flushMs` 为四次的耗时：

| sizeMB | 实测文件大小 | flushMs |
| --- | --- | --- |
| 1 | 1.21 MB | 5.0, 5.1, 4.4, 4.3 |
| 10 | 12.08 MB | 21.9, 22.9, 21.1, 22.0 |
| 50 | 60.44 MB | 245.4, 242.0, 255.0, 302.7 |

复跑确认（`--sizes 1 --samples 2`）：`1.21 MB → 5.5, 5.4 ms`。

可见耗时随体积大致线性增长（每 MB 约 0.5–5 ms，且尾档出现抖动，最大 302.7 ms），与「整份序列化 + 写临时文件 + rename」的成本模型一致。

## 怎么读这组数

- `flush()` 是**同步**路径：`JSON.stringify` 整份状态、`writeFileSync` 临时文件、再 `rename` 原子替换。这一段期间 Node 主线程被占住，事件循环不转，HTTP 请求、SSE、定时器全部等它。
- 但**不能**从合成测试推断真实任务吞吐：真实状态里事件体量、字符串重复度、字段结构、磁盘缓存与杀软行为都不同；合成事件是高度可压缩的同构数据，`stringify` 成本偏乐观，而文件大小与实际业务事件未必对得上。
- 因此本文只支持一个结论：**在几十 MB 量级上，单次落盘已经是几百毫秒级的同步阻塞**，值得关注；不支持的结论是「生产环境每秒能写几次」「UI 会卡多久」。

## 现在不迁数据库

- 现有机制已经把这部分压力挡掉一层：mission 完成后进 archive，主状态文件只留 working 集；大输出走 artifact 而不是塞进状态。优先用这两条把状态文件压在可接受体积。
- 后续要不要动存储架构，看**实测的写频与 UI 延迟**：真实部署里 `flush()` 每分钟/每任务被触发几次、触发时前端请求与 SSE 的实测延迟是多少。这两项有了数，再决定是节流落盘、拆文件、还是换数据库。
- 本轮没有改持久化格式，没有引入数据库，也没有改任何生产路径的行为。

## 不做什么

- 不做生产压测，不拿它当容量结论。
- 不写回归测试（一次性基线脚本，不进入测试套件）。
- 不为了这个基线改动 `FileStateStore` 的接口或落盘策略。
