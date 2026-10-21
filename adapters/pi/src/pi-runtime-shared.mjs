/**
 * 平台 SDK 与独立 Pi CLI / MCP 薄启动器共用的无密钥声明。
 *
 * 不读 auth/models/settings：那些文件里有凭据和代理，诊断若带上正文就会写进日志。
 * 旧的 getAgentDir()/npm/node_modules/pi-codebuddy-oauth 已过时；再回落到它或 global npm，
 * 会把「没装上 1.3.0 / 没声明审核包」伪装成空目录成功。
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_REQUIRED_VERSION = "1.3.0";
export const CONFIG_ENV = "COAGENT_PI_RUNTIME_CONFIG";
export const WORKER_DEFAULT_MODEL = "codebuddy-intl/deepseek-v4.1-flash";
export const WORKER_FALLBACK_MODEL = "codebuddy/deepseek-v4.1-flash";

/** 与 roles.ts 的 EXCLUDED_EXPANSION_TOOLS 保持一致。普通 --tools 挡不住这些名字。 */
export const WORKER_EXCLUDED_TOOLS = [
	"mcp__*",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
	"codemode",
	"tool_search",
];

export const REVIEWED_PAIRS = {
	codebuddy: ["codebuddy", "codebuddy-intl"],
	qoder: ["qoder", "qoder-cn"],
};

const BANNED_KEYS = new Set([
	"auth",
	"models",
	"settings",
	"apiKey",
	"apiKeys",
	"credentials",
	"token",
	"tokens",
	"accounts",
	"proxy",
	"httpProxy",
]);

const EXTRA_TOOL_ENTRY = /(^|[\\/])[^\\/]*(search|image|vision|imagen)[^\\/]*$/i;

export class PiRuntimeConfigError extends Error {
	constructor(message) {
		super(message);
		this.name = "PiRuntimeConfigError";
	}
}

export function defaultConfigPath(home = homedir()) {
	return join(home, ".coagent", "pi-runtime.json");
}

export function resolveConfigLocation(env = process.env, home = homedir()) {
	const override = env[CONFIG_ENV];
	if (override !== undefined && override !== "") {
		return { path: override, explicit: true };
	}
	return { path: defaultConfigPath(home), explicit: false };
}

function invalid(path, field) {
	return new PiRuntimeConfigError(`pi-runtime 配置非法：${path} 字段 ${field}`);
}

function banned(path, field) {
	return new PiRuntimeConfigError(`pi-runtime 配置非法：${path} 不允许字段 ${field}`);
}

export function loadPiRuntimeConfig(env = process.env, home = homedir()) {
	const location = resolveConfigLocation(env, home);
	if (!existsSync(location.path)) {
		if (location.explicit) {
			return {
				ok: false,
				missing: true,
				path: location.path,
				error: new PiRuntimeConfigError(`pi-runtime 配置缺失：${location.path}`),
			};
		}
		return { ok: true, missing: true, path: location.path, config: null };
	}
	let st;
	try {
		st = statSync(location.path);
	} catch {
		return {
			ok: false,
			missing: false,
			path: location.path,
			error: new PiRuntimeConfigError(`pi-runtime 路径无效：${location.path}`),
		};
	}
	if (!st.isFile()) {
		return {
			ok: false,
			missing: false,
			path: location.path,
			error: new PiRuntimeConfigError(`pi-runtime 路径无效：${location.path}`),
		};
	}
	let text;
	try {
		text = readFileSync(location.path, "utf8");
	} catch {
		return {
			ok: false,
			missing: false,
			path: location.path,
			error: new PiRuntimeConfigError(`pi-runtime 路径无效：${location.path}`),
		};
	}
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		return {
			ok: false,
			missing: false,
			path: location.path,
			error: new PiRuntimeConfigError(`pi-runtime 配置非法：${location.path} 不是 JSON`),
		};
	}
	try {
		const config = validateConfig(json, location.path);
		return { ok: true, missing: false, path: location.path, config };
	} catch (error) {
		return {
			ok: false,
			missing: false,
			path: location.path,
			error: error instanceof PiRuntimeConfigError ? error : new PiRuntimeConfigError(`pi-runtime 配置非法：${location.path}`),
		};
	}
}

