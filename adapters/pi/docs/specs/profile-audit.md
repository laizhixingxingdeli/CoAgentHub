# 档案表上游对照审计

适配层的静态档案表（`src/profiles.ts` 的 PROFILES）会跟上游目录脱节。上游把 provider 整段改名时，模型 id 仍在，任务跑起来几秒就死、报「模型不可用」——症状像候选质量问题。

## 怎么跑

```
npx tsx src/cli.ts audit
```

不建 agent session、不调 `session.prompt`。可随便重复跑。

## 口径

- **存在性（是否过期）**：`runtime.getModels()` / `getModel(provider, id)`。`provider+model` 不在目录里才算过期。**不要**用 `getAvailable()` 判「不存在」——没配凭证会被误判成过期。
- **该改成什么**：`runtime.getAvailable()`，按 provider 分组打进报告。不要把 `getModels()` 的全量（一千多条）倒进人读报告。
- 若过期条目的 model id 在别的 provider 下还在，报告要单独标 `sameNameElsewhere`（历史：`bai/hy3` → `opencode-go/hy3`）。

## 输出

- 全部对得上：stDOUT 必须出现原文「都对得上」，并列出对上的条目；禁止空输出。退出码 0。
- 有过期：写明 profileId、表里的 provider/model、同名现在在哪、按 provider 分组的可用清单。退出码 1。

## 边界

- 对照逻辑在 `src/profile-audit.ts`（纯函数），CLI 只拉目录和打印。
- **不**改 `models` 的 JSON 形状（平台资源池协议），**不**改 doctor 的探活（仍可真发 prompt）。
- **不**自动改 PROFILES、**不**做自动更新：查出来之后改不改由人决定。

