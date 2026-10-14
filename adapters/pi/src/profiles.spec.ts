/**
 * prompt 通道判定纯函数 + runtime 传参合同。
 * 不连网、不启 session：只读 runtime.ts 源码验证装配处真的把结果带进去了。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePromptChannel } from "./profiles.js";

test("resolvePromptChannel：显式覆盖优先，未覆盖时仅 tenrouter + qdc//qd//cbai/ 为 user；runtime 把结果传进 extension", () => {
	const facts = (...pairs: readonly (readonly [string, string])[]) =>
		pairs.map(([key, value]) => ({ key, value }));

	// 无 facts：缺省 system。
	assert.equal(resolvePromptChannel(undefined), "system");
	assert.equal(resolvePromptChannel([]), "system");

	// 显式覆盖优先于 provider/model 前缀。
	assert.equal(
		resolvePromptChannel(facts(["prompt_channel", "user"], ["provider", "xai"])),
		"user",
	);
	assert.equal(
		resolvePromptChannel(
			facts(["prompt_channel", "system"], ["provider", "tenrouter"], ["model", "qdc/x"]),
		),
		"system",
	);

	// 大小写不对不算覆盖，落回前缀判定。
	assert.equal(
		resolvePromptChannel(
			facts(["prompt_channel", "User"], ["provider", "tenrouter"], ["model", "qdc/x"]),
		),
		"user",
	);

	// 前缀命中：qdc/、qd/、cbai/ 都是 user。
	assert.equal(
		resolvePromptChannel(facts(["provider", "tenrouter"], ["model", "qdc/x"])),
		"user",
	);
	assert.equal(
		resolvePromptChannel(facts(["provider", "tenrouter"], ["model", "qd/x"])),
		"user",
	);
	assert.equal(
		resolvePromptChannel(facts(["provider", "tenrouter"], ["model", "cbai/x"])),
		"user",
	);

	// cbcn/ 不在前缀清单里；qdx 没斜杠，不是 qd/ 的简写。
	assert.equal(
		resolvePromptChannel(facts(["provider", "tenrouter"], ["model", "cbcn/x"])),
		"system",
	);
	assert.equal(
		resolvePromptChannel(facts(["provider", "tenrouter"], ["model", "qdx"])),
		"system",
	);

	// provider 不是 tenrouter（或缺 model），前缀再像也是 system。
	assert.equal(
		resolvePromptChannel(facts(["provider", "xai"], ["model", "qdc/x"])),
		"system",
	);

	const runtimeSrc = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "runtime.ts"),
		"utf8",
	);
	assert.match(runtimeSrc, /promptChannel:\s*resolvePromptChannel\(spec\.profile\.facts\)/);
	assert.match(runtimeSrc, /createCoagentExtension\(\{[\s\S]*role:\s*spec\.role/);
});
