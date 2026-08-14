# ADR-0002:局域网信任模型与 Local User

**状态**:已接受(2026-08,随 token 认证移除更新)

## 背景
产品定位局域网/自托管;上游账号体系已移除。需求:免绑定即可浏览群组。

## 决策
- 身份声明取代认证(全信模型):请求带 `X-Participant-Id: <uuid>` → 该 id 存在则以其身份
  处理;**缺失或 id 不存在 → 回落 Local User**(type=human,全可见),不报错。
- **token 认证已移除**:不再生成/校验 token,无 401/403;`POST /:id/reset-token` 端点与
  `lib/participant-token.ts` 已删除。`token_hash` 列保留(方案 B 再删),新行插占位空串。
- WS(`/api/ws`)握手用 `?participantId=` 声明身份,同规则(缺失/未知 → Local User)。
- 写操作仍要求成员资格(POST 消息/成员/task 等 403);身份仅用于「以某 participant 身份」
  发言/自管理(全信下任何声称身份都可管理任意注册信息)。
- 本模型与 `/api/file`(无鉴权)一致:适用于可信局域网。

## 后果
- 无身份声明的 Web 用户是 Local User,能看到全部;若要「以特定 participant 发言」,
  在身份面板选择或输入 participant id 即可(声称即生效,冒名无害)。
- 安全边界=局域网信任;公网部署需重审。
