# coagenthub-v5

> 本文件由 CoAgentHub 生成，**不要手工编辑** —— 改动会在下次生成时丢失。
> 内容来自 `.coagent/`，跟代码同一个版本。

## 架构约束

**不可协商**的东西。每一条都会原样传给协调者和执行者。

## 分层

- `src/kernel/` 不 import 任何东西（连 `node:` 都不），也不出现
  provider / model / session / http / fetch / sql / database 这些词。
  理由：接第二个 agent 时不用改内核。
- 第三方依赖**只允许**出现在 `src/application/pg-store.ts`。
  别处一律零依赖——文件版存储守着"clone 下来什么都不装就能跑通全部测试"。
- 规则写在用例层，不写在 prompt 里。**能用工具层挡住的，就不要指望模型记得住。**

## 前端

- **不引入构建步骤**，不引入前端框架。浏览器原生 ES module 直接跑。
- 前端是纯客户端，只走 `/api/*`；不得直接碰存储或领域对象。
- 改主意的判据：需要虚拟滚动/拖拽/富文本这类复杂组件，或页面数超过 8。
  在那之前，"换成 React 会更好写"不是理由。

## 通用

- 相对 import 必须带 `.ts` 后缀（Node 原生类型剥离的要求）。
- 不用 `enum`，不用 constructor parameter properties（同上）。
- 「已修复 / 已完成」必须有可验证证据；没跑过的命令不要写成跑过。
- 注释写**为什么**，不写代码在做什么。特别是写清楚"不这么做会怎样"。

## Capability 索引

- **web-shell** — 正式 Web 端外壳、项目页与任务详情
  无构建的浏览器原生 ES module，由 `src/api/static.ts` 按扁平文件名吐出（见 ADR-0001）。

## 架构决策

- **adr-0001-web-not-split** — Web 端不做前后端分离，也不引入构建
- **adr-0002-decision-provider-boundary** — Decision Engine 是横向信号能力，不是第四层

## 给 Agent 的规则

- 实现只是把既有行为修回来 → **不要**动 Living Spec。
- 新增或改变了可观察行为 → 更新对应 Capability 的 Living Spec。
- 跨 Mission 的长期技术取舍 → 写一份 ADR，说清楚为什么这么选。
- 「已修复 / 已完成」必须有可验证证据；没跑过的命令不要写成跑过。
