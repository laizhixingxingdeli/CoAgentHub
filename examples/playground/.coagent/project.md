# playground

## Purpose

CoAgentHub 的练习项目：几个处理数组的纯函数。用来第一次跑通“检视者 → 协调者 → 执行者”整条链，任务小、花费低。

## 执行者红线

执行者只会读到这一节（标题必须就叫“执行者红线”）。

- 只用 Node 内置模块，不装任何依赖，不创建 node_modules。
- 相对 import 必须带 `.ts` 后缀（Node 原生类型剥离的要求）；不用 `enum`。
- 测试用 `node --test`，写 `node:test` 和 `node:assert/strict`；不要用 npm / npx。
- 只改工单允许范围内的文件；不碰 `.coagent/`。

## 约定

- 验证命令写成 argv，不要套 bash / sh / cmd / powershell：`["node", "--test"]`。
- 源码在 `src/`，测试在 `test/`，测试文件命名 `test/<名字>.test.ts`。
