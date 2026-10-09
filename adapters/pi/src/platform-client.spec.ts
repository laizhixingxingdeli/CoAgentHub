/**
 * PlatformClient 合同：Run Token 走 /api/agent/<工具名>，body 不含身份字段。
 * HTTP 替身，不连真实平台。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PlatformClient } from "./platform-client.js";

type FetchCall = { url: string; init?: RequestInit };

function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
	const seen: FetchCall[] = [];
	const orig = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		seen.push({ url, init });
		return handler(url, init);
	}) as typeof fetch;
	return {
		seen,
		restore() {
			globalThis.fetch = orig;
		},
	};
}

test("call 带 Run Token 打到 /api/agent/<工具名>，请求体不含身份字段", async () => {
	const { seen, restore } = installFetch(async () => {
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	try {
		const client = new PlatformClient("http://hub.example/", "run-token-1");
		const result = await client.call("coagent_submit_independent_review", {
			verdict: "pass",
			reasons: ["齐"],
		});
		assert.equal(result.ok, true);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.url, "http://hub.example/api/agent/coagent_submit_independent_review");
		assert.equal(seen[0]?.init?.method, "POST");
		const headers = seen[0]?.init?.headers as Record<string, string>;
		assert.equal(headers["x-coagent-run"], "run-token-1");
		const body = JSON.parse(String(seen[0]?.init?.body ?? "{}")) as Record<string, unknown>;
		assert.equal("role" in body, false);
		assert.equal("missionId" in body, false);
		assert.equal("attemptId" in body, false);
		assert.equal("workItemId" in body, false);
		assert.equal(body.verdict, "pass");
		assert.deepEqual(body.reasons, ["齐"]);
	} finally {
		restore();
	}
});

test("call 读 bundle 同样带 Run Token、body 无身份字段", async () => {
	const { seen, restore } = installFetch(async () => {
		return new Response(JSON.stringify({ contractRevision: 1 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	try {
		const client = new PlatformClient("http://hub.example", "tok");
		const result = await client.call("coagent_get_mission_review_bundle", {});
		assert.equal(result.ok, true);
		assert.equal(seen[0]?.url, "http://hub.example/api/agent/coagent_get_mission_review_bundle");
		const headers = seen[0]?.init?.headers as Record<string, string>;
		assert.equal(headers["x-coagent-run"], "tok");
		assert.equal(seen[0]?.init?.body, "{}");
	} finally {
		restore();
	}
});

test("非 2xx 时 call 返回 ok=false", async () => {
	const { restore } = installFetch(async () => {
		return new Response(JSON.stringify({ message: "nope" }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	});
	try {
		const client = new PlatformClient("http://hub.example", "tok");
		const result = await client.call("coagent_submit_independent_review", {
			verdict: "pass",
			reasons: ["齐"],
		});
		assert.equal(result.ok, false);
		assert.equal(client.sawUnreachable, false);
	} finally {
		restore();
	}
});

test("网络错误时 call 返回 ok=false 且记 unreachable", async () => {
	const { restore } = installFetch(async () => {
		throw new Error("ECONNREFUSED");
	});
	try {
		const client = new PlatformClient("http://hub.example", "tok");
		const result = await client.call("coagent_get_mission_review_bundle", {});
		assert.equal(result.ok, false);
		assert.equal(client.sawUnreachable, true);
	} finally {
		restore();
	}
});
