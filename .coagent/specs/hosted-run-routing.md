# 常驻持锁服务编排入口与 CLI 回环转发

文件存储下，`run-mission` 与 `run-plan` 保留原有命令前缀。正式运行在输入和环境前置校验、方案资格筛选/仓库预检之后探测同一 statePath 写者：经身份验证的 live 服务由回环 HTTP 启动，并在同一服务的 Platform、API baseUrl、issuer/token registry、候选池、持久队列及工作区执行；确认 empty 才使用原有独立平台、排他主锁及临时 API。occupied、身份/版本/statePath 不符、未知网络故障或在争锁后无法核实服务均明确失败，不回退、不盲重试；对于已确认的残锁，仅排他主状态锁入口在旧进程已死亡、最后心跳超过两分钟且旧端口无人监听三条件同时成立时可安全接管，条件不明仍拒绝。PG 保持既有单实例边界，不承诺跨主机独占。服务校验请求 state 与实际持锁 statePath 一致，缺失或不一致在新建 Mission、候选 seed、PlanRun 前拒绝。

`run-plan --check` 在锁探测、状态创建及写请求之前只读返回。正式方案运行首次筛选/预检在 CLI、第二次预检及改动名额校验在服务持有者；服务复用 `runPlanOnPlatform`、独立 FilePlanRunStore 和原有两道闸、HAOFF1 路由、机器终审。升级/HA 决定使用 PlanRun 文件短锁，等待期间服务仍受理普通 HTTP 写及经服务转发的 L3 主状态命令。无服务旧 CLI 仍独立运行。两种 hosted 入口保留已有 flags（含角色、max-rounds、worktrees、adapter、run-dir、store、in-place、accept-stale-base）：无法在服务工作区/平台兑现者在写入前明确非零拒绝，不静默忽略。无法证明 CLI 进程声明的额外 agent 环境透传值与服务相同者也在 POST 前拒绝，不输出凭据值或让服务 env 顶替。

服务通过带 API 版本、instanceId、stateId 身份头的回环 NDJSON 流发送 stdout/stderr 行和唯一终态 exitCode；客户端核实身份后边收边原样打印，保持 run-plan 原有开跑、时间戳功能、升级、答复、合入、agent 工具调用、交接面与停止日志格式。服务长时间等待升级时发不进入 CLI stdout 的空闲心跳，客户端不受默认 socket idle timeout 截断；真实断线、缺终态、身份漂移或显式请求超时仍非零失败，不自动重启已接受的 PlanRun 或重做终审。关闭服务先拒绝新 hosted run、等待已接收的 Mission/PlanRun 和 HTTP 写请求，再停止周期 tick、持久化、关闭监听并释放锁；CLI 断开不会取消服务已接受的 job。

第一次 SIGINT 立即输出已接收的 PlanRun/Mission 真实 id、可取得的当前状态以及升级单 id/截止与完整 `node src/l3.ts plan decide <E-n> --action stop --reason "服务退出" --run "<记录路径>" --as "<检视者>"` 命令；缺少可信字段时明确无法提供命令，不伪造。开始拒绝新 hosted run，等在途正常排空。再次 SIGINT 不强杀，暂停在途 Mission 并持久化，让 PlanRun 以 `service_shutdown` 停止、运行中功能挂起，驱动不得继续建单或合入；沿原排空→周期停止→持久化→关闭 HTTP→释锁路径结束，并保持非零退出码。安全停靠与释放锁之间有最后关锁门禁：二次请求即使在周期停止/持久化期间才到也须等待；停靠失败报告错误，HTTP 和主锁保留，不能谎称安全退出。普通关闭的停止错误仍按原行为关闭 HTTP。文件主锁占用时报持有者 pid、实例、端口、起始时间、心跳与进程活性核验及完整人工核实、清锁命令；不自动抢占活进程、心跳未过期、端口监听或心跳未知的锁。持有者在持锁期间约每 30 秒更新锁心跳，正常退出释放锁；仅三条件确认的死锁可由常驻及无服务独立写者接管，接管写可查询的审计记录（旧 pid/实例、最后心跳、新持有者与时间），独立 PlanRun 记录短锁不属于此接管入口。

文件模式下，两个 CLI 在开跑信息后标注运行方式：验证本机服务后转发时打印「由常驻服务托管：实例 <instanceId 前 8 位>、端口 <端口>」，无服务且本进程持文件主锁时打印「无常驻服务，独立运行（本进程持主锁）」。PG 不做文件写者探测、不转发、不持文件主锁，独立开跑后打印「PG 存储：独立运行（不经常驻服务转发，不持文件主锁）」。不以提示改变写者路由或 fail-closed 规则。

源：`src/run-mission.ts`、`src/run-plan.ts`、`src/main.ts`、`src/application/mission-runner.ts`、`src/application/plan-runtime.ts`、`src/application/loopback-control-client.ts`、`src/application/lock.ts`、`src/api/server.ts`。验证：`test/start-server.test.ts`、`test/run-mission-wiring.test.ts`、`test/run-plan-wiring.test.ts`、`test/l3-plan.test.ts`、`test/api.test.ts`、`test/post-execution-shadow.test.ts`。方案本身的筛选/决定/停止语义继续由 `plan-run` capability 定义；L3 主状态命令语义由 `l3-main-writer-routing` 定义。
