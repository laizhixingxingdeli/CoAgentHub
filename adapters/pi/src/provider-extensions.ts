import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DefaultResourceLoader as Loader, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { DISABLED_BUILTIN_EXTENSIONS } from "./roles.js";
import {
	catalogRegistrationDiagnostic,
	extensionEntriesFromPackage,
	registrationDiagnostic,
	resolveCatalogExtensionPaths as resolveCatalogFromConfig,
	resolveExtensionPathsForProvider,
} from "./pi-runtime-shared.mjs";

/**
 * provider → 插件包目录名的匹配表（settings.json 兜底用）。
 *
 * pi 1.4.0 起插件不再装进 `agentDir/npm/node_modules`，改由 `settings.json` 的
 * `packages` 声明（`npm:<name>` 或相对 agentDir 的路径）。仓库托管配置
 * （pi-runtime-shared 的无密钥配置）优先；没有配置或没覆盖到该 provider 时，
 * 按这份表回落到本机 pi 的 settings.json——两家插件可以注册多个 provider id
 * （pi-codebuddy-oauth 同时注册 codebuddy 与 codebuddy-intl）。
 */
const PROVIDER_EXTENSION_PACKAGES: Readonly<Record<string, RegExp>> = {
	codebuddy: /pi-codebuddy-oauth/,
	qoder: /pi-provider-qoder/,
	antigravity: /pi-antigravity/,
};

const PACKAGE_NAMES = Object.values(PROVIDER_EXTENSION_PACKAGES).map((p) => String(p));

/**
 * packageDir 只给既有隔离测试：正式路径来自无密钥配置，settings.json 兜底。
 * 回落旧目录时，目录不存在会返回 []，models 就会把「没配上」印成原生成功清单。
 */
export function resolveProviderExtensionPaths(
	provider: string,
	packageDir?: string,
	agentDirOverride?: string,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (packageDir !== undefined) {
		if (provider !== "codebuddy") return [];
		return extensionEntriesFromPackage(packageDir, { silent: true });
	}
	try {
		const fromConfig = resolveExtensionPathsForProvider(provider, env);
		if (fromConfig.length > 0) return fromConfig;
	} catch {
		// 仓库托管配置非法：不算致命，落到本机 pi 的 settings.json。
	}
	return resolveFromSettingsPackages(provider, agentDirOverride);
}

/**
 * settings.json 兜底（ADR-0009 期间的 1.4.0 实测机制）：托管 agent 用
 * `noExtensions` 关掉用户扩展，provider 插件必须显式注入；仓库托管配置没覆盖
 * 到的 provider 按本机 pi 的 packages 声明找。agentDirOverride 只为隔离测试存在。
 */
function resolveFromSettingsPackages(provider: string, agentDirOverride?: string): string[] {
	const family = Object.keys(PROVIDER_EXTENSION_PACKAGES).find(
		(key) => provider === key || provider.startsWith(`${key}-`),
	);
	if (!family) return [];
	const pattern = PROVIDER_EXTENSION_PACKAGES[family];
	const agentDir = agentDirOverride ?? getAgentDir();

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
		if (!pattern.test(basenameOf(root))) continue;
		const paths = extensionEntriesFromPackage(root, { silent: true });
		if (paths.length > 0) return paths;
	}
	return [];
}

function basenameOf(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	const index = normalized.lastIndexOf("/");
	return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function resolveCatalogExtensionPaths(): string[] {
	return resolveCatalogFromConfig();
}

export function reviewedRegistrationError(
	provider: string,
	runtime: { getRegisteredProviderIds(): readonly string[] },
): string | undefined {
	return registrationDiagnostic(provider, [...runtime.getRegisteredProviderIds()]);
}

export async function registerPendingProviderExtensions(loader: Loader, runtime: ModelRuntime): Promise<void> {
	const pending = loader.getExtensions().runtime.pendingProviderRegistrations;
	const names = pending.map((entry) => entry.name);
	try {
		for (const { name, config } of pending) runtime.registerProvider(name, config);
	} catch {
		// registerProvider 的异常可能带上扩展配置。换成定位信息，避免把声明正文打进平台日志。
		throw new Error(`pi-runtime 扩展注册失败：${names.join(",") || "unknown"}`);
	}
	pending.length = 0;
	await runtime.refresh({ allowNetwork: false });
}

/** models 与 startRun 用同一套闭包标志加载审核扩展。吞掉加载错误会让非法配置看起来像原生目录。 */
export async function registerReviewedExtensions(
	runtime: ModelRuntime,
	options: { cwd: string; agentDir: string; extensionPaths: string[]; expectCatalog?: boolean },
): Promise<void> {
	if (options.extensionPaths.length === 0) return;
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		disabledBuiltinExtensions: [...DISABLED_BUILTIN_EXTENSIONS],
		additionalExtensionPaths: options.extensionPaths,
	});
	await loader.reload();
	const errors = loader.getExtensions().errors;
	if (errors.length > 0) {
		throw new Error(`pi-runtime 扩展加载失败：${errors.map((error) => error.path).join(", ")}`);
	}
	await registerPendingProviderExtensions(loader, runtime);
	if (options.expectCatalog) {
		const diagnostic = catalogRegistrationDiagnostic([...runtime.getRegisteredProviderIds()]);
		if (diagnostic) throw new Error(diagnostic);
	}
}