function validateConfig(json, path) {
	if (json === null || typeof json !== "object" || Array.isArray(json)) {
		throw invalid(path, "根");
	}
	for (const key of Object.keys(json)) {
		if (BANNED_KEYS.has(key)) throw banned(path, key);
		if (key !== "version" && key !== "extensions" && key !== "worker") throw invalid(path, key);
	}
	if (json.version !== 1) throw invalid(path, "version");
	const extensions = json.extensions === undefined ? {} : json.extensions;
	if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions)) {
		throw invalid(path, "extensions");
	}
	for (const key of Object.keys(extensions)) {
		if (BANNED_KEYS.has(key)) throw banned(path, `extensions.${key}`);
		if (key !== "codebuddy" && key !== "qoder" && key !== "antigravity") {
			throw invalid(path, `extensions.${key}`);
		}
	}
	const sources = {};
	for (const source of ["codebuddy", "qoder"]) {
		const entry = extensions[source];
		if (entry === undefined) continue;
		sources[source] = readPackageDir(entry, path, `extensions.${source}`);
	}
	let antigravity;
	if (extensions.antigravity !== undefined) {
		const entry = extensions.antigravity;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw invalid(path, "extensions.antigravity");
		}
		for (const key of Object.keys(entry)) {
			if (key !== "packageDir" && key !== "providerId") throw invalid(path, `extensions.antigravity.${key}`);
		}
		if (typeof entry.packageDir !== "string" || entry.packageDir.trim() === "" || !isAbsolute(entry.packageDir)) {
			throw invalid(path, "extensions.antigravity.packageDir");
		}
		if (typeof entry.providerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.providerId)) {
			throw invalid(path, "extensions.antigravity.providerId");
		}
		antigravity = { packageDir: entry.packageDir, providerId: entry.providerId };
	}
	let worker = { defaultModel: WORKER_DEFAULT_MODEL, fallbackModel: WORKER_FALLBACK_MODEL };
	if (json.worker !== undefined) {
		if (json.worker === null || typeof json.worker !== "object" || Array.isArray(json.worker)) {
			throw invalid(path, "worker");
		}
		for (const key of Object.keys(json.worker)) {
			if (BANNED_KEYS.has(key)) throw banned(path, `worker.${key}`);
			if (key !== "defaultModel" && key !== "fallbackModel") throw invalid(path, `worker.${key}`);
		}
		worker = {
			defaultModel: readModelRef(json.worker.defaultModel, path, "worker.defaultModel"),
			fallbackModel: readModelRef(json.worker.fallbackModel, path, "worker.fallbackModel"),
		};
	}
	return { version: 1, path, sources, antigravity, worker };
}

function readPackageDir(entry, path, field) {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw invalid(path, field);
	for (const key of Object.keys(entry)) {
		if (key !== "packageDir") throw invalid(path, `${field}.${key}`);
	}
	if (typeof entry.packageDir !== "string" || entry.packageDir.trim() === "") {
		throw invalid(path, `${field}.packageDir`);
	}
	if (!isAbsolute(entry.packageDir)) throw invalid(path, `${field}.packageDir`);
	return { packageDir: entry.packageDir };
}

function readModelRef(value, path, field) {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/]+$/.test(value)) {
		throw invalid(path, field);
	}
	return value;
}

export function workerModels(env = process.env) {
	const loaded = loadPiRuntimeConfig(env);
	if (!loaded.ok) throw loaded.error;
	if (loaded.missing || !loaded.config) {
		return { defaultModel: WORKER_DEFAULT_MODEL, fallbackModel: WORKER_FALLBACK_MODEL };
	}
	return loaded.config.worker;
}

function sourceForProvider(config, provider) {
	for (const [source, providers] of Object.entries(REVIEWED_PAIRS)) {
		if (providers.includes(provider)) return source;
	}
	if (config?.antigravity && config.antigravity.providerId === provider) return "antigravity";
	return undefined;
}

export function isReviewedProviderName(provider, config) {
	if (Object.values(REVIEWED_PAIRS).some((providers) => providers.includes(provider))) return true;
	return config?.antigravity?.providerId === provider;
}

export function expectedProviderIds(config) {
	if (!config) return [];
	const ids = [];
	for (const source of Object.keys(config.sources)) ids.push(...REVIEWED_PAIRS[source]);
	if (config.antigravity) ids.push(config.antigravity.providerId);
	return ids;
}

/**
 * 只取包内相对入口，并跳过搜索/图像附加工具。
 * Antigravity 包若把搜索/图像扩展列在 pi.extensions 里，加载它们会把非审核工具带进会话。
 * 路径必须 realpath 后仍在包内，避免 package.json 用 ../ 跳出审核目录。
 */
