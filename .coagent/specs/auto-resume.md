# 服务自动续跑

常驻服务的 RetryWakeScheduler 扫描 Mission.waitResumeAt 已到、且 isAutoResumable 为真的等待，复用 mission.run_requested 里的托管启动参数续跑。入过 Mission 队列的仍归队列 worker。COAGENT_AUTO_RESUME=0 整体关闭。同一 Mission 不得有两个同时在跑的托管运行；有节流与并发上限。续跑前写 mission.auto_resumed（原因、恢复时刻、第几次）。不绕过暂停、挂起、未答复升级、费用上限、检查点、取消、目标变更与基线过期。

能自己消失或交给协调者处理的停机不再等人：执行者死信（attempt_limit_reached）与执行者打转（runaway_suspected）写入恢复时刻；续跑前 prepareAutoResume 把仍 dispatched 的执行者工作项收成 blocked，并写 mission.coordinator_handoff（原因、次数、候选、工作项）。编排器这一跳的返回原因不变。协调者打转自动重试一次，连续第二次不再续跑。额度失败有别的可用候选仍换候选；都不可用且有已知重置时刻时写 waitResumeAt、返回 no_available_agent，不进死信。platform_unreachable 按约 1、5、15 分钟退避，连续第 4 次起不写恢复时刻。project_busy 在同项目改动名额释放后自动续派；派发拒绝写明不用升级。

用 start_mission 托管启动过的 Mission，在 L3 答复升级、修订契约、追加预算、批准检查点或恢复工作项之后，由 requestHostedContinuation 记下续跑请求，仍受上述门禁约束，不重复启动。

源：src/application/platform/auto-resume.ts、src/application/retry-wake.ts、src/application/orchestrator.ts、src/main.ts。验证：test/auto-resume-policy.test.ts、test/retry-wake.test.ts、test/orchestrator.test.ts、test/resume-redispatch-brief.test.ts。