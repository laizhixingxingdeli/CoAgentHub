import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * provider → 插件包目录名的匹配表。
 *
 * pi 1.4.0 起插件不再装进 `agentDir/npm/node_modules`，改由 `settings.json` 的
 * `packages` 声明（`npm:<name>` 或相对 agentDir 的路径）。这里按 provider 前缀
 * 找声明里对应的包；一家插件可以注册多个 provider id（pi-codebuddy-oauth 同时
 * 注册 codebuddy 与 codebuddy-intl）。
 */
const PROVIDER_EXTENSION_PACKAGES: Readonly<Record<string, RegExp>> = {
	codebuddy: /pi-codebuddy-oauth/,
	qoder: /pi-provider-qoder/,
	antigravity: /pi-antigravity/,
};

const PACKAGE_NAMES = Object.values(PROVIDER_EXTENSION_PACKAGES).map((p) => String(p));

/** 读一个插件包的 pi.extensions 清单，逐条校验在包内后返回真实路径。 */
function manifestExtensionPaths(root: string): string[] {
	try {
		const realRoot = realpathSync(root);
		const manifest = JSON.parse(readFileSync(join(realRoot, "package.json"), "utf8")) as {
			pi?: { extensions?: unknown };
		};
		const entries = manifest.pi?.extensions;
		if (!Array.isArray(entries) || entries.length === 0) return [];
		const paths: string[] = [];
		for (const entry of entries) {
			if (typeof entry !== "string" || isAbsolute(entry)) return [];
			const path = resolve(realRoot, entry);
			if (!path.startsWith(realRoot + sep) || !existsSync(path)) return [];
			const realPath = realpathSync(path);
			if (!realPath.startsWith(realRoot + sep)) return [];
			paths.push(realPath);
		}
		return paths;
	} catch {
		return [];
	}
}

/**
 * 解析 provider 需要注入的磁盘扩展入口。
 *
 * pi 1.4.0 的托管 agent 用 `noExtensions` 关掉用户扩展，provider 插件必须显式
 * 注入：先按 settings.json 的 packages 声明找（新机制），再兜底旧的
 * `npm/node_modules/<包名>` 布局。packageDir / agentDir 只为隔离测试存在。
 */
export function resolveProviderExtensionPaths(
	provider: string,
	packageDir?: string,
	agentDirOverride?: string,
): string[] {
	const family = Object.keys(PROVIDER_EXTENSION_PACKAGES).find(
		(key) => provider === key || provider.startsWith(`${key}-`),
	);
	if (!family) return [];
	const pattern = PROVIDER_EXTENSION_PACKAGES[family];
	const agentDir = agentDirOverride ?? getAgentDir();

	if (packageDir) return manifestExtensionPaths(packageDir);

	const roots: string[] = [];
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
			packages?: unknown;
		};
		if (Array.isArray(settings.packages)) {
			for (const decl of settings.packages) {
				if (typeof decl !== "string") continue;
				if (decl.startsWith("npm:")) roots.push(join(agentDir, "npm/node_modules", decl.slice(4)));
				else roots.push(isAbsolute(decl) ? decl : resolve(agentDir, decl));
			}
		}
	} catch {
		// 没有 settings 或解析失败：落到旧布局兜底。
	}
	for (const name of PACKAGE_NAMES) {
		roots.push(join(agentDir, "npm/node_modules", name));
	}

	for (const root of roots) {
		if (!pattern.test(basename(root))) continue;
		const paths = manifestExtensionPaths(root);
		if (paths.length > 0) return paths;
	}
	return [];
}

export async function registerPendingProviderExtensions(loader: DefaultResourceLoader, runtime: ModelRuntime): Promise<void> {
	const pending = loader.getExtensions().runtime.pendingProviderRegistrations;
	for (const { name, config } of pending) runtime.registerProvider(name, config);
	pending.length = 0;
	await runtime.refresh({ allowNetwork: false });
}
