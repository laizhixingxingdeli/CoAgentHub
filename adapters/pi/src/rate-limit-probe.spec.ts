/**
 * src/rate-limit-probe.ts 的测试：node:test + tsx，假 fetch 注入，不碰网络与模型。
 *
 * 跑法：node --import tsx --test src/rate-limit-probe.spec.ts
 *
 * 锁的是 PI-RL0 的关键一条：收到 429 之后，失败信息里能读出限流头的值
 * （hy4 被限流时平台要知道等到几点）。同时顺带锁住「替换 globalThis.fetch
 * 仍被观察」——pi 起来后 undici.install() 会换 fetch，直接赋值包装会被盖掉。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendRateLimitSummary, startRateLimitProbe } from "./rate-limit-probe.js";

test("429 且带 retry-after：头名与限流头的值进失败信息；摘掉包装后 fetch 还原", async () => {
	const original = globalThis.fetch;
	// 假 fetch：不产生任何网络活动，只交回一个 429 响应。
	const fake = (async () => ({
		status: 429,
		headers: new Headers({ "retry-after": "30", "content-type": "application/json" }),
	})) as unknown as typeof fetch;

	const probe = startRateLimitProbe();
	try {
		// 装完观察器之后**替换** fetch：setter 必须把新来的再包一层，否则
		// undici.install() 那一次替换就让采集整个失效。
		globalThis.fetch = fake;

		const response = await globalThis.fetch("https://example.invalid/v1/messages");
		assert.equal(response.status, 429, "响应原样返回，观察器不改它");

		const message = appendRateLimitSummary("HTTP 429：限流", probe.summary());
		assert.match(message, /retry-after=30/, "限流头的值要出现在失败信息里");
		assert.match(message, /^HTTP 429：限流（429 响应头：.*retry-after.*；限流相关：retry-after=30）/);
		assert.equal(
			appendRateLimitSummary("HTTP 500", undefined),
			"HTTP 500",
			"没收到 429 时失败信息一字不改",
		);
	} finally {
		probe.stop();
	}
	assert.equal(globalThis.fetch, fake, "stop() 之后只剩没被包装的那一个 fetch");
	globalThis.fetch = original;

	// Attempt 隔离：新观察器看不到上一次的 429。
	const second = startRateLimitProbe();
	try {
		assert.equal(second.summary(), undefined);
	} finally {
		second.stop();
	}
});
