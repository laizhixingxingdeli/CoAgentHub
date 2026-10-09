/**
 * src/profile-audit.ts 的测试：node:test + tsx，无新增依赖。
 *
 * 跑法：npx tsx --test src/profile-audit.spec.ts
 *
 * 重点锁三件事：
 *  1. 全对 → ok，文本必须含原文「都对得上」且非空；
 *  2. provider 整段改名（历史场景 bai → opencode-go）→ 点名是哪条档案、
 *     表里写的是什么、同名现在在哪个 provider；
 *  3. 判定口径是"目录里有没有这个 provider+model"，**不是**"有没有凭证"。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	auditProfiles,
	formatAuditReport,
	type AuditProfileEntry,
	type CatalogEntry,
} from "./profile-audit.js";

/** 当前档案表（r2）的四条，provider 都已经改成 opencode-go。 */
const CURRENT_PROFILES: AuditProfileEntry[] = [
	{ profileId: "coordinator-grok", provider: "xai", model: "grok-4.6" },
	{ profileId: "exec-qwen-flash", provider: "opencode-go", model: "qwen3.8-flash" },
	{ profileId: "exec-hy3", provider: "opencode-go", model: "hy3" },
	{ profileId: "exec-mimo", provider: "opencode-go", model: "mimo-v2.5" },
];

const CURRENT_CATALOG: CatalogEntry[] = [
	{ provider: "xai", model: "grok-4.6" },
	{ provider: "opencode-go", model: "qwen3.8-flash" },
	{ provider: "opencode-go", model: "hy3" },
	{ provider: "opencode-go", model: "mimo-v2.5" },
	{ provider: "anthropic", model: "claude-opus-4-7" },
];

test("全对：ok 为 true，文本含「都对得上」并列出对上的条目", () => {
	const result = auditProfiles(CURRENT_PROFILES, CURRENT_CATALOG);

	assert.equal(result.ok, true);
	assert.equal(result.stale.length, 0);
	assert.equal(result.matched.length, 4);

	const text = formatAuditReport(result, CURRENT_CATALOG);
	assert.ok(text.includes("都对得上"), `文本里必须出现原文「都对得上」，实际：\n${text}`);
	assert.notEqual(text.trim(), "", "全对时也禁止空输出");
	for (const profile of CURRENT_PROFILES) {
		assert.ok(text.includes(profile.profileId), `文本应列出对上的 ${profile.profileId}`);
		assert.ok(text.includes(`${profile.provider}/${profile.model}`));
	}
});

test("历史场景：provider 整段改名（bai → opencode-go），模型 id 还在", () => {
	// 档案表还停在 r1：exec-hy3 写着 bai/hy3；上游目录里只有 opencode-go/hy3。
	const profiles: AuditProfileEntry[] = [
		{ profileId: "coordinator-grok", provider: "xai", model: "grok-4.6" },
		{ profileId: "exec-hy3", provider: "bai", model: "hy3" },
	];
	const catalog: CatalogEntry[] = [
		{ provider: "xai", model: "grok-4.6" },
		{ provider: "opencode-go", model: "hy3" },
		{ provider: "opencode-go", model: "mimo-v2.5" },
		{ provider: "opencode-go", model: "qwen3.8-flash" },
	];
	const available: CatalogEntry[] = [
		{ provider: "opencode-go", model: "hy3" },
		{ provider: "opencode-go", model: "mimo-v2.5" },
		{ provider: "opencode-go", model: "qwen3.8-flash" },
		{ provider: "xai", model: "grok-4.6" },
	];

	const result = auditProfiles(profiles, catalog);

	assert.equal(result.ok, false, "有过期就必须 ok=false（CLI 据此退 1）");
	assert.equal(result.stale.length, 1);
	const stale = result.stale[0]!;
	assert.equal(stale.profileId, "exec-hy3", "要点名是哪条档案");
	assert.equal(stale.provider, "bai", "要带上表里写的 provider");
	assert.equal(stale.model, "hy3", "要带上表里写的 model");
	assert.deepEqual(
		stale.sameNameElsewhere,
		[{ provider: "opencode-go", model: "hy3" }],
		"同名模型现在在哪个 provider 必须能查出来",
	);
	assert.equal(result.matched.length, 1);

	const text = formatAuditReport(result, available);
	assert.ok(text.includes("exec-hy3"), "文本要点名档案");
	assert.ok(text.includes("bai/hy3"), "文本要写出表里写的是什么");
	assert.ok(
		text.includes("opencode-go/hy3"),
		`文本要能让人看出该改成 opencode-go/hy3，实际：\n${text}`,
	);
	// 有过期时必须给出按 provider 分组的可用清单。
	assert.match(text, /按 provider 分组/);
	assert.match(text, /^\s+opencode-go$/m, "可用清单要按 provider 分组");
	assert.match(text, /^\s+- hy3$/m, "分组里要列出该 provider 下的模型");
	assert.match(text, /^\s+- mimo-v2\.5$/m);
	assert.match(text, /^\s+xai$/m);
});

test("判定口径是「目录里在不在」，不是「有没有凭证」", () => {
	// 档案条目在目录里，但 **不在** getAvailable 里（没配凭证）——
	// 这不算过期，不能报成 provider/model 不存在。
	const result = auditProfiles(CURRENT_PROFILES, CURRENT_CATALOG);
	const availableOnly: CatalogEntry[] = [{ provider: "xai", model: "grok-4.6" }];

	assert.equal(result.ok, true);
	const text = formatAuditReport(result, availableOnly);
	assert.ok(text.includes("都对得上"));
});

test("同名模型在上游也没了：不编造替代，明说可能是模型下线", () => {
	const profiles: AuditProfileEntry[] = [{ profileId: "exec-gone", provider: "bai", model: "gone-1" }];
	const result = auditProfiles(profiles, [{ provider: "opencode-go", model: "hy3" }]);

	assert.equal(result.ok, false);
	assert.deepEqual(result.stale[0]!.sameNameElsewhere, []);
	const text = formatAuditReport(result, []);
	assert.ok(text.includes("exec-gone"));
	assert.ok(text.includes("bai/gone-1"));
	assert.ok(text.includes("已经下线"), `应说明模型 id 本身可能下线，实际：\n${text}`);
});

test("报告只打 getAvailable 那份，不把 getModels 的上千条倒出来", () => {
	// 目录里塞一堆与档案无关的项，模拟 getModels 的全量。
	const filler: CatalogEntry[] = Array.from({ length: 500 }, (_, i) => ({
		provider: `filler-provider-${i}`,
		model: `filler-model-${i}`,
	}));
	const profiles: AuditProfileEntry[] = [{ profileId: "exec-hy3", provider: "bai", model: "hy3" }];
	const catalog: CatalogEntry[] = [{ provider: "opencode-go", model: "hy3" }, ...filler];

	const result = auditProfiles(profiles, catalog);
	const text = formatAuditReport(result, [{ provider: "opencode-go", model: "hy3" }]);

	assert.ok(text.includes("opencode-go/hy3"));
	assert.equal(text.includes("filler-model-17"), false, "全量目录不能进报告");
	assert.equal(text.includes("filler-provider-17"), false);
	assert.ok(text.split("\n").length < 30, "报告要短到人一眼能看完");
});
