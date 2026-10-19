/**
 * 结束判定 / 诊断投影的两条综合验收。
 *
 * 1) 四态矩阵走生产接缝 `projectFailureOutcome`：双故障（平台不可达 + 上游配额）、
 *    纯平台、纯上游、成功。断言 `endedBy` 的选择与历史三元链逐字一致（平台不可达
 *    仍优先），而 `upstreamFailure` / `runtimeDiagnostics` 独立于 `endedBy`；
 *    纯平台故障**不得**凭空产出 quota/限流一类结论。
 * 2) 诊断文案：走生产脱敏器（共享传输的 `captureValue`），断言 URL userinfo /
 *    代理地址 / token 不出现在 outcome 的可序列化形态里，且有界截断。
 *
 * 另外用源码合同钉住「runtime 真的用了这条接缝」——纯函数的单测再漂亮，只要
 * startRun 还在自己拼三元链，这件事就没修。
 *
 * 不启真实 session、不连网、不读凭据、不跑真实模型。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { UpstreamFailureClassification } from "./failure-classify.js";
import {
	RUNTIME_DIAGNOSTIC_MESSAGE_MAX_CHARS,
	projectFailureOutcome,
	runtimeDiagnosticRedactor,
	selectEndedBy,
} from "./failure-outcome.js";

const runtimeSrc = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "runtime.ts"),
	"utf8",
);

const quota: UpstreamFailureClassification = {
	category: "quota_exhausted",
	verdict: "do_not_retry",
	retryable: false,
	retryWithAnotherCandidate: false,
	basis: "structured",
	reason: "HTTP 402：配额/账单耗尽",
	evidence: ["undici:headers status=402"],
};

const rateLimited: UpstreamFailureClassification = {
	category: "rate_limited",
	verdict: "retry_same",
	retryable: true,
	retryWithAnotherCandidate: false,
	basis: "structured",
	reason: "HTTP 429：限流",
	evidence: ["undici:headers status=429"],
};

const QUOTA_TEXT = "402 insufficient_quota: you exceeded your current quota";

test("综合 1：四态矩阵——双故障仍报上游分类，纯平台不造假，纯上游/成功不变", () => {
	// ① 双故障：平台不可达 + assistant 报了配额。endedBy 仍是 platform_unreachable
	//    （调度语义不变），但上游证据必须一起报出去。
	const both = projectFailureOutcome({
		platformUnreachable: true,
		submitted: false,
		failureMessage: QUOTA_TEXT,
		upstreamFailure: quota,
		upstreamMessage: QUOTA_TEXT,
		redact: (text) => text,
	});
	assert.equal(both.endedBy, "platform_unreachable");
	assert.deepEqual(both.upstreamFailure, quota, "平台故障不得遮住已有上游证据");
	assert.deepEqual(both.runtimeDiagnostics, {
		platform: { code: "platform_unreachable" },
		upstream: { category: "quota_exhausted", message: QUOTA_TEXT },
	});

	// ② 纯平台故障：没有任何上游证据。不得出现 upstreamFailure，也不得凭平台故障
	//    编出 quota / 限流一类结论。
	const platformOnly = projectFailureOutcome({
		platformUnreachable: true,
		submitted: false,
		redact: (text) => text,
	});
	assert.equal(platformOnly.endedBy, "platform_unreachable");
	assert.equal(platformOnly.upstreamFailure, undefined);
	assert.deepEqual(platformOnly.runtimeDiagnostics, {
		platform: { code: "platform_unreachable" },
	});
	assert.doesNotMatch(JSON.stringify(platformOnly), /quota|rate_limited|credentials|model_not_found/);

	// ③ 纯上游失败：endedBy 与分类都与改动前一致。
	const upstreamOnly = projectFailureOutcome({
		platformUnreachable: false,
		submitted: false,
		failureMessage: "429 Too Many Requests",
		upstreamFailure: rateLimited,
		upstreamMessage: "429 Too Many Requests",
		redact: (text) => text,
	});
	assert.equal(upstreamOnly.endedBy, "upstream_failure");
	assert.deepEqual(upstreamOnly.upstreamFailure, rateLimited);
	assert.deepEqual(upstreamOnly.runtimeDiagnostics, {
		upstream: { category: "rate_limited", message: "429 Too Many Requests" },
	});

	// ④ 成功：结构化提交，没有任何诊断字段（纯增字段，成功路径一个都不多）。
	const success = projectFailureOutcome({
		platformUnreachable: false,
		submitted: true,
		redact: (text) => text,
	});
	assert.deepEqual(success, { endedBy: "structured_submit" });

	// ⑤ 跑完没提交（提醒路径的常态）：endedBy 仍是 no_structured_result，无诊断。
	const noResult = projectFailureOutcome({
		platformUnreachable: false,
		submitted: false,
		redact: (text) => text,
	});
	assert.deepEqual(noResult, { endedBy: "no_structured_result" });

	// 结束判定的优先级逐条钉住：平台不可达 > 已提交 > 有失败 > 没提交。
	assert.equal(selectEndedBy({ platformUnreachable: true, submitted: true }), "platform_unreachable");
	assert.equal(
		selectEndedBy({ platformUnreachable: true, submitted: false, failureMessage: "x" }),
		"platform_unreachable",
	);
	assert.equal(selectEndedBy({ platformUnreachable: false, submitted: true, failureMessage: "x" }), "structured_submit");
	assert.equal(selectEndedBy({ platformUnreachable: false, submitted: false, failureMessage: "x" }), "upstream_failure");
	assert.equal(selectEndedBy({ platformUnreachable: false, submitted: false }), "no_structured_result");

	// 源码合同：startRun 必须经这条接缝得出结论，而不是自己拼三元链 + 用 endedBy 门控分类。
	assert.match(runtimeSrc, /import \{\s*projectFailureOutcome,/);
	assert.match(runtimeSrc, /const projection = projectFailureOutcome\(\{/);
	assert.match(runtimeSrc, /platformUnreachable:\s*!!client\?\.sawUnreachable/);
	assert.match(runtimeSrc, /const endedBy = projection\.endedBy;/);
	assert.match(runtimeSrc, /upstreamFailure:\s*projection\.upstreamFailure,/);
	assert.match(runtimeSrc, /runtimeDiagnostics:\s*projection\.runtimeDiagnostics/);
	// 上游分类只以「有没有真实上游证据」为条件：不再被 endedBy 门控。
	assert.match(runtimeSrc, /const upstreamFailure = failureMessage\s*\?/);
	assert.doesNotMatch(runtimeSrc, /endedBy === "upstream_failure" && failureMessage\s*\n?\s*\?/);
});

test("综合 2：诊断文案经生产脱敏器——无 userinfo/代理/token，且有界截断", () => {
	// 合成哨兵，不对应任何真实凭据。
	const USERINFO = "leaky-user:hunter2-proxy-pass";
	const PROXY_HOST = "10.23.45.67:7890";
	const BEARER = "Bearer abcdefghijklmnopqrstuvwxyz012345";
	const RUN_TOKEN = "token=run-9f8e7d6c5b4a39281706";
	const API_KEY = "sk-live-9f8e7d6c5b4a39281706";
	const message = [
		`POST https://${USERINFO}@api.example.test/v1/chat failed`,
		`proxy=http://${PROXY_HOST}`,
		BEARER,
		RUN_TOKEN,
		API_KEY,
		"402 insufficient_quota",
		"x".repeat(RUNTIME_DIAGNOSTIC_MESSAGE_MAX_CHARS * 4),
	].join(" ");

	const redact = runtimeDiagnosticRedactor();
	assert.equal(typeof redact, "function", "生产脱敏器必须能加载共享传输实现");

	const projection = projectFailureOutcome({
		platformUnreachable: true,
		submitted: false,
		failureMessage: message,
		upstreamFailure: quota,
		upstreamMessage: message,
		redact,
	});

	// 双故障下诊断两侧都在，上游类别如实是 quota（真实证据），平台侧只报不可达。
	assert.equal(projection.endedBy, "platform_unreachable");
	assert.equal(projection.upstreamFailure?.category, "quota_exhausted");
	assert.equal(projection.runtimeDiagnostics?.platform?.code, "platform_unreachable");
	assert.equal(projection.runtimeDiagnostics?.upstream?.category, "quota_exhausted");

	const diagnostic = projection.runtimeDiagnostics?.upstream?.message;
	assert.equal(typeof diagnostic, "string");
	assert.ok(diagnostic!.length <= RUNTIME_DIAGNOSTIC_MESSAGE_MAX_CHARS, "诊断文案必须有界");
	assert.ok(diagnostic!.endsWith("…"), "被截断时要留下截断标记");

	// 整个可外发形态里都不许出现这些哨兵。
	const serialized = JSON.stringify(projection);
	for (const secret of [USERINFO, PROXY_HOST, BEARER, RUN_TOKEN, API_KEY, "hunter2-proxy-pass"]) {
		assert.equal(serialized.includes(secret), false, `诊断不得泄露 ${secret}`);
	}
	// 截断之后的尾巴也必须已脱敏：不能出现「先截断再脱敏」漏出来的半截凭据。
	assert.doesNotMatch(diagnostic!, /hunter2|10\.23\.45\.67|abcdefghijklmnopqrstuvwxyz|run-9f8e7d6c/);
	assert.match(diagnostic!, /insufficient_quota/, "脱敏不该抹掉可判定的失败事实");

	// 没有脱敏实现时不带文案（宁可少一句诊断，也不发原文）。
	const noRedactor = projectFailureOutcome({
		platformUnreachable: false,
		submitted: false,
		failureMessage: message,
		upstreamFailure: quota,
		upstreamMessage: message,
	});
	assert.equal(noRedactor.upstreamFailure?.category, "quota_exhausted");
	assert.deepEqual(noRedactor.runtimeDiagnostics, { upstream: { category: "quota_exhausted" } });

	// 脱敏器抛错同样不带文案，且分类仍如实报出——诊断失败不改变结束判定。
	const throwing = projectFailureOutcome({
		platformUnreachable: true,
		submitted: false,
		failureMessage: message,
		upstreamFailure: quota,
		upstreamMessage: message,
		redact: () => {
			throw new Error("redactor exploded");
		},
	});
	assert.equal(throwing.endedBy, "platform_unreachable");
	assert.equal(throwing.upstreamFailure?.category, "quota_exhausted");
	assert.deepEqual(throwing.runtimeDiagnostics, {
		platform: { code: "platform_unreachable" },
		upstream: { category: "quota_exhausted" },
	});

	// 平台工具 error 不是模型错误：runtime 只在 assistant errorMessage / prompt() 抛出时
	// 才给 failureMessage，平台不可达只走 client.sawUnreachable。
	assert.match(runtimeSrc, /platformUnreachable:\s*!!client\?\.sawUnreachable/);
	assert.match(runtimeSrc, /failureMessage = m\.errorMessage;/);
	assert.match(runtimeSrc, /failureMessage = e instanceof Error \? e\.message : String\(e\);/);
});
