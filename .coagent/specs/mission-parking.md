# Mission 挂起与续跑

检视者决定等待用户时使用 Mission 级命令 `node src/l3.ts park <missionId> --reason "…" --as <检视者>`；用户答复后使用 `node src/l3.ts resume <missionId> [--answer "…"] --reason "…" --as <检视者>`。有常驻写者时沿主状态写命令回环转发规则交其处理，无常驻服务时使用独立持锁写者。带理由和身份的续跑走已挂起 Mission 专用路径；旧无参 `resume` 的普通暂停恢复语义不变。`rerun_isolated`、`skip`、`rescope`、`stop`、`answer` 等已有方案决定不变；方案没有 park/resume 决定动作。

park 前，仅用已验收工作项的显式授权路径将未提交成果检查点提交到原 Mission 分支；无已验收项时须确认隔离工作树洁净，拒绝未授权脏树。成功挂起持久保存原因、已验收工作项与原 Mission 分支/提交；Mission 不终结、不会删除提交。挂起 Mission 不占项目改动名额；普通 pause 仍占位，任何时刻最多一个 Mission 在改代码。开跑前预检与 run-plan --check 以此规则判定名额。已挂起的未答复升级投影为等待用户，不因截止而过期、不计入 unresolvedEscalations。

活动方案运行以 Mission 状态为权威，仅投影该票已挂起并继续运行不依赖它的后票；依赖挂起票的不开。resume 时先确认可重新领取改动名额，再将最新集成分支目标提交合入原 Mission 工作树、记录新分叉基线，之后用同一 Mission 继续调度；既有 accepted 工作项与历史不重派。可选 answer 沿已有升级答复语义交协调者；无效答复在触碰 Git 前拒绝。有活动方案则复用原 feature/Mission 接着驱动，方案停时由下一次 run-mission 或开跑恢复。

同步冲突不 reset、abort 或删除任一方提交；未合并 index 保留，平台记录冲突文件，协调者唤醒指令列明文件并要求创建工作项解决。冲突出现前派发的旧项由持久屏障暂缓，之后创建的解决项可执行；Git index 无冲突后移除屏障并恢复正常调度。冲突解决不了走既有失败路径。

关键验证只涵盖 park 后名额释放下一票开跑、resume 同 Mission 保留验收工作项、集成目标有新提交时先同步三场景；交卷必须在独立 Mission worktree 全量 `node --test` 零失败（仅 HAOFF1 既有七项跳过）。源：`src/kernel/mission.ts`、`src/application/platform.ts`、`src/application/workspace.ts`、`src/application/plan-run.ts`、`src/application/plan-driver.ts`、`src/application/orchestrator.ts`、`src/application/plan-preflight.ts`、`src/l3.ts`、`src/api/server.ts`；验证：`test/platform.test.ts`、`test/plan-driver.test.ts`、`test/orchestrator.test.ts`、`test/l3-plan.test.ts`。
