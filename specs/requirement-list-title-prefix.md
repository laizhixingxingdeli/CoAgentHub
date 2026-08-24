# Spec: 左栏 24 条标题前 5 个字全一样

> **状态**: Landed — L3 通过(2026-08-24),实现 `9de1f645`
> **版本**: 1.0
> **日期**: 2026-08-24

## 现象

需求列表里 24 条,几乎每条都以「**协调任务:**」开头:

```
协调任务:侧栏编制标识不再借用检视者角色徽章
协调任务:需求列表与详情订阅 task_status_c…
协调任务:顶部控制条下沉到任务卡片
协调任务:阶梯进度条单位统一为层
协调任务:群设置改为抽屉(v1.1 返工)
```

**真正区分它们的信息被公共前缀挤到后面,长的还会被截断。** 列宽本就有限,
前 5 个字全部浪费。

## 根因:标题优先取任务书首行,`specRef` 只是兜底

`group-tasks-by-spec.ts:209` 的 `deriveLabel`:

```ts
const briefTitle = titleSource.map(t => deriveBriefTitle(t.brief)).find(...)
if (briefTitle) return briefTitle;     // ← 命中就返回
// specRef 兜底在后面
```

而任务书首行是检视者写的「# 协调任务:xxx」样板 —— **它是给协调者读的指令标题,
不是这条需求的名字**。

该文件自己的注释其实写对了方向:

> 有 specRef → 从 specRef 提取文件名去掉扩展名(**更稳定的可读标题**)

但实现把它排在了 brief 之后。

## 决策:`specRef` 优先,brief 兜底

调换优先级 —— 有 `specRef` 就用它派生标题,没有才回落 brief 首行。

理由:

- `specRef` 是这条需求的**稳定身份**(`specs/requirement-stepper-semantics.md`
  → `requirement-stepper-semantics`),不随任务书措辞变化
- brief 首行是**下发者当时的措辞**,会因重发、返工、修复票而变
- 同一条需求的多次下发(重发、修正票)brief 各不相同,但 `specRef` 一致 ——
  用 specRef 才能让它们在列表里显示为同一件事

## 要求

### R1. 有 `specRef` 时优先用它派生标题

沿用现有的 `specRef` → 文件名去扩展名逻辑(**已实现,只是排在后面**),
把它提到 brief 之前。

### R2. 无 `specRef` 时回落 brief 首行,行为不变

指令驱动任务、历史数据没有 `specRef`,**保持现状**:brief 首行 → 任务 id 兜底。

### R3. 不改分组算法

`group-tasks-by-spec` 的**分组规则**(按 specRef 聚合、parentTaskId 归并)
**完全不动**,本票只改 `deriveLabel` 的取值优先级。

### R4. 不改后端、不改任务书模板

检视者写「# 协调任务:xxx」是给协调者读的,**保持不变** ——
问题不在任务书,在列表用错了字段。

## 验收标准

- [ ] 有 `specRef` 的需求,列表标题为 specRef 派生名
      (如 `requirement-stepper-semantics`),**不再以「协调任务:」开头**
- [ ] 无 `specRef` 的需求,标题**与改动前一致**(回归,必测)
- [ ] 同一 `specRef` 的多次下发(重发/修正票)显示为**同一个标题**
- [ ] 分组算法未改动(`group-tasks-by-spec.test.ts` 既有用例全绿)
- [ ] 标题超长时的截断行为保持
- [ ] 前端测试全绿,贴出用例数
- [ ] **未改动**后端与任务书模板

## 不涉及

- 分组算法(R3)
- 任务书模板措辞(R4)
- 详情页布局(另票)

## 执行环境提示

- 前端 `http://localhost:5173`,群 `01a02f0f-21c3-71a3-979b-268f5d89ac18`
  左栏可直接看到 24 条同前缀标题
- 实现位置:`group-tasks-by-spec.ts` 的 `deriveLabel`(约 209 行)
