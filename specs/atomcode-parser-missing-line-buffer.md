# Spec: atomcode 分支缺行缓冲,45.5% 的实时输出是词中间碎片

> **状态**: Frozen — 待实现
> **版本**: 1.0
> **日期**: 2026-08-27

## 现象

`output-parser.ts` 的 `createAtomCodeParser`(约 340-346 行)直接
`chunk.split("\n")` 后逐行渲染,**没有行缓冲**:

```ts
const parser = ((chunk: string): OutputEntry[] => {
  const text = splitMidLinePrefixes(chunk ?? "");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  ...
  return lines.map((l) => renderAtomCodeLine(l, entry, raw));
});
```

而 codex 分支(`let pending` 约 291 行)与通用解析器(约 542 行)**都有** `pending`
行缓冲。流式 chunk 常在词中间切开,atomcode 于是把半截直接当成一条完整条目。

实测运行中的 AtomCode 任务 `01a041d8`:

```
总行 1000,长度 <=8 的碎片 455 行,占 45.5%
样例 'Coord' / 'inatorTask' / 'embers.' / "task'" / '-res' / 'ume.ts' / 'The'
中文亦被切开:'"存在' / '非' / '" 口径 —'
```

## ⚠️ 危害不止可读性

每个碎片都分配了独立 `#id` 并落盘明细。实测展开 `#t2661` 取回的原文
**只有 3 个字符(`And`)**。后果:

- `#id` 序号被污染,一次任务轻易冲到 `#t29024`
- 明细 JSONL 塞满无意义条目
- 碎片挤占摘要流的行数上限,顶掉真动作行

## ⚠️ 这是修好过又复发的缺陷

`a3fc61c3`(「输出缓冲仅以真实换行边界构成行,消除词中间碎片」)修的就是这个,
当时的修复在 **output-buffer 层**。`a6ed2759` 把成行职责移到了**解析器层**,
codex 与通用解析器都跟着补了 `pending`,**atomcode 分支漏了**。

## 要做的

### R1 — 为 `createAtomCodeParser` 补 `pending` 行缓冲

与 codex / 通用解析器**同构**:未以换行结尾的尾段留在 `pending`,
与下一个 chunk 拼接后再按 `\n` 切分。

### R2 — `flush()` 吐出残留

进程结束时把 `pending` 中未成行的残留逐字吐出(R3 硬要求:不得丢弃)。

### R3 — ⚠️ 不得使用长度阈值之类的启发式

按换行边界拼接即可。阈值会在长动作行上误合并 —— 这与 `a3fc61c3` 的结论一致,
不要重新发明。

### R4 — ⚠️ 不得改动其他分支

`createCodexParser` / `createCodeBuddyParser` / `createGenericParser`
及其既有用例一律不动。

### R5 — `splitMidLinePrefixes` 与行缓冲的先后顺序需明确

现有 `splitMidLinePrefixes` 用于把粘连在行中的已知前缀拆到行首。
⚠️ 补行缓冲后需确认二者顺序不会互相破坏(例如前缀被 chunk 边界切开的情形),
并在汇报中说明所选顺序与依据。

## 验收要点

- ⚠️ **必须以真实 AtomCode 任务实跑采样为准** ——
  单测通过不能替代(本轮正是 751 全绿而实跑 45.5% 碎片)
- 采样中碎片行(长度 <=8)占比 **< 5%**(当前 45.5%)
- 随机展开若干 `#id`,取回的原文长度合理,**不再出现 3 字符条目**
- 跨 chunk 半截行拼接后只渲染一次,有单测覆盖
- 进程结束 flush 吐出残留且逐字保留,有单测覆盖(R2)
- codex / codebuddy / 通用解析器既有单测**一字未改**且全通过(R4)
- 汇报说明 `splitMidLinePrefixes` 与行缓冲的顺序及依据(R5)
- 测试全绿,贴出用例数

## 注意

⚠️ 本票**必须下发给执行器**完成,**不限定是哪一个**。
⚠️ 票中的 `atomcode` / `codex` / `codebuddy` 是**代码里的 executorKey 字符串常量**,
   与派给谁无关。
⚠️ specHash 不是 commit,汇报时不要混用。
⚠️ 提交前先 `git status` 确认工作树,不要把无关的暂存文件一并提交。
⚠️ 结案若被守卫拒绝,如实回报原文,**不要自行重启后端,也不要以 failed 收场**。
⚠️ 做完记得提交。
