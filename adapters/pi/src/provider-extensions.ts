import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
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
 * packageDir 只给既有隔离测试：正式路径来自无密钥配置，不再回落过时的 npm 目录。
 * 回落旧目录时，目录不存在会返回 []，models 就会把「没配上」印成原生成功清单。
 */
export function resolveProviderExtensionPaths(provider: string, packageDir?: string): string[] {
	if (packageDir !== undefined) {
		if (provider !== "codebuddy") return [];
		return extensionEntriesFromPackage(packageDir, { silent: true });
	}
	return resolveExtensionPathsForProvider(provider);
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
