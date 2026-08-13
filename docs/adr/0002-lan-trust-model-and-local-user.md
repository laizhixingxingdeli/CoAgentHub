# ADR-0002:局域网信任模型与 Local User

**状态**:已接受(2026-08)

## 背景
产品定位局域网/自托管;上游账号体系已移除。需求:免 token 即可浏览群组。

## 决策
- `participantAuth` 中间件:**无 token → 回落 Local User**(type=human,全可见);**无效 token 仍 401**。
- 写操作仍要求成员资格(POST 消息/成员/task 等 403);token 仅用于"以某 participant 身份"发言/自管理。
- token 后端生成与保存(`scripts/.executor-agents.json`,gitignored),前端不展示。
- 本模型与 `/api/file`(无鉴权)一致:适用于可信局域网。

## 后果
- 无 token 的 Web 用户是 Local User,能看到全部;若要"以特定 participant 发言"需绑 token。
- 安全边界=局域网信任;公网部署需重审。
