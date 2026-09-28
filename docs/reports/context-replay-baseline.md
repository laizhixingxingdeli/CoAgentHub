# Offline Attempt usage baseline

This report is a reproducible method, not a claim of historical measurements. No real state snapshot was supplied with this work item; therefore no E1 or main measurements are reported here.

Run against an explicitly selected version:1 state JSON:

```sh
node scripts/context-replay-report.mjs --input <sourceLabel> <state.json> --report <report.json>
```

The tool reads only `projects[].missions[].coordinatorAttempts[]` and `projects[].missions[].workItems[].attempts[]` from explicit version:1 snapshots. Accepted source labels are E1 and main. Rows are isolated by source label, Mission id and role; inputs are never merged or deduplicated. Each output row contains only sourceLabel, missionId, role, attemptsTotal, usageReportedCount, usageUnknownCount and the `input`, `output`, `cacheRead`, and `cacheWrite` subtotals. Subtotals are **已报告用量的分项合计**; invalid or non-reported usage contributes only to unknown count.

Actual source labels and per-source included counts: none (no real snapshot supplied). Synthetic test fixtures are not historical measurements.

- Prompt replay volume: 未知／本票未测
- Removable context volume: 未知／本票未测
- Per-hop trends: 未知／本票未测
- Cross-source coverage: 未知／本票未测

`cacheRead` means cached-read tokens only. It is not prompt replay volume or removable context volume.
