import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Resolve the sole bundled provider extension; packageDir exists only for isolated tests. */
export function resolveProviderExtensionPaths(provider: string, packageDir?: string): string[] {
	if (provider !== "codebuddy") return [];
	const root = resolve(packageDir ?? join(getAgentDir(), "npm/node_modules/pi-codebuddy-oauth"));
	try {
		const realRoot = realpathSync(root);
		const manifest = JSON.parse(readFileSync(join(realRoot, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
		const entries = manifest.pi?.extensions;
		if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0] !== "string") return [];
		const entry = entries[0];
		if (isAbsolute(entry)) return [];
		const path = resolve(realRoot, entry);
		if (!path.startsWith(realRoot + sep) || !existsSync(path)) return [];
		const realPath = realpathSync(path);
		if (!realPath.startsWith(realRoot + sep)) return [];
		return [realPath];
	} catch {
		return [];
	}
}

export async function registerPendingProviderExtensions(loader: DefaultResourceLoader, runtime: ModelRuntime): Promise<void> {
	const pending = loader.getExtensions().runtime.pendingProviderRegistrations;
	for (const { name, config } of pending) runtime.registerProvider(name, config);
	pending.length = 0;
	await runtime.refresh({ allowNetwork: false });
}
