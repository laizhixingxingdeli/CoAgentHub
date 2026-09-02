# Spec: 协调者兼任执行——平台自动留痕

> **状态**: Landed — L3 通过(2026-09-02),实现 `2d735f45`
> **版本**: 1.0
> **相关**: [ADR-0009](../docs/adr/0009-judgments-must-name-the-fact.md)

## 1. 背景与用户定案

2026-09-02,CD 票(`fallback-cooldown-clobbers-parsed-recovery`)由协调者
**在协调任务会话里亲自实现并自判 L2 通过**,零子执行任务(提交 `f0182410`,
7 文件 +256/-56)。违反「协调者不得亲自实现」纪律。

**用户定案(2026-09-02):要留痕,就不限制了。**

- **不做 400 守卫。** 守卫挡的是行为,标记记的是事实。而「零子执行任务」
  这个客观事实绕不过去 —— 标记比守卫更难规避,也不会误伤合法场景。
- 代价由 L3 承担:见到该标记的票,L3 一律不采信 L2 的功能结论,逐条补核。

## 2. 现状:这个事实在界面上完全不可见

`deriveL1`(`requirement-layer-state.ts:139`):

```ts
status: reason ? "na-declared" : aggregateTaskStatuses(executionTasks.map(t => t.status))
```

零子执行任务时 `executionTasks = []`,而
`aggregateTaskStatuses([])` 返回 `"pending"`(`group-tasks-by-spec.ts:171`)。

⇒ **协调者亲自实现的票,L1 步永远停在 `pending`**,即使整张票已经 done。
界面表现:L1 空着、L2 直接过。看不出「没有执行者参与过」这件事,
也看不出「L2 是自审」。检视者只能靠人工查子任务数才能识别。

## 3. 要做的

### R1 新增 StepStatus:`coordinator-served`

`StepStatus` 联合类型加一个取值 —— **不复用 `na-declared`**。

判据(全部满足):

1. 该需求存在协调任务,且其终态携带 `review_request`;
2. `executionTasks.length === 0`;
3. `noExecutionReasonForTask(coordinationTask)` 为 null(**没有**声明豁免理由)。

⚠️ 条件 3 是分界线:声明了理由 → `na-declared`(合法豁免,既有路径);
没声明理由却零子任务 → `coordinator-served`(兼任事实)。
**两条通道互斥,`coordinator-served` 不得占用豁免通道。**

### R2 展示

- L1 步:复用 `na-declared` 的**展示形态**(灰底描边,`RequirementStepper.tsx:31/41`
  与 `status-classes.ts:14` 各加一条同款样式),文案 **「由协调者兼任」**;
- L2 结论旁标 **「自审」** 角标;
- 二者都是纯渲染,无新增交互。

### R3 历史票自动享受

判据全部从现有数据推导(任务列表 + review_request 载荷),**无迁移、无写库、
无 API 改动**。历史票刷新即显示。

## 4. 硬验收

1. **CD 票(`01a05ddc-a8d8`)显示 `coordinator-served` + L2 旁标「自审」。**
   拿真实数据验,不构造。
2. **有子执行任务的正常票渲染逐字不变**(回归,必测)——
   `deriveL1` 的 `aggregateTaskStatuses` 分支不得被触碰。
3. **`na-declared` 豁免声明路径逐字不变**(回归,必测)。
   已有用例 `group-tasks-by-spec.test.ts:657`
   (`["na-declared","done","pending"]`)必须原样通过,不得修改。
4. **零子任务但已声明豁免理由 → 仍为 `na-declared`**,不被新判据抢走。必测。
5. 零子任务、但协调任务终态**不带** `review_request` → 不打标记
   (还没走到该判定的时点,不能提前定性)。必测。

## 5. 不涉及

- 不做 400 守卫,不拦截任何下发。
- 不改后端、不改 API、不写库、不做数据迁移。
- 不改 L3 档位推导(`deriveL3`)与 `na-no-reviewer` 语义。
- 不追溯处理已发生的 CD 事故(已由 L3 完整档补核收口)。
