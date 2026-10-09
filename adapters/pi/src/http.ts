/**
 * HTTP dispatcher 安装。
 *
 * ⚠ 这一步是 SDK 内嵌时**必须自己做**的：pi 的 CLI 在 main() 里调
 * configureHttpDispatcher()，但那个函数没有从包的 index 导出，exports map 也
 * 不允许深路径导入。SDK 使用者不做这件事的后果是：
 *
 *   Node 内置 fetch **不读** HTTP_PROXY/HTTPS_PROXY 环境变量（curl 读，所以
 *   curl 测试会通过，误导人），于是所有 provider 调用直接 "fetch failed"，
 *   而且是**静默**的 —— session.prompt() 正常 resolve，只在 session 文件里
 *   留下 stopReason:"error"。表面症状是「模型一个工具都没调就结束了」。
 *
 * 这和 v4 踩过的坑是同一类：后端进程拿不到代理变量，执行器就直连超时。
 */

import * as undici from "undici";

let installed = false;

export function installHttpDispatcher(idleTimeoutMs = 300_000): void {
	if (installed) return;
	installed = true;

	const dispatcher = new undici.EnvHttpProxyAgent({
		allowH2: false,
		proxyTunnel: true,
		bodyTimeout: idleTimeoutMs,
		headersTimeout: idleTimeoutMs,
		connect: { autoSelectFamilyAttemptTimeout: 2_000 },
	});
	// undici 在中途终止 fetch body 时会从内部 Client 抛 "error"，没有监听器会让
	// EventEmitter 直接把进程带走。
	if (typeof (dispatcher as { on?: unknown }).on === "function") {
		(dispatcher as unknown as { on(e: string, f: () => void): void }).on("error", () => {});
	}
	undici.setGlobalDispatcher(dispatcher);
	// 让 fetch 和 dispatcher 落在同一份 undici 实现上。
	(undici as { install?: () => void }).install?.();
}

/** 供诊断用：当前进程看到的代理配置。 */
export function proxySummary(): string {
	const e = process.env;
	const v = e.HTTPS_PROXY ?? e.https_proxy ?? e.HTTP_PROXY ?? e.http_proxy;
	return v ? `proxy=${v} no_proxy=${e.NO_PROXY ?? e.no_proxy ?? "(none)"}` : "proxy=(none)";
}