export function extensionEntriesFromPackage(packageDir, { silent = false } = {}) {
	const fail = (message) => {
		if (silent) return [];
		throw new PiRuntimeConfigError(message);
	};
	let rootStat;
	try {
		rootStat = statSync(packageDir);
	} catch {
		return fail(`pi-runtime 路径无效：${packageDir}`);
	}
	if (!rootStat.isDirectory()) return fail(`pi-runtime 路径无效：${packageDir}`);
	let realRoot;
	try {
		realRoot = realpathSync(packageDir);
	} catch {
		return fail(`pi-runtime 路径无效：${packageDir}`);
	}
	const manifestPath = join(realRoot, "package.json");
	if (!existsSync(manifestPath)) return fail(`pi-runtime 路径无效：${packageDir}`);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return fail(`pi-runtime 配置非法：${packageDir} 的 package.json 不是 JSON`);
	}
	const entries = manifest?.pi?.extensions;
	if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string")) {
		return fail(`pi-runtime 路径无效：${packageDir}`);
	}
	const paths = [];
	for (const entry of entries) {
		if (EXTRA_TOOL_ENTRY.test(entry.replaceAll("\\", "/"))) continue;
		if (isAbsolute(entry)) return fail(`pi-runtime 路径无效：${packageDir}`);
		const full = resolve(realRoot, entry);
		if (!full.startsWith(realRoot + sep) || !existsSync(full)) return fail(`pi-runtime 路径无效：${packageDir}`);
		let realPath;
		try {
			realPath = realpathSync(full);
		} catch {
			return fail(`pi-runtime 路径无效：${packageDir}`);
		}
		if (!realPath.startsWith(realRoot + sep)) return fail(`pi-runtime 路径无效：${packageDir}`);
		paths.push(realPath);
	}
	if (paths.length === 0) return fail(`pi-runtime 路径无效：${packageDir}`);
	return paths;
}

export function resolveExtensionPathsForProvider(provider, env = process.env) {
	const loaded = loadPiRuntimeConfig(env);
	if (!loaded.ok) throw loaded.error;
	if (loaded.missing || !loaded.config) return [];
	const source = sourceForProvider(loaded.config, provider);
	if (!source) return [];
	const packageDir = source === "antigravity"
		? loaded.config.antigravity.packageDir
		: loaded.config.sources[source]?.packageDir;
	if (!packageDir) return [];
	return extensionEntriesFromPackage(packageDir);
}

export function resolveCatalogExtensionPaths(env = process.env) {
	const loaded = loadPiRuntimeConfig(env);
	if (!loaded.ok) throw loaded.error;
	if (loaded.missing || !loaded.config) return [];
	const paths = [];
	for (const source of Object.keys(loaded.config.sources)) {
		paths.push(...extensionEntriesFromPackage(loaded.config.sources[source].packageDir));
	}
	if (loaded.config.antigravity) {
		paths.push(...extensionEntriesFromPackage(loaded.config.antigravity.packageDir));
	}
	return [...new Set(paths)];
}

export function registrationDiagnostic(provider, registeredIds, env = process.env) {
	const loaded = loadPiRuntimeConfig(env);
	if (!loaded.ok) return loaded.error.message;
	if (!isReviewedProviderName(provider, loaded.config)) return undefined;
	if (loaded.missing || !loaded.config) return `pi-runtime 配置缺失：${loaded.path}`;
	const source = sourceForProvider(loaded.config, provider);
	if (!source || (source !== "antigravity" && !loaded.config.sources[source])) {
		return `pi-runtime 目标 provider 未注册：${provider}（配置文件 ${loaded.path}）`;
	}
	if (!registeredIds.includes(provider)) {
		return `pi-runtime 目标 provider 未注册：${provider}（配置文件 ${loaded.path}）`;
	}
	return undefined;
}

export function catalogRegistrationDiagnostic(registeredIds, env = process.env) {
	const loaded = loadPiRuntimeConfig(env);
	if (!loaded.ok) return loaded.error.message;
	if (loaded.missing || !loaded.config) return undefined;
	for (const provider of expectedProviderIds(loaded.config)) {
		if (!registeredIds.includes(provider)) {
			return `pi-runtime 目标 provider 未注册：${provider}（配置文件 ${loaded.path}）`;
		}
	}
	return undefined;
}

/**
 * 从 import.meta.url 的 realpath 向上找仓库安装。先 realpath：Windows junction 别名的
 * import.meta.url 仍是别名，词法向上找不到祖先 node_modules，还会误落到 global。
 *
 * 最近一层已经有这份包时必须当场接受或拒绝。跳过 0.87 / 损坏的 package.json 去拿祖先 1.3，
 * 会和 Node 自己的模块解析分叉：SDK 命中近处错版，薄启动器却拿到祖先。某一层根本没有这份安装时才继续向上。
 */
