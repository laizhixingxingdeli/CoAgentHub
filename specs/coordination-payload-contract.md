# Spec: 协作载荷从散文契约变成代码契约

> **状态**: Landed — L2 + L3 均通过(2026-08-23)
> **版本**: 1.0
> **日期**: 2026-08-23
> **上游**: `specs/reviewer-role-spec-generation.md` v3.9 §3.10 / §3.18
> **前置**: `specs/task-execution-context.md`(协调者得先能调 API)

## 背景:三个实例,三种结构

spec §3.10 用 JSON 示例描述四种协作载荷(`spec_published` / `spec_amended` /
`review_request` / `review_result`)。**这些示例是 Markdown 散文,没有任何校验。**

协调者配置 `memory: null`,每票冷启动,对同一段散文各自发挥。实测后果——
同一轮里三个 codex 实例产出了**三种不同结构**的 `review_request`:

| 来源 | 结构 |
|---|---|
| DSH 群 | `diffSummary` 顶层直接是 `{type:"review_request", layer:3, taskId, ...}` |
| CoAgentHub 群 | 嵌套在 `diffSummary.review_request` 下,**带** `type` |
| Codex 插件群 | 嵌套在 `diffSummary.review_request` 下,**不带** `type`(用 `verdict` 代替) |

检视者侧的解析器**改了两次仍漏第三种**——三条真实的 L3 请求只认出一条,
另两条是人工核对时才发现的。

**这类问题无法靠不断打补丁追上。** 根子是契约在散文里,不在代码里。

## 判断原则

**平台提供构造与校验,协调者不再"按文档拼 JSON"。**

按 v3.9 §3.18,协调者不走插件、直接调 HTTP API。所以正确落点就是平台的 API 边界:
PATCH 任务时校验载荷形状,校验通过才落库。

---

## 要求

### R1. 定义载荷 schema(单一事实源)

- 用 zod 定义四种载荷的 schema:`spec_published` / `spec_amended` /
  `review_request` / `review_result`
- 字段依据 spec §3.10 的现有示例,**不要自创新字段**;
  §3.10 示例之间不一致或缺字段时,**在汇报里指出**,不要自行发挥
- schema 放在共享位置(供路由校验与将来的前端类型共用),**只此一份**

### R2. PATCH 任务时校验 `review_request`

`PATCH /api/groups/:groupId/tasks/:taskId` 的 `diffSummary` 若含 `review_request`:

- 按 schema 校验形状
- **同时接受两种位置**:顶层(`diffSummary.type === "review_request"`)与
  嵌套(`diffSummary.review_request`)。实测两种都出现过,拒绝其中一种会打断在途流程
- **归一化后落库**:无论传入哪种形状,存成**同一种规范形状**,
  让消费方只需处理一种。规范形状选哪个自行判断并说明理由
- 校验不通过:**报错,不要静默接受**(这正是 `no-silent-degradation` 那票的原则),
  错误信息要说清缺了什么字段、期望什么形状——协调者是 LLM,错误信息就是它的修复指引

### R3. 群消息载荷同样校验

`spec_published` / `spec_amended` / `review_result` 走群消息
(`POST /api/groups/:id/messages`,`contentType: application/json`)。

- body 能解析成 JSON 且含 `type` 字段命中四种之一时,按对应 schema 校验
- **解析不出 JSON、或 `type` 不认识 → 放行**,不做任何处理
  (群消息是自由文本通道,不能因为不认识就拒收)
- 校验不通过(`type` 认识但形状不对)→ 报错

### R4. 提供构造帮助,而不只是拦截

只校验不给正路,协调者仍要靠猜。

- 让协调者能拿到载荷的期望形状。具体方式自行设计并说明,可选方向:
  新增一个只读端点返回 schema 描述;或把形状写进任务书的执行上下文段
  (`task-execution-context` 那票已经在往任务书里放东西了);
  或校验失败时的错误信息本身就带完整示例
- **不要**新建一个"构造载荷"的写端点——那会变成又一个协调者专用工具,
  与 v3.9 §3.18 的方向相反

---

## 验收标准

- [ ] 四种载荷有 zod schema,单一事实源,字段依据 §3.10
- [ ] §3.10 示例本身的不一致/缺字段已在汇报中指出
- [ ] PATCH 时 `review_request` 顶层与嵌套两种位置都接受
- [ ] 落库后是统一的规范形状,规范形状的选择理由已说明
- [ ] 载荷形状不对时报错,错误信息说清缺什么、期望什么
- [ ] 群消息:认识的 `type` 校验,不认识的/非 JSON 的放行
- [ ] 协调者有办法拿到期望形状(方式已说明)
- [ ] **未新增协调者专用写端点**
- [ ] 新增测试覆盖:两种位置的 review_request、归一化结果、形状错误报错、
      非 JSON 群消息放行、未知 type 放行
- [ ] `pnpm --filter server test` 全绿(先跑一次确认基线,不得减少)

## 不涉及

- **不改**前端
- **不改** spec §3.10 的字段定义本身(本票是把它变成代码,不是重新设计)
- **不改**插件(任何仓)
- **不做**历史数据迁移——已落库的三种形状保持原样,消费方仍需兼容一段时间
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端以 `pnpm --filter server start`(无 watch)运行中:改完需手动 build + restart
- ⚠️ 本票会改 PATCH 路径,而**协调者正在用这条路径回写终态**。
  改动务必向后兼容:在途任务用旧形状 PATCH 必须仍能成功
- 沙箱执行器注意:需监听本地端口的测试会报 `listen EPERM`,那是环境限制不是回归


---

## L3 检视记录(2026-08-23)

**verdict: pass**，commit `6cfc84e`。L2 由协调者完成，检视者复核采纳：`tasks.ts:349` 对顶层 `type === "review_request"` 与嵌套 `review_request` 两种位置都接受并归一化，形状错误时抛 `InvalidRequest` 且错误信息附期望示例（`REVIEW_REQUEST_EXAMPLE`）——符合「错误信息就是 LLM 的修复指引」这一要求。

本轮协调者的 PATCH 正是经此路径成功落库，算是自证。
