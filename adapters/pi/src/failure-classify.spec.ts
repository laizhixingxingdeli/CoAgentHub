/**
 * src/failure-classify.ts 的测试：node:test + tsx，无新增依赖。
 *
 * 跑法：npx tsx --test src/failure-classify.spec.ts
 *
 * 这些用例的输入**照抄真跑出来的形状**，不是编的：
 *  - 429/401/5xx 的 statusCode 来自 undici `undici:request:headers`（probe 实测）；
 *  - ENOTFOUND / ECONNREFUSED 来自 `undici:request:error`（死代理 / 假域名实测）；
 *  - content_filter / refusal 来自 provider 原生 rawStopReason（本地 mock 实测）；
 *  - 「No API key found」来自没有配凭证时 prompt() 抛出的真实异常。
 *
 * 重点锁四件事：
 *  1. 有结构化证据时一律先吃结构化证据，文案不参与；
 *  2. 模型不存在 / 凭据缺失 / 网络不通 这三类真实失败各自归对；
 *  3. 每一类都说得出「该不该换候选重试」；
 *  4. 拿不准 → unknown（basis=none），**不是**静默退回一律重试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	classifyUpstreamFailure,
	failureOf,
	withFailure,
	type FailureEvidence,
	type UpstreamFailureCategory,
} from "./failure-classify.js";

/** 一条「模型存在且凭据已配」的基线证据，用例只覆盖关心的字段。 */
function base(overrides: Partial<FailureEvidence>): FailureEvidence {
	return {
		modelExists: true,
		provider: "opencode-go",
		model: "hy3",
		authConfigured: true,
		...overrides,
	};
}

test("模型不存在（上游整段改名 bai→opencode-go）：解析阶段就结构化判定，换候选", () => {
	// 复刻历史场景：档案表还写着 bai/hy3，上游目录里已经没有这个 provider。
	const c = classifyUpstreamFailure(
		base({ modelExists: false, provider: "bai", authConfigured: false, errorMessage: "模型不可用：bai/hy3。" }),
	);

	assert.equal(c.category, "model_not_found");
	assert.equal(c.verdict, "switch_candidate");
	assert.equal(c.retryable, true);
	assert.equal(c.retryWithAnotherCandidate, true, "候选本身坏了，应该换候选重试");
	assert.equal(c.basis, "structured", "判定来自 getModel，不是文案");
	assert.ok(c.evidence.some((e) => e.includes("getModel(bai/hy3)=undefined")));
});

test("凭据缺失（模型在目录里，但 provider 没配凭证）：等多久都没用，别换候选去赌", () => {
	// 真实形状：getModel 找到、hasConfiguredAuth 为 false；prompt 抛 "No API key found"。
	const c = classifyUpstreamFailure(
		base({ authConfigured: false, errorMessage: "No API key found for google." }),
	);

	assert.equal(c.category, "credentials");
	assert.equal(c.verdict, "do_not_retry");
	assert.equal(c.retryable, false);
	assert.equal(c.retryWithAnotherCandidate, false);
	assert.equal(c.basis, "structured");
	assert.ok(c.evidence.some((e) => e.includes("hasConfiguredAuth(google)=false") || e.includes("hasConfiguredAuth(opencode-go)=false")));
});

test("凭据被拒（HTTP 401）：凭据类，不重试", () => {
	const c = classifyUpstreamFailure(
		base({
			transport: [{ kind: "response", origin: "https://opencode.ai", statusCode: 401 }],
			errorMessage: '401: {"code":"invalid_api_key"}',
		}),
	);
	assert.equal(c.category, "credentials");
	assert.equal(c.basis, "structured");
	assert.equal(c.retryWithAnotherCandidate, false);
	assert.equal(c.retryable, false);
});