export function findRepoPiInstall(fromUrl) {
	const startFile = fromUrl.startsWith("file:") ? fileURLToPath(fromUrl) : fromUrl;
	let dir;
	try {
		dir = dirname(realpathSync(startFile));
	} catch {
		throw new PiRuntimeConfigError(`pi-runtime 路径无效：${startFile}`);
	}
	const seen = new Set();
	while (!seen.has(dir)) {
		seen.add(dir);
		const pkgDir = join(dir, "node_modules", PI_PACKAGE_NAME);
		let found = false;
		try {
			lstatSync(pkgDir);
			found = true;
		} catch {
			found = false;
		}
		if (found) return acceptNearestInstall(pkgDir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new PiRuntimeConfigError(
		`pi-runtime 找不到仓库内 ${PI_PACKAGE_NAME}@${PI_REQUIRED_VERSION}（从 ${startFile} 向上，不回落 global）`,
	);
}

function rejectNearestInstall(pkgPath, detail) {
	throw new PiRuntimeConfigError(
		`pi-runtime 最近安装拒绝：${pkgPath} ${detail}（期望 ${PI_PACKAGE_NAME}@${PI_REQUIRED_VERSION}，不越过最近安装找祖先）`,
	);
}

function acceptNearestInstall(pkgDir) {
	const pkgPath = join(pkgDir, "package.json");
	if (!existsSync(pkgPath)) rejectNearestInstall(pkgDir, "损坏（缺少 package.json）");
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		rejectNearestInstall(pkgPath, "损坏（package.json 无法读取）");
	}
	if (!pkg || pkg.name !== PI_PACKAGE_NAME || typeof pkg.version !== "string") {
		rejectNearestInstall(pkgPath, "损坏（包名或版本缺失）");
	}
	if (pkg.version !== PI_REQUIRED_VERSION) {
		rejectNearestInstall(pkgPath, `版本 ${pkg.version}`);
	}
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
	if (!bin) rejectNearestInstall(pkgPath, "损坏（bin 缺失）");
	const cliPath = resolve(dirname(pkgPath), bin);
	if (!existsSync(cliPath)) rejectNearestInstall(pkgPath, "损坏（CLI 入口缺失）");
	return { pkgPath: realpathSync(pkgPath), cliPath: realpathSync(cliPath), version: pkg.version };
}

const CATALOG_CHECK_DISABLED_BUILTINS = ["codemode", "llama.cpp", "mcp", "tool-search"];

/**
 * Pi CLI 的 --list-models 在扩展加载失败时仍会退出 0 并打印 native 目录。
 * 空扩展能加载但不 registerProvider 时连错误都没有。这里用和 SDK models 相同的登记诊断，
 * 在薄启动器把真正 CLI 拉起来之前拒绝；否则 shim 会把「没配上」交成一份成功清单。
 * 从已接受的安装路径导入 SDK，不用裸包名：裸包名会按 Node 解析命中更近的错版。
 */
export async function assertCliCatalogRegistered(install, options) {
	const loaded = loadPiRuntimeConfig();
	if (!loaded.ok) throw loaded.error;
	if (loaded.missing || !loaded.config) return;
	const extensionPaths = resolveCatalogExtensionPaths();
	const expected = expectedProviderIds(loaded.config);
	if (expected.length === 0 && extensionPaths.length === 0) return;
	const piEntry = pathToFileURL(join(dirname(install.pkgPath), "dist", "index.js")).href;
	let pi;
	try {
		pi = await import(piEntry);
	} catch {
		rejectNearestInstall(install.pkgPath, "损坏（SDK 入口缺失）");
	}
	const agentDir = options.agentDir || pi.getAgentDir();
	const runtime = await pi.ModelRuntime.create({
		refreshOnCreate: false,
		modelsPath: null,
		credentials: {
			async read() {
				return undefined;
			},
			async list() {
				return [];
			},
			async modify(_providerId, fn) {
				return fn(undefined);
			},
			async delete() {},
		},
	});
	if (extensionPaths.length > 0) {
		const loader = new pi.DefaultResourceLoader({
			cwd: options.cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			disabledBuiltinExtensions: CATALOG_CHECK_DISABLED_BUILTINS,
			additionalExtensionPaths: extensionPaths,
		});
		try {
			await loader.reload();
		} catch {
			throw new Error(`pi-runtime 扩展加载失败：${extensionPaths.join(", ")}`);
		}
		const errors = loader.getExtensions().errors ?? [];
		if (errors.length > 0) {
			throw new Error(`pi-runtime 扩展加载失败：${errors.map((error) => error.path).join(", ")}`);
		}
		const pending = loader.getExtensions().runtime?.pendingProviderRegistrations ?? [];
		const names = pending.map((entry) => entry.name);
		try {
			for (const { name, config } of pending) runtime.registerProvider(name, config);
		} catch {
			throw new Error(`pi-runtime 扩展注册失败：${names.join(",") || "unknown"}`);
		}
		pending.length = 0;
		await runtime.refresh({ allowNetwork: false });
	}
	const diagnostic = catalogRegistrationDiagnostic([...runtime.getRegisteredProviderIds()]);
	if (diagnostic) throw new Error(diagnostic);
}

export function workerClosureArgs(extensionPaths) {
	const args = [
		"--no-extensions",
		"--no-mcp",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--exclude-tools",
		WORKER_EXCLUDED_TOOLS.join(","),
	];
	for (const extensionPath of extensionPaths) {
		args.push("-e", extensionPath);
	}
	return args;
}
