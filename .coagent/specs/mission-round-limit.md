# Mission 单次运行轮次上限

`run-mission` 与 `run-plan` 均接受可选 `--max-rounds <1-100>`。不提供时，编排器沿用 12 轮缺省；提供时只允许十进制数字组成的 1–100 整数，缺值（包括紧跟另一 `--` 旗）、0、负数、小数、指数写法和超限值均报带旗名及范围的错误，在读取用户输入文件、预检、建平台和拿锁之前失败。

`run-mission` 将显式值与 projectRoot 一起交给 MissionRunner.run；`run-plan` 的位置参数扫描跳过该旗的值，并为本次每条 Mission 的 runner.run 选项保留原 projectRoot 等字段且追加显式 maxRounds。未给旗时均不覆盖编排器缺省。`run-plan --check` 多打印「轮次上限：N」，缺省时打印「轮次上限：12（缺省）」。两个 CLI 用法均列出该旗。

权威源：`src/application/mission-runner.ts` 的 `parseMaxRounds`、`src/run-mission.ts`、`src/run-plan.ts`。测试：`test/max-rounds.test.ts`、`test/run-mission-wiring.test.ts`、`test/run-plan-wiring.test.ts`。