test("网络/代理断了：undici 给 ECONNREFUSED，是网络类，和模型无关", () => {
	// 真实形状：死代理时 assistant 消息只有 "Connection error."，但 undici 报 ECONNREFUSED。
	const c = classifyUpstreamFailure(
		base({
			transport: [
				{ kind: "error", origin: "https://opencode.ai", errorCode: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:9" },
			],
			errorMessage: "Connection error.",
		}),
	);
	assert.equal(c.category, "network");
	assert.equal(c.verdict, "retry_same");
	assert.equal(c.retryable, true);
	assert.equal(c.retryWithAnotherCandidate, false, "网络断和候选无关，换候选照样连不上");
	assert.equal(c.basis, "structured", "判定来自 ECONNREFUSED，不是那句没用的文案");
	assert.ok(c.evidence.some((e) => e.includes("ECONNREFUSED")));
});

test("DNS 不通（ENOTFOUND）也是网络类", () => {
	const c = classifyUpstreamFailure(
		base({
			transport: [
				{ kind: "error", origin: "https://no-such-host.invalid", errorCode: "ENOTFOUND", message: "getaddrinfo ENOTFOUND no-such-host.invalid" },
			],
			errorMessage: "Connection error.",
		}),
	);
	assert.equal(c.category, "network");
	assert.equal(c.basis, "structured");
});

test("限流（HTTP 429）：该等退避，不换候选", () => {
	const c = classifyUpstreamFailure(
		base({
			transport: [{ kind: "response", origin: "https://opencode.ai", statusCode: 429 }],
			errorMessage: '429: {"message":"Rate limit reached"}',
		}),
	);
	assert.equal(c.category, "rate_limited");
	assert.equal(c.verdict, "retry_same");
	assert.equal(c.retryable, true);
	assert.equal(c.retryWithAnotherCandidate, false);
	assert.equal(c.basis, "structured");
});

test("配额/账单耗尽（HTTP 402）：等不回来，不重试", () => {
	const c = classifyUpstreamFailure(
		base({ transport: [{ kind: "response", origin: "https://opencode.ai", statusCode: 402 }] }),
	);
	assert.equal(c.category, "quota_exhausted");
	assert.equal(c.retryable, false);
	assert.equal(c.retryWithAnotherCandidate, false);
});

test("xAI 403 额度耗尽（结构化状态码）：不重试且不泄露原始错误文案", () => {
	const c = classifyUpstreamFailure(
		base({ provider: "xai-auth", transport: [{ kind: "response", origin: "https://api.x.ai", statusCode: 403 }], errorMessage: "You have run out of credits" }),
	);
	assert.equal(c.category, "quota_exhausted");
	assert.equal(c.verdict, "do_not_retry");
	assert.equal(c.basis, "structured");
	assert.ok(!c.reason.includes("credits"));
});

test("xAI 403 Grok 订阅错误（文案状态码）：不重试", () => {
	const c = classifyUpstreamFailure(base({ provider: "xai", errorMessage: "HTTP 403: need a Grok subscription" }));
	assert.equal(c.category, "quota_exhausted");
	assert.equal(c.verdict, "do_not_retry");
	assert.equal(c.basis, "text");
});

test("xAI 普通 403 与其他 provider 的额度措辞仍是凭据错误", () => {
	const xai = classifyUpstreamFailure(base({ provider: "xai", transport: [{ kind: "response", origin: "https://api.x.ai", statusCode: 403 }], errorMessage: "Forbidden" }));
	const other = classifyUpstreamFailure(base({ provider: "openai", transport: [{ kind: "response", origin: "https://api.openai.com", statusCode: 403 }], errorMessage: "run out of credits" }));
	assert.equal(xai.category, "credentials");
	assert.equal(other.category, "credentials");
});

test("上游 5xx：网络类（服务端临时故障），等退避重试", () => {
	const c = classifyUpstreamFailure(
		base({ transport: [{ kind: "response", origin: "https://opencode.ai", statusCode: 503 }] }),
	);
	assert.equal(c.category, "network");
	assert.equal(c.verdict, "retry_same");
});

test("内容被合规挡下（openai content_filter）：模型回了，不是候选健康问题", () => {
	// 真实形状：HTTP 200，但 rawStopReason=content_filter，stopReason=error。
	const c = classifyUpstreamFailure(
		base({
			stopReason: "error",
			rawStopReason: "content_filter",
			transport: [{ kind: "response", origin: "https://opencode.ai", statusCode: 200 }],
			errorMessage: "Provider finish_reason: content_filter",
		}),
	);
	assert.equal(c.category, "content_blocked");
	assert.equal(c.verdict, "do_not_retry");
	assert.equal(c.retryWithAnotherCandidate, false);
	assert.equal(c.basis, "structured");
	assert.ok(c.evidence.some((e) => e.includes("content_filter")));
});

test("内容被合规挡下（anthropic refusal）：rawStopReason 是结构化信号", () => {
	const c = classifyUpstreamFailure(
		base({
			stopReason: "error",
			rawStopReason: "refusal",
			transport: [{ kind: "response", origin: "https://api.anthropic.com", statusCode: 200 }],
			errorMessage: "The model refused to complete the request",
		}),
	);
	assert.equal(c.category, "content_blocked");
	assert.equal(c.basis, "structured");
});

test("结构化状态码优先于文案：429 不会被文案里的 connection 带偏", () => {
	const c = classifyUpstreamFailure(
		base({
			transport: [{ kind: "response", origin: "https://opencode.ai", statusCode: 429 }],
			errorMessage: "connection error while rate limiting",
		}),
	);
	assert.equal(c.category, "rate_limited");
	assert.equal(c.basis, "structured");
});

test("诊断里的 error.code=ECONNREFUSED 也算结构化网络证据", () => {
	const c = classifyUpstreamFailure(
		base({
			diagnostics: [{ type: "provider_transport_failure", error: { name: "Error", code: "ECONNREFUSED", message: "connect ECONNREFUSED" } }],
			errorMessage: "Provider returned error",
		}),
	);
	assert.equal(c.category, "network");
	assert.equal(c.basis, "structured");
});

test("没有结构化信号时才用文案兜底，并如实标 basis=text", () => {
	const c = classifyUpstreamFailure(
		base({ errorMessage: "429 Too Many Requests" }),
	);
	assert.equal(c.category, "rate_limited");
	assert.equal(c.basis, "text", "这一条是文案推出来的，必须标明");
});

test("上游改措辞、文案也兜不住 → unknown，且**不**一律重试", () => {
	// 这是这套分类和「只匹配文案」的分水岭：失效是可见的，不是静默退回重试。
	const c = classifyUpstreamFailure(
		base({ errorMessage: "Provider said: zzz-q8-new-wording-2027" }),
	);
	assert.equal(c.category, "unknown");
	assert.equal(c.basis, "none");
	assert.equal(c.verdict, "do_not_retry");
	assert.equal(c.retryable, false, "拿不准不能默认重试，否则又会把候选池烧一遍");
	assert.equal(c.retryWithAnotherCandidate, false);
});

test("没有任何证据也是 unknown，不硬塞", () => {
	const c = classifyUpstreamFailure(base({}));
	assert.equal(c.category, "unknown");
	assert.equal(c.basis, "none");
});

test("处置表自洽：只有「模型不存在」建议换候选；换/等/不重试三类都出得来", () => {
	const cases: { evidence: Partial<FailureEvidence>; category: UpstreamFailureCategory }[] = [
		{ evidence: { modelExists: false }, category: "model_not_found" },
		{ evidence: { authConfigured: false }, category: "credentials" },
		{ evidence: { transport: [{ kind: "response", statusCode: 429 }] }, category: "rate_limited" },
		{ evidence: { transport: [{ kind: "error", errorCode: "ENOTFOUND" }] }, category: "network" },
		{ evidence: { rawStopReason: "content_filter" }, category: "content_blocked" },
		{ evidence: { errorMessage: "something nobody has seen before" }, category: "unknown" },
	];
	const seenVerdicts = new Set<string>();
	for (const { evidence, category } of cases) {
		const c = classifyUpstreamFailure(base(evidence));
		assert.equal(c.category, category);
		seenVerdicts.add(c.verdict);
		const expectSwitch = category === "model_not_found";
		assert.equal(
			c.retryWithAnotherCandidate,
			expectSwitch,
			`${category} 的换候选判定应为 ${expectSwitch}，实际 ${c.retryWithAnotherCandidate}`,
		);
		if (c.retryWithAnotherCandidate) assert.equal(c.retryable, true);
	}
	assert.deepEqual([...seenVerdicts].sort(), ["do_not_retry", "retry_same", "switch_candidate"]);
});

test("withFailure/failureOf：分类能挂在异常上带出去（模型不存在这一条靠它）", () => {
	const failure = classifyUpstreamFailure(base({ modelExists: false }));
	const error = withFailure(new Error("模型不可用"), failure);
	assert.equal(failureOf(error), failure);
	assert.equal(failureOf(new Error("别的错")), undefined);
	assert.equal(failureOf(undefined), undefined);
});
