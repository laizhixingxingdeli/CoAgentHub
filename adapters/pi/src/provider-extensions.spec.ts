/**
 * 共享无密钥声明：SDK/CLI 目录一致，以及原 MCP 启动方式下的只读工具闭包。
 *
 * 跑法：node --import tsx --test src/provider-extensions.spec.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
	registerReviewedExtensions,
	resolveCatalogExtensionPaths,
	resolveProviderExtensionPaths,
} from "./provider-extensions.js";
import { EXCLUDED_EXPANSION_TOOLS } from "./roles.js";
import { WORKER_EXCLUDED_TOOLS } from "./pi-runtime-shared.mjs";

const SECRET = "SECRET_BODY_SHOULD_NOT_LEAK_9f3a";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const adaptersPi = join(repoRoot, "adapters", "pi");

function scratch(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writePackage(dir: string, body: string): void {
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "fake-reviewed", pi: { extensions: ["./src/index.js"] } }),
	);
	writeFileSync(join(dir, "src", "index.js"), body);
}

function providerBody(registrations: Array<{ provider: string; id: string }>, extra = ""): string {
	const calls = registrations
		.map(
			(item) => `pi.registerProvider(${JSON.stringify(item.provider)}, {
        name: ${JSON.stringify(item.provider)},
        baseUrl: "http://127.0.0.1:9",
        apiKey: "probe-not-a-secret",
        api: "openai-completions",
        models: [{
          id: ${JSON.stringify(item.id)},
          name: ${JSON.stringify(item.id)},
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 16
        }]
      });`,
		)
		.join("\n");
	return `export default function (pi) {\n${calls}\n${extra}\n}\n`;
}

function writeConfig(dir: string, value: unknown): string {
	const path = join(dir, "pi-runtime.json");
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}

function runNode(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			if (process.platform === "win32" && child.pid) {
				spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
			} else {
				child.kill();
			}
		}, 90_000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? 1, stdout, stderr });
		});
	});
}

test("同一隔离配置：SDK 与 models CLI 目录一致，显式错误不吞成成功目录", async () => {
	assert.deepEqual([...WORKER_EXCLUDED_TOOLS], [...EXCLUDED_EXPANSION_TOOLS]);
	const root = scratch("piu2-catalog-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const codebuddy = join(root, "codebuddy-pkg");
	const qoder = join(root, "qoder-pkg");
	writePackage(
		codebuddy,
		providerBody([
			{ provider: "codebuddy", id: "fake-flash" },
			{ provider: "codebuddy-intl", id: "fake-intl" },
		]),
	);
	writePackage(
		qoder,
		providerBody([
			{ provider: "qoder", id: "fake-qoder" },
			{ provider: "qoder-cn", id: "fake-qoder-cn" },
		]),
	);
	const configPath = writeConfig(root, {
		version: 1,
		extensions: {
			codebuddy: { packageDir: codebuddy },
			qoder: { packageDir: qoder },
		},
	});
	const previousConfig = process.env.COAGENT_PI_RUNTIME_CONFIG;
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.COAGENT_PI_RUNTIME_CONFIG = configPath;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const env = { ...process.env };
	const link = join(root, "junction-alias");
	try {
		assert.equal(resolveProviderExtensionPaths("codebuddy-intl").length, 1);
		assert.equal(resolveProviderExtensionPaths("qoder").length, 1);
		assert.deepEqual(resolveProviderExtensionPaths("openai"), []);
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			refreshOnCreate: false,
			authPath: join(agentDir, "auth.json"),
		});
		assert.equal(runtime.getModels().some((model) => model.provider === "openai"), true);
		await registerReviewedExtensions(runtime, {
			cwd,
			agentDir,
			extensionPaths: resolveCatalogExtensionPaths(),
			expectCatalog: true,
		});
		assert.equal(runtime.getModels().some((model) => model.provider === "openai"), true);
		const sdkRows = (await runtime.getAvailable())
			.map((model) => ({ provider: model.provider, model: model.id, label: `${model.provider}/${model.id}` }))
			.sort((a, b) => a.label.localeCompare(b.label));
		for (const label of ["codebuddy/fake-flash", "codebuddy-intl/fake-intl", "qoder/fake-qoder", "qoder-cn/fake-qoder-cn"]) {
			assert.equal(sdkRows.some((row) => row.label === label), true, label);
		}

		const cli = await runNode(
			["--import", "tsx", join(adaptersPi, "src", "cli.ts"), "models"],
			env,
			repoRoot,
		);
		assert.equal(cli.code, 0, cli.stderr);
		const cliRows = JSON.parse(cli.stdout) as Array<{ label: string }>;
		assert.equal(Array.isArray(cliRows), true);
		assert.deepEqual(
			cliRows.map((row) => row.label).sort(),
			sdkRows.map((row) => row.label).sort(),
		);

		symlinkSync(adaptersPi, link, "junction");
		assert.equal(lstatSync(link).isSymbolicLink(), true);
		const listed = await runNode(
			[join(link, "bin", "pi-cli-shim.mjs"), "--list-models", "--offline"],
			env,
			cwd,
		);
		const combined = `${listed.stdout}\n${listed.stderr}`;
		assert.equal(listed.code, 0, combined);
		assert.match(combined, /fake-flash/);
		assert.match(combined, /fake-qoder/);
		assert.doesNotMatch(combined, /AppData[\\/]+Roaming[\\/]+npm/i);

		const badJson = writeConfig(root, `{\n  "version": 1\n}\n${SECRET}\n`);
		const bad = await runNode(
			["--import", "tsx", join(adaptersPi, "src", "cli.ts"), "models"],
			{ ...env, COAGENT_PI_RUNTIME_CONFIG: badJson },
			repoRoot,
		);
		assert.notEqual(bad.code, 0);
		assert.equal(bad.stdout.trim().startsWith("["), false);
		assert.match(bad.stdout, /pi-runtime 配置非法/);
		assert.equal(bad.stdout.includes(SECRET), false);
		assert.equal(bad.stderr.includes(SECRET), false);

		const missingPkg = join(root, "missing-pkg");
		const badPath = writeConfig(root, {
			version: 1,
			extensions: { codebuddy: { packageDir: missingPkg } },
		});
		const pathError = await runNode(
			["--import", "tsx", join(adaptersPi, "src", "cli.ts"), "models"],
			{ ...env, COAGENT_PI_RUNTIME_CONFIG: badPath },
			repoRoot,
		);
		assert.notEqual(pathError.code, 0);
		assert.match(`${pathError.stdout}\n${pathError.stderr}`, /pi-runtime 路径无效/);
		assert.equal(`${pathError.stdout}\n${pathError.stderr}`.includes(SECRET), false);

		const wrong = join(root, "wrong-pkg");
		writePackage(wrong, `const secret = ${JSON.stringify(SECRET)};\nexport default function () {\n  void secret;\n}\n`);
		const wrongConfig = writeConfig(root, {
			version: 1,
			extensions: { codebuddy: { packageDir: wrong } },
		});
		const unregistered = await runNode(
			["--import", "tsx", join(adaptersPi, "src", "cli.ts"), "models"],
			{ ...env, COAGENT_PI_RUNTIME_CONFIG: wrongConfig },
			repoRoot,
		);
		assert.notEqual(unregistered.code, 0);
		assert.match(`${unregistered.stdout}\n${unregistered.stderr}`, /pi-runtime 目标 provider 未注册：codebuddy/);
		assert.equal(`${unregistered.stdout}\n${unregistered.stderr}`.includes(SECRET), false);
	} finally {
		if (previousConfig === undefined) delete process.env.COAGENT_PI_RUNTIME_CONFIG;
		else process.env.COAGENT_PI_RUNTIME_CONFIG = previousConfig;
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
		if (existsSync(link)) rmdirSync(link);
		if (!existsSync(link)) rmSync(root, { recursive: true, force: true });
	}
});

test("原 MCP 启动方式经 junction 薄启动器拉起仓库 1.3.0，只读最终工具闭包不是 argv", async () => {
	const root = scratch("piu2-mcp-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "skills", "evil"), { recursive: true });
	writeFileSync(join(cwd, "AGENTS.md"), "HOSTILE_CONTEXT_MARKER\n");
	writeFileSync(join(cwd, ".pi", "skills", "evil", "SKILL.md"), "hostile-skill-marker\n");
	writeFileSync(
		join(cwd, ".pi", "extensions", "project-evil.js"),
		"import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./hostile-loaded.txt', import.meta.url), 'loaded');\nexport default function (pi) { pi.registerTool({ name: 'project_evil', description: 'no', parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: 'no' }] }; } }); }\n",
	);
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			extensions: ["builtin:mcp", "builtin:codemode", "builtin:tool-search", "builtin:llama.cpp", "./extensions/project-evil.js"],
		}),
	);
	const closureFile = join(root, "closure.json");
	const spawnRecord = join(root, "spawn.json");
	const pkg = join(root, "codebuddy-pkg");
	writePackage(
		pkg,
		providerBody(
			[
				{ provider: "codebuddy-intl", id: "deepseek-v4.1-flash" },
				{ provider: "codebuddy", id: "deepseek-v4.1-flash" },
			],
			`for (const name of ["mcp__evil__ping", "codemode", "tool_search", "project_evil"]) {
        pi.registerTool({
          name,
          description: name,
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: name }] }; },
        });
      }
      pi.on("before_agent_start", async (event) => {
        const { writeFileSync } = await import("node:fs");
        const target = process.env.PI_WORKER_CLOSURE_FILE;
        try {
          const all = pi.getAllTools();
          const active = pi.getActiveTools();
          const activeSet = new Set(active);
          const callable = all.filter((tool) => {
            const exposure = tool.exposure ?? "direct";
            if (exposure === "codemode" || exposure === "deferred") return true;
            return activeSet.has(tool.name);
          }).map((tool) => tool.name);
          const prompt = String(event?.systemPrompt ?? "");
          writeFileSync(target, JSON.stringify({
            active,
            callable,
            all: all.map((tool) => tool.name),
            promptHasHostile: prompt.includes("HOSTILE_CONTEXT_MARKER"),
            promptHasSkill: prompt.includes("hostile-skill-marker"),
          }));
        } catch (error) {
          writeFileSync(target, JSON.stringify({ error: String(error) }));
        }
      });`,
		),
	);
	const configPath = writeConfig(root, {
		version: 1,
		extensions: { codebuddy: { packageDir: pkg } },
	});
	const stub = join(root, "server-stub.mjs");
	writeFileSync(
		stub,
		`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = [process.env.PI_CLI_JS, "-p", "--no-session", "--model", process.env.PI_WORKER_DEFAULT_MODEL, "--tools", "read,grep,find,ls", "ping"];
writeFileSync(process.env.PI_WORKER_SPAWN_RECORD, JSON.stringify({
  execArgv: process.execArgv,
  args,
  defaultModel: process.env.PI_WORKER_DEFAULT_MODEL,
  fallbackModel: process.env.PI_WORKER_FALLBACK_MODEL,
}));
const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => { console.error(error.message); process.exit(1); });
`,
	);
	const link = join(root, "junction-alias");
	symlinkSync(adaptersPi, link, "junction");
	const env = {
		...process.env,
		COAGENT_PI_RUNTIME_CONFIG: configPath,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WORKER_CLOSURE_FILE: closureFile,
		PI_WORKER_SPAWN_RECORD: spawnRecord,
	};
	try {
		const child = spawn(process.execPath, [join(link, "bin", "pi-worker-mcp.mjs"), "--server", stub], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.stdout.on("data", () => {});
		const found = await new Promise<boolean>((resolveFound) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearInterval(timer);
				clearTimeout(limit);
				resolveFound(value);
			};
			const timer = setInterval(() => {
				if (existsSync(closureFile)) finish(true);
			}, 200);
			child.on("exit", () => {
				setTimeout(() => finish(existsSync(closureFile)), 300);
			});
			const limit = setTimeout(() => finish(existsSync(closureFile)), 70_000);
		});
		if (child.pid && child.exitCode === null) {
			spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
		}
		assert.equal(found, true, stderr);
		const closure = JSON.parse(readFileSync(closureFile, "utf8")) as {
			active: string[];
			callable: string[];
			all: string[];
			promptHasHostile: boolean;
			promptHasSkill: boolean;
		};
		const four = ["find", "grep", "ls", "read"];
		assert.deepEqual([...closure.active].sort(), four);
		assert.deepEqual([...closure.callable].sort(), four);
		assert.deepEqual([...closure.all].sort(), four);
		assert.equal(closure.promptHasHostile, false);
		assert.equal(closure.promptHasSkill, false);
		assert.equal(existsSync(join(cwd, ".pi", "extensions", "hostile-loaded.txt")), false);
		const record = JSON.parse(readFileSync(spawnRecord, "utf8")) as {
			execArgv: string[];
			args: string[];
			defaultModel: string;
			fallbackModel: string;
		};
		assert.deepEqual(record.execArgv, []);
		assert.equal(record.args.includes("--import"), false);
		assert.equal(record.args[1], "-p");
		assert.equal(record.args[2], "--no-session");
		assert.deepEqual(record.args.slice(5, 7), ["--tools", "read,grep,find,ls"]);
		assert.equal(record.defaultModel, "codebuddy-intl/deepseek-v4.1-flash");
		assert.equal(record.fallbackModel, "codebuddy/deepseek-v4.1-flash");
		assert.match(stderr, /version=1\.3\.0/);
		assert.doesNotMatch(stderr, /AppData[\\/]+Roaming[\\/]+npm/i);
		const cliLine = stderr.split(/\r?\n/).find((line) => line.startsWith("pi-runtime shim cli="));
		assert.ok(cliLine, stderr);
		const cliPath = cliLine.slice("pi-runtime shim cli=".length).replace(/ version=1\.3\.0$/, "");
		const pkgJson = JSON.parse(readFileSync(join(dirname(cliPath), "..", "..", "package.json"), "utf8")) as { version?: string };
		assert.equal(pkgJson.version, "1.3.0");
	} finally {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
		try {
			if (existsSync(link)) rmdirSync(link);
			if (!existsSync(link)) rmSync(root, { recursive: true, force: true });
		} catch {
			// Windows 上子进程刚退出时目录可能仍被占用。断言已经完成，清理失败不能盖住它。
		}
	}
});
