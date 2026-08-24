# Spec: 移除前端的「绑定身份」机制

> **状态**: Landed — L3 通过(2026-08-24),实现 `fe497d3 + f6dc7b2(fix)`
> **版本**: 1.0
> **日期**: 2026-08-23

## 背景:一个自己都不校验的本地字符串

清库重建后,界面左下角仍显示身份 `01a024ae-80b5-719b-97...` ——**这个 participant 在库里已经不存在**(清库前那批旧数据的残留)。前端把它存在 localStorage 里,**从不向服务端校验**,于是所有请求都带着一个幽灵 id,界面上没有任何提示。

`lib/stores/identity.ts` 的 `readStoredParticipantId()` 只读 localStorage,没有任何失效检测。

### 后端本来就不需要它

`middleware/participant-identity.ts` 是**全信 + 宽容**模型:

```
缺失 / 非 uuid   → 回落 Local User,不报错
uuid 但不存在    → 回落 Local User,不报错
```

实测:带一个纯属虚构的 uuid 请求 `GET /api/groups` 返回 **200**。

**也就是说服务端从不依赖这个头做鉴权**,前端维护它没有换来任何东西。

### 移除后可见性不降反升

`routes/group/messages.ts` 的可见性注释写明:

> The default Local User counts as **human (sees everything)**  
> Any other non-member sees broadcast + own.

所以去掉身份绑定后,前端一律以 Local User 身份访问 → **看得到全部消息**;而绑定成某个非成员 participant 时,反而只看得到 broadcast + 自己的。**对本地管理界面来说,移除才是正确行为。**

---

## 要求

### R1. 移除身份绑定的全部实现

涉及(非测试)13 个文件:

```
lib/stores/identity.ts                 identity store 本体
lib/api-client.ts                      participantIdentityHeaders / PARTICIPANT_ID_KEY 转出
hooks/use-identity-panel.ts            切换器面板逻辑
hooks/use-group-header.ts
hooks/use-group-ws.ts                  WS 连接的 ?participantId=
hooks/use-groups-page.ts
hooks/use-messages-page.ts
hooks/use-unread.ts
components/sidebar/conversations.tsx
components/layout/context-panel/requirement-workspace.tsx
pages/app/groups/index.tsx
pages/app/groups/members.tsx
pages/app/participants/index.tsx
```

- 移除左下角身份切换器 UI
- 移除 `PARTICIPANT_ID_KEY` 的 localStorage 读写
- 移除请求头 `X-Participant-Id` 的注入
- 相应删除 `lib/stores/identity.test.ts`、`components/sidebar/identity-switcher.test.tsx`,
  其余测试文件按需调整

### R2. 逐个确认「读」与「写」两类用途

`X-Participant-Id` 在前端承担了两种不同语义,**不能一刀切**:

| 类别 | 例子 | 移除后 |
|---|---|---|
| **读取类** | 拉消息/任务/未读 | 以 Local User 身份读,**看得更多**,无损失 |
| **写入类** | 建群、加成员、改分工、发消息 | 服务端会把作者记成 **Local User** |

- 写入类要**逐处确认落成 Local User 是可接受的**。若某处必须以特定 participant 身份写入
  (例如以某执行器身份发言),**不要自行保留身份机制**——写进汇报,由检视者另行判断
- ⚠️ 特别注意 `pages/app/participants/index.tsx`:接入参与方页面自身也用了身份头,
  但它的作用是「以该 participant 的身份上报自己的能力」,与本机用户身份是两回事,
  **确认清楚再动**

### R3. WS 连接

`hooks/use-group-ws.ts:174` 用 `localStorage` 里的 id 拼 `?participantId=`。
服务端 WS 扇出按 `visibleMemberIds` 判定可见性——**移除后要确认前端仍能收到应有的实时事件**,
不能因为不带 id 而收不到任何推送。若确实需要一个 id,用服务端提供的 Local User id,
**不要退回 localStorage 方案**。

### R4. 不改后端

- **不改** `middleware/participant-identity.ts` 的宽容回落逻辑
- **不改**消息可见性规则
- 后端继续接受 `X-Participant-Id`(CLI / 插件 / 脚本仍在用),**只是前端不再发送**

---

## 验收标准

- [ ] 左下角身份切换器已移除
- [ ] 全仓(前端非测试代码)无 `PARTICIPANT_ID_KEY` / `useIdentityStore` 引用
- [ ] 前端请求不再携带 `X-Participant-Id`
- [ ] 清空 localStorage 后界面行为一致(无幽灵身份、无报错)
- [ ] **读取类**功能正常:群列表 / 消息 / 任务 / 未读均可见
- [ ] **写入类**功能正常:建群 / 加成员 / 改分工 / 发消息,作者落为 Local User
- [ ] 若有任何写入路径不适合落成 Local User,已在汇报中列出(未自行保留身份机制)
- [ ] WS 实时事件仍能收到(方案已在汇报中说明)
- [ ] 接入参与方页面的能力上报仍正常(R2 的特别注意项已确认)
- [ ] **未改动后端任何文件**
- [ ] `pnpm --filter @laizhixingxingdeli/web test` 全绿,用例数变化已说明(删测试会减少,需列出删了哪些)
- [ ] `pnpm --filter @laizhixingxingdeli/web build` 通过

## 不涉及

- **不改**后端(见 R4)
- **不改** CLI / 插件对 `X-Participant-Id` 的使用
- **不做**替代性的身份机制(不引入登录、session、用户选择器)
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 前端实测:`http://localhost:5173`
  —— **改完请在浏览器清空 localStorage 后肉眼确认**:左下角无身份切换器、
  群列表/侧栏/群详情均正常显示、建群与加成员可用。这是本票真正的验收信号
- 后端在 `:3001` 运行中,**本票无需重启后端**
