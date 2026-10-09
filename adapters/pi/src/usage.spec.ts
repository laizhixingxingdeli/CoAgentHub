import assert from "node:assert/strict";
import { test } from "node:test";
import { queryUsage, resolveXaiOAuth } from "./usage.js";
import { runUsageCommand } from "./cli.js";

const identity = { userId: "private-user-id" };
const billing = { subscriptionTier: "SuperGrok", config: { creditUsagePercent: 23.5, currentPeriod: { start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" } } };
const jsonResponse = (body: unknown, ok = true): Response => ({ ok, json: async () => body } as Response);
const statusResponse = (status: number, body: unknown = {}): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
const TENROUTER_MARKER = "/api/usage/quotas";
const TENROUTER_DEFAULT_URL = `http://127.0.0.1:20128${TENROUTER_MARKER}`;
// 旧 xAI 金样在本单新增 10Router 查询后必须保持不变：按 URL 分发，10Router 成功但
// 返回空 connections（聚合出 0 行），于是 queryUsage 仍只产出 xAI 行。
const emptyTenrouter = (): Response => jsonResponse({ connections: [] });
// 定向假 fetch 的默认分发：10Router 空成功，xAI 走给定 body。
const xaiFetch = (resolver: (url: string) => Response) => async (url: string, init?: RequestInit): Promise<Response> =>
	url.includes(TENROUTER_MARKER) ? emptyTenrouter() : resolver(url);

test("xAI lookup is identity-first and returns only approved fields", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const rows = await queryUsage({
		oauth: async () => "secret-token",
		now: () => new Date("2026-01-05T00:00:00.000Z"),
		fetch: async (url, init) => {
			if (url.includes(TENROUTER_MARKER)) return emptyTenrouter();
			calls.push({ url, init });
			return jsonResponse(url.endsWith("/user") ? identity : billing);
		},
	});
	assert.deepEqual(calls.map((call) => call.url), ["https://cli-chat-proxy.grok.com/v1/user", "https://cli-chat-proxy.grok.com/v1/billing?format=credits"]);
	assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer secret-token");
	assert.equal((calls[1].init?.headers as Record<string, string>)["x-userid"], "private-user-id");
	assert.deepEqual(rows, [{ provider: "xai", status: "ok", usedPercent: 23.5, remainingPercent: 76.5, resetAt: "2026-02-01T00:00:00Z", periodStart: "2026-01-01T00:00:00Z", plan: "SuperGrok", fetchedAt: "2026-01-05T00:00:00.000Z" }]);
	assert.doesNotMatch(JSON.stringify(rows), /secret-token|private-user-id|monthlyLimit|creditUsagePercent/);
});

test("OAuth is required and API-key-only runtimes are rejected", async () => {
	let authCalls = 0;
	const runtime = { isUsingOAuth: () => false, getAuth: async () => { authCalls++; return { auth: { apiKey: "api-key" } }; } };
	assert.equal(await resolveXaiOAuth(runtime), undefined);
	assert.equal(authCalls, 0);
	assert.deepEqual(await queryUsage({ runtime, fetch: xaiFetch(() => jsonResponse(identity)) }), [{ provider: "xai", status: "no_auth" }]);
	// 10Router 成功返回空 connections ⇒ 只产出 xAI 行。
});

test("OAuth resolution checks registered xAI aliases and extracts Bearer", async () => {
	const runtime = { isUsingOAuth: (provider: string) => provider === "xai-auth", getAuth: async () => ({ auth: { headers: { Authorization: "Bearer oauth-token" } } }) };
	assert.equal(await resolveXaiOAuth(runtime), "oauth-token");
});

test("HTTP and malformed responses return safe errors", async () => {
	const rejected = await queryUsage({ oauth: async () => "token", fetch: xaiFetch(() => jsonResponse({}, false)) });
	assert.deepEqual(rejected[0], { provider: "xai", status: "error" });
	assert.ok(rejected.slice(1).every((row) => row.provider === "tenrouter" && row.status === "error"));
	const malformed = await queryUsage({ oauth: async () => "token", fetch: xaiFetch(() => jsonResponse({})) });
	assert.deepEqual(malformed[0], { provider: "xai", status: "error" });
	assert.ok(malformed.slice(1).every((row) => row.provider === "tenrouter" && row.status === "error"));
});

test("credit amounts are fallback and missing fields are omitted", async () => {
	const rows = await queryUsage({ oauth: async () => "token", fetch: xaiFetch((url) => jsonResponse(url.endsWith("/user") ? identity : { subscriptionTier: "invalid plan!", config: { used: { val: 25 }, monthlyLimit: { val: 100 } } })) });
	assert.deepEqual(rows, [{ provider: "xai", status: "ok", usedPercent: 25, remainingPercent: 75, fetchedAt: rows[0].fetchedAt, plan: "SuperGrok" }]);
	assert.equal(typeof rows[0].fetchedAt, "string");
});

test("out-of-range direct percentages fall back to valid amounts or omit percentages", async () => {
	const withFallback = await queryUsage({ oauth: async () => "secret", fetch: xaiFetch((url) => jsonResponse(url.endsWith("/user") ? identity : { config: { creditUsagePercent: 101, used: { val: 30 }, monthlyLimit: { val: 120 } } })) });
	assert.deepEqual(withFallback, [{ provider: "xai", status: "ok", usedPercent: 25, remainingPercent: 75, plan: "SuperGrok", fetchedAt: withFallback[0].fetchedAt }]);
	const withoutFallback = await queryUsage({ oauth: async () => "secret", fetch: xaiFetch((url) => jsonResponse(url.endsWith("/user") ? identity : { config: { creditUsagePercent: 101, used: { val: 30 }, monthlyLimit: { val: 0 } } })) });
	assert.equal(withoutFallback[0].usedPercent, undefined);
	assert.equal(withoutFallback[0].remainingPercent, undefined);
	assert.doesNotMatch(JSON.stringify([...withFallback, ...withoutFallback]), /secret|private-user-id|monthlyLimit|\"val\"/);
});

test("timeout races a fetch that ignores abort", async () => {
	const began = Date.now();
	const rows = await queryUsage({
		timeoutMs: 20,
		oauth: async () => "token",
		fetch: async (url) => (url.includes(TENROUTER_MARKER) ? emptyTenrouter() : new Promise<Response>(() => {})),
	});
	assert.deepEqual(rows, [{ provider: "xai", status: "timeout" }]);
	assert.ok(Date.now() - began < 1000);
});

test("deadline includes a hanging OAuth resolution", async () => {
	const rows = await queryUsage({ timeoutMs: 20, oauth: () => new Promise<string>(() => {}), fetch: xaiFetch(() => jsonResponse(identity)) });
	assert.deepEqual(rows, [{ provider: "xai", status: "timeout" }]);
});

test("usage CLI writes one allowlisted JSON line for injected success", async () => {
	const output: string[] = [];
	await runUsageCommand({
		oauth: async () => "secret-token",
		now: () => new Date("2026-01-05T00:00:00.000Z"),
		fetch: xaiFetch((url) => jsonResponse(url.endsWith("/user") ? identity : billing)),
	}, (chunk) => output.push(chunk));
	assert.equal(output.length, 1);
	assert.equal(output[0].endsWith("\n"), true);
	assert.deepEqual(JSON.parse(output[0]), [{ provider: "xai", status: "ok", usedPercent: 23.5, remainingPercent: 76.5, resetAt: "2026-02-01T00:00:00Z", periodStart: "2026-01-01T00:00:00Z", plan: "SuperGrok", fetchedAt: "2026-01-05T00:00:00.000Z" }]);
	assert.doesNotMatch(output[0], /secret-token|private-user-id|monthlyLimit|creditUsagePercent|amount|\\$/i);
});

test("usage CLI emits safe lines for unauthenticated, failed, timed out, and sparse queries", async () => {
	const run = async (dependencies: Parameters<typeof runUsageCommand>[0]) => {
		const output: string[] = [];
		await runUsageCommand(dependencies, (chunk) => output.push(chunk));
		assert.equal(output.length, 1);
		return JSON.parse(output[0]);
	};
	assert.deepEqual(await run({ oauth: async () => undefined, fetch: xaiFetch(() => jsonResponse(identity)) }), [{ provider: "xai", status: "no_auth" }]);
	assert.deepEqual(await run({ oauth: async () => "secret", fetch: xaiFetch(() => { throw new Error("secret billing token $999"); }) }), [{ provider: "xai", status: "error" }]);
	assert.deepEqual(await run({ timeoutMs: 10, oauth: () => new Promise<string>(() => {}), fetch: xaiFetch(() => jsonResponse(identity)) }), [{ provider: "xai", status: "timeout" }]);
	const sparse = await run({ oauth: async () => "secret", fetch: xaiFetch((url) => jsonResponse(url.endsWith("/user") ? identity : {})) });
	assert.equal(sparse[0].provider, "xai");
	assert.equal(sparse[0].status, "ok");
	assert.deepEqual(Object.keys(sparse[0]).sort(), ["fetchedAt", "plan", "provider", "status"]);
	assert.equal(typeof sparse[0].fetchedAt, "string");
});

test("10Router quotas aggregate conservatively, map prefixes, and never leak PII", async (t) => {
	const now = () => new Date("2026-03-01T00:00:00.000Z");
	// 宿主环境可能带着 COAGENT_TENROUTER_URL（例如 L3 在本机把额度地址指到不可达处止损）：
	// 「默认根地址」这条断言只能由本测试决定，否则同一份代码在带该变量的机器上会假失败。
	// 先摘掉宿主变量，测试结束再原样还原。
	const hostRoot = process.env.COAGENT_TENROUTER_URL;
	delete process.env.COAGENT_TENROUTER_URL;
	t.after(() => {
		if (hostRoot === undefined) delete process.env.COAGENT_TENROUTER_URL;
		else process.env.COAGENT_TENROUTER_URL = hostRoot;
	});
	// 虚构样例：无真实账号、无真实端点；只含聚合所需字段与用于断言不外泄的假 PII。
	const fixture = {
		generatedAt: "2026-03-01T00:00:00Z",
		connections: [
			// codebuddy-cn：耗尽账号（将来可恢复）+ 摘要 60 / detailOnly 100 / 礼包 30 + 纯礼包 90 + 已停用账号
			{ provider: "codebuddy-cn", isActive: true, name: "Ada Lovelace", email: "ada@example.com", message: "boom", quotas: [
				{ unit: "usd", modelKey: "cbcn-1", used: 100, total: 100, remainingPercentage: 0, percentScale: 100, resetAt: "2026-03-01T06:00:00Z" },
			] },
			{ provider: "codebuddy-cn", isActive: true, quotas: [
				{ aggregate: true, summarizesDetail: true, remainingPercentage: 60, percentScale: 100, unit: "usd", modelKey: "cbcn-2" },
				{ detailOnly: true, remainingPercentage: 100, percentScale: 100, unit: "usd", modelKey: "cbcn-2-detail" },
				{ giftPack: true, remainingPercentage: 30, percentScale: 100, unit: "usd", modelKey: "cbcn-2-gift" },
			] },
			{ provider: "codebuddy-cn", isActive: true, quotas: [
				{ giftPack: true, remainingPercentage: 90, percentScale: 100, unit: "usd", modelKey: "cbcn-3-gift" },
			] },
			{ provider: "codebuddy-cn", isActive: false, quotas: [{ remainingPercentage: 100, percentScale: 100, unit: "usd" }] },
			// antigravity：全部明确耗尽。任一窗口恢复即可用，所以账户内不再要求所有桶同时恢复：
			// 账户取最早将来 08:00，上游也取最早候选 08:00；过期 reset（2026-02-01）忽略。
			{ provider: "antigravity", isActive: true, quotas: [
				{ remainingPercentage: 0, percentScale: 100, unit: "usd", resetAt: "2026-03-01T08:00:00Z" },
				{ remainingPercentage: 0, percentScale: 100, unit: "usd", resetAt: "2026-03-01T09:00:00Z" },
			] },
			{ provider: "antigravity", isActive: true, quotas: [{ remainingPercentage: 0, percentScale: 100, unit: "usd", resetAt: "2026-03-01T10:00:00Z" }] },
			{ provider: "antigravity", isActive: true, quotas: [{ remainingPercentage: 0, percentScale: 100, unit: "usd", resetAt: "2026-02-01T00:00:00Z" }] },
			// qoder-cn：无法解释额度 → 未知，百分比与 reset 均省略
			{ provider: "qoder-cn", isActive: true, quotas: [
				{ unit: "tokens", modelKey: "qdc-1", message: "boom" },
				{ detailOnly: true, remainingPercentage: 0, percentScale: 100 },
			] },
			// qoder-cn：aggregate 已概括 detailOnly 明细，明细的 100 不得把它抬成可用；
			// 该账号耗尽但整行仍因另一个未知账号而省略百分比。
			{ provider: "qoder-cn", isActive: true, quotas: [
				{ aggregate: true, summarizesDetail: true, remainingPercentage: 0, percentScale: 100, unit: "usd", modelKey: "qdc-2" },
				{ detailOnly: true, remainingPercentage: 100, percentScale: 100, unit: "usd", modelKey: "qdc-2-detail" },
			] },
			// 未映射上游：不出行
			{ provider: "zzz", isActive: true, quotas: [{ remainingPercentage: 100, percentScale: 100 }] },
		],
	};
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const rows = await queryUsage({
		oauth: async () => "secret-token",
		now,
		fetch: async (url, init) => {
			requests.push({ url, init });
			return url.includes(TENROUTER_MARKER) ? jsonResponse(fixture) : jsonResponse(url.endsWith("/user") ? identity : billing);
		},
	});
	const tenrouterRequest = requests.find((request) => request.url.includes(TENROUTER_MARKER));
	assert.equal(tenrouterRequest?.url, TENROUTER_DEFAULT_URL);
	assert.equal(tenrouterRequest?.init?.headers, undefined, "no credentials on the local 10Router request");
	assert.deepEqual(rows, [
		{ provider: "xai", status: "ok", usedPercent: 23.5, remainingPercent: 76.5, resetAt: "2026-02-01T00:00:00Z", periodStart: "2026-01-01T00:00:00Z", plan: "SuperGrok", fetchedAt: "2026-03-01T00:00:00.000Z" },
		// cbcn 可用 ⇒ 不带 resetAt；只有整行确实输出 0/100 时才有恢复时间。
		{ provider: "tenrouter", modelPrefix: "cbcn", upstream: "codebuddy-cn", status: "ok", remainingPercent: 90, usedPercent: 10, fetchedAt: "2026-03-01T00:00:00.000Z" },
		{ provider: "tenrouter", modelPrefix: "ag", upstream: "antigravity", status: "ok", remainingPercent: 0, usedPercent: 100, resetAt: "2026-03-01T08:00:00Z", fetchedAt: "2026-03-01T00:00:00.000Z" },
		{ provider: "tenrouter", modelPrefix: "qdc", upstream: "qoder-cn", status: "ok", fetchedAt: "2026-03-01T00:00:00.000Z" },
	]);
	assert.doesNotMatch(JSON.stringify(rows), /Ada Lovelace|ada@example\.com|boom|message|private-user-id/);

	const original = process.env.COAGENT_TENROUTER_URL;
	try {
		process.env.COAGENT_TENROUTER_URL = "http://127.0.0.1:29999/";
		let seenUrl = "";
		let seenHeaders: unknown = "unset";
		const noAuth = await queryUsage({
			oauth: async () => undefined,
			now,
			fetch: async (url, init) => { seenUrl = url; seenHeaders = init?.headers; return statusResponse(401); },
		});
		assert.equal(seenUrl, "http://127.0.0.1:29999/api/usage/quotas");
		assert.equal(seenHeaders, undefined);
		assert.deepEqual(noAuth, [
			{ provider: "xai", status: "no_auth" },
			{ provider: "tenrouter", modelPrefix: "cbcn", upstream: "codebuddy-cn", status: "no_auth", fetchedAt: "2026-03-01T00:00:00.000Z" },
			{ provider: "tenrouter", modelPrefix: "ag", upstream: "antigravity", status: "no_auth", fetchedAt: "2026-03-01T00:00:00.000Z" },
			{ provider: "tenrouter", modelPrefix: "qdc", upstream: "qoder-cn", status: "no_auth", fetchedAt: "2026-03-01T00:00:00.000Z" },
		]);

		delete process.env.COAGENT_TENROUTER_URL;
		let defaultUrl = "";
		await queryUsage({
			oauth: async () => undefined,
			now,
			fetch: async (url) => { defaultUrl = url; return emptyTenrouter(); },
		});
		assert.equal(defaultUrl, TENROUTER_DEFAULT_URL);
	} finally {
		if (original === undefined) delete process.env.COAGENT_TENROUTER_URL;
		else process.env.COAGENT_TENROUTER_URL = original;
	}
});

test("10Router failures stay isolated from the xAI row and run concurrently", async () => {
	const now = () => new Date("2026-01-05T00:00:00.000Z");
	const xaiRow = { provider: "xai", status: "ok", usedPercent: 23.5, remainingPercent: 76.5, resetAt: "2026-02-01T00:00:00Z", periodStart: "2026-01-01T00:00:00Z", plan: "SuperGrok", fetchedAt: "2026-01-05T00:00:00.000Z" };
	const expectedUpstreams = [["tenrouter", "codebuddy-cn"], ["tenrouter", "antigravity"], ["tenrouter", "qoder-cn"]];

	// 挂起 → timeout：xAI 请求只有在 tenrouter 请求已经发起后才拿到响应，证明两者并发。
	let tenrouterStarted = false;
	let concurrent = false;
	const timedOut = await queryUsage({
		timeoutMs: 50,
		oauth: async () => "secret-token",
		now,
		fetch: async (url) => {
			if (url.includes(TENROUTER_MARKER)) { tenrouterStarted = true; return new Promise<Response>(() => {}); }
			if (url.endsWith("/user")) {
				for (let i = 0; i < 200 && !tenrouterStarted; i++) await new Promise((resolve) => setTimeout(resolve, 1));
				concurrent = tenrouterStarted;
			}
			return jsonResponse(url.endsWith("/user") ? identity : billing);
		},
	});
	assert.ok(concurrent, "xAI and 10Router requests must overlap");
	assert.deepEqual(timedOut[0], xaiRow);
	assert.deepEqual(timedOut.slice(1).map((row) => [row.provider, row.upstream, row.status]), expectedUpstreams.map(([provider, upstream]) => [provider, upstream, "timeout"]));

	const throwing = await queryUsage({
		oauth: async () => "secret-token",
		now,
		fetch: async (url) => {
			if (url.includes(TENROUTER_MARKER)) throw new Error("secret balance $999");
			return jsonResponse(url.endsWith("/user") ? identity : billing);
		},
	});
	assert.deepEqual(throwing[0], xaiRow);
	assert.deepEqual(throwing.slice(1).map((row) => [row.provider, row.upstream, row.status]), expectedUpstreams.map(([provider, upstream]) => [provider, upstream, "error"]));
	assert.doesNotMatch(JSON.stringify(throwing), /secret balance|999/);

	for (const status of [401, 403]) {
		const denied = await queryUsage({
			oauth: async () => "secret-token",
			now,
			fetch: async (url) => (url.includes(TENROUTER_MARKER) ? statusResponse(status) : jsonResponse(url.endsWith("/user") ? identity : billing)),
		});
		assert.deepEqual(denied[0], xaiRow);
		assert.deepEqual(denied.slice(1).map((row) => [row.provider, row.upstream, row.status]), expectedUpstreams.map(([provider, upstream]) => [provider, upstream, "no_auth"]));
	}
});

// —— CodeBuddy 真实形状（虚构账号，无姓名/邮箱/id）——
// 每个账号 26 桶 = 总额度池（resetAt null）+ Monthly（礼包、recurring）+ 24 个 Bonus Pack
// （礼包、recurring false、各带一个比月末更早的过期时间）。旧实现把小包也当基础额度取最小值，
// 于是「总额度还有余额但个别小包用完」会被误判为耗尽；现在只按最高层（总额度池）判断。
const CODEBUDDY_NOW = () => new Date("2026-10-07T00:00:00.000Z");
const CODEBUDDY_MONTHLY_RESET = "2026-10-31T15:59:59.000Z";

const poolBucket = (used: number, total: number): Record<string, unknown> => ({
	modelKey: "cbcn-total",
	name: "Total Points",
	displayRemaining: true,
	resetAt: null,
	used,
	total,
});
const monthlyBucket = (used: number, total: number): Record<string, unknown> => ({
	modelKey: "cbcn-monthly",
	giftPack: true,
	recurring: true,
	displayRemaining: true,
	used,
	total,
	resetAt: CODEBUDDY_MONTHLY_RESET,
});
const bonusPack = (index: number, used: number, total: number): Record<string, unknown> => ({
	modelKey: `cbcn-pack-${index}`,
	giftPack: true,
	recurring: false,
	displayRemaining: true,
	used,
	total,
	// 一次性礼包的 resetAt 是「到期」而非「刷新」，所以它比月末更早也不得当作恢复证据。
	resetAt: new Date(Date.UTC(2026, 9, 15, 0, 0, index)).toISOString(),
});

function codebuddyAccounts(exhausted = false): Array<Record<string, unknown>> {
	// 账号 1：总额度池只剩 64.79/3156；Monthly 用尽，22 包 100、1 包 356、末包 35.21/100。
	const account1 = [
		poolBucket(3091.21, 3156),
		monthlyBucket(500, 500),
		...Array.from({ length: 24 }, (_, i) => bonusPack(i, i < 22 ? 100 : i === 22 ? 356 : 35.21, i < 22 ? 100 : i === 22 ? 356 : 100)),
	];
	// 账号 2：总额度池 1670.95/4650（剩下 2979.05）；Pack1 用尽，Pack2 1070.95/1500。
	const account2 = [
		poolBucket(1670.95, 4650),
		monthlyBucket(500, 500),
		bonusPack(0, 100, 100),
		bonusPack(1, 1070.95, 1500),
		...Array.from({ length: 22 }, (_, j) => bonusPack(2 + j, 0, j < 14 ? 100 : j < 17 ? 300 : 50)),
	];
	// 账号 3：复用账号 2 的额度分配，总额度池 2600/4650（剩下 2050）；剩余包合计用 500。
	const account3 = [
		poolBucket(2600, 4650),
		monthlyBucket(500, 500),
		bonusPack(0, 100, 100),
		bonusPack(1, 1500, 1500),
		...Array.from({ length: 22 }, (_, j) => bonusPack(2 + j, j < 5 ? 100 : 0, j < 14 ? 100 : j < 17 ? 300 : 50)),
	];
	const accounts = [
		{ provider: "codebuddy-cn", isActive: true, quotas: account1 },
		{ provider: "codebuddy-cn", isActive: true, quotas: account2 },
		{ provider: "codebuddy-cn", isActive: true, quotas: account3 },
	];
	if (!exhausted) return accounts;
	// 同一夹具把每个桶都用到 total：这才是真正的「全部额度耗尽」。
	return accounts.map((account) => ({
		...account,
		quotas: (account.quotas as Array<Record<string, unknown>>).map((bucket) => ({ ...bucket, used: bucket.total })),
	}));
}

const codebuddyFetch = (body: unknown) => async (url: string): Promise<Response> =>
	url.includes(TENROUTER_MARKER) ? jsonResponse(body) : jsonResponse(url.endsWith("/user") ? identity : billing);

test("CodeBuddy 总额度池优先于小包：可用账号输出最佳百分比且不带恢复时间", async () => {
	const rows = await queryUsage({ oauth: async () => "secret", now: CODEBUDDY_NOW, fetch: codebuddyFetch({ connections: codebuddyAccounts() }) });
	const best = 2979.05 / 4650 * 100;
	// 真实形状：每个 active 账号 26 桶（总额度池 + Monthly + 24 个 Bonus Pack）。
	assert.deepEqual(codebuddyAccounts().map((account) => (account.quotas as unknown[]).length), [26, 26, 26]);
	assert.deepEqual(rows.slice(1), [
		{ provider: "tenrouter", modelPrefix: "cbcn", upstream: "codebuddy-cn", status: "ok", remainingPercent: best, usedPercent: 100 - best, fetchedAt: "2026-10-07T00:00:00.000Z" },
	]);
	// 小包（用尽的 100/100）不能把总池的余额压低成 0/100，也不能把结果抬到 100。
	assert.notEqual(rows[1].remainingPercent, 0);
	assert.notEqual(rows[1].remainingPercent, 100);
	// 只有整行确实 0/100 才带 resetAt：可用行不能拿 Bonus 的过期时间冒充恢复时间。
	assert.equal("resetAt" in rows[1], false);
	assert.doesNotMatch(JSON.stringify(rows), /Total Points|cbcn-total|cbcn-pack|cbcn-monthly|Ada|@example\.com/);
});

test("CodeBuddy 全部额度耗尽才 0/100，恢复时间只取会刷新的 Monthly", async () => {
	const rows = await queryUsage({ oauth: async () => "secret", now: CODEBUDDY_NOW, fetch: codebuddyFetch({ connections: codebuddyAccounts(true) }) });
	assert.deepEqual(rows.slice(1), [
		{ provider: "tenrouter", modelPrefix: "cbcn", upstream: "codebuddy-cn", status: "ok", remainingPercent: 0, usedPercent: 100, resetAt: CODEBUDDY_MONTHLY_RESET, fetchedAt: "2026-10-07T00:00:00.000Z" },
	]);
	// Bonus 包带的是更早的过期时间，recurring=false 说明它不刷新，绝不能当选恢复时刻。
	assert.ok(rows[1].resetAt !== new Date(Date.UTC(2026, 9, 15, 0, 0, 0)).toISOString());
});

// —— Antigravity 四个窗口 ——
const antigravityConnection = (used: number[]): Record<string, unknown> => ({
	provider: "antigravity",
	isActive: true,
	quotas: [
		{ modelKey: "gemini_5h", used: used[0], total: 100, percentScale: true, remainingPercentage: 100 - used[0], resetAt: "2026-10-07T10:00:00.000Z" },
		{ modelKey: "gemini_weekly", used: used[1], total: 100, percentScale: true, remainingPercentage: 100 - used[1], resetAt: "2026-10-14T00:00:00.000Z" },
		{ modelKey: "claude_gpt_5h", used: used[2], total: 100, percentScale: true, remainingPercentage: 100 - used[2], resetAt: "2026-10-07T08:00:00.000Z" },
		{ modelKey: "claude_gpt_weekly", used: used[3], total: 100, percentScale: true, remainingPercentage: 100 - used[3], resetAt: "2026-10-12T00:00:00.000Z" },
	],
});
const antigravityFetch = (quotas: Array<Record<string, unknown>>) => async (url: string): Promise<Response> =>
	url.includes(TENROUTER_MARKER) ? jsonResponse({ connections: [{ provider: "antigravity", isActive: true, quotas }] }) : jsonResponse(url.endsWith("/user") ? identity : billing);

async function antigravityRow(connection: Record<string, unknown>): Promise<Record<string, unknown>> {
	const rows = await queryUsage({ oauth: async () => "secret", now: () => new Date("2026-10-07T00:00:00.000Z"), fetch: antigravityFetch(connection.quotas as Array<Record<string, unknown>>) });
	assert.equal(rows.length, 2);
	return rows[1] as unknown as Record<string, unknown>;
}

test("Antigravity 任一窗口有余额即可用，全耗尽才 0/100，未知/unlimited 不误报 0", async () => {
	// 部分可用：取最多余额的窗口百分比；可用行不给恢复时间。
	const partial = await antigravityRow(antigravityConnection([6, 9, 0, 0]));
	assert.deepEqual(partial, { provider: "tenrouter", modelPrefix: "ag", upstream: "antigravity", status: "ok", remainingPercent: 100, usedPercent: 0, fetchedAt: "2026-10-07T00:00:00.000Z" });

	// 全部明确耗尽：0/100，且任一窗口刷新即可用，所以取最早的未来恢复时刻而不是最晚。
	const exhausted = await antigravityRow(antigravityConnection([100, 100, 100, 100]));
	assert.deepEqual(exhausted, { provider: "tenrouter", modelPrefix: "ag", upstream: "antigravity", status: "ok", remainingPercent: 0, usedPercent: 100, resetAt: "2026-10-07T08:00:00.000Z", fetchedAt: "2026-10-07T00:00:00.000Z" });

	// unlimited 与未知混在一起：可用但没有可解释百分比，既不能猜 0 也不能伪造 100。
	const unlimitedUnknown = await antigravityRow({ quotas: [
		{ modelKey: "gemini_5h", unlimited: true, resetAt: "2026-10-07T10:00:00.000Z" },
		{ modelKey: "gemini_weekly", unit: "tokens", resetAt: "2026-10-14T00:00:00.000Z" },
	] });
	assert.equal(unlimitedUnknown.remainingPercent, undefined);
	assert.equal(unlimitedUnknown.usedPercent, undefined);
	assert.equal("resetAt" in unlimitedUnknown, false);

	// 只有无法解释的额度：未知，省略百分比而不是报 0/100。
	const unknownOnly = await antigravityRow({ quotas: [
		{ modelKey: "gemini_5h", unit: "tokens" },
		{ modelKey: "gemini_weekly", unit: "usd", resetAt: "2026-10-07T09:00:00.000Z" },
	] });
	assert.equal(unknownOnly.remainingPercent, undefined);
	assert.equal(unknownOnly.usedPercent, undefined);
	assert.equal("resetAt" in unknownOnly, false);
});
