/**
 * 原 MCP server 用 `node PI_CLI_JS ...` 启动，不带 --import。
 * 这个文件必须是普通 JS：指向 .ts 会让 server 的 spawn 直接失败，平台注册了 provider 也进不了 CLI 进程。
 *
 * Pi 1.3.0 的 --list-models 在扩展加载失败时仍 process.exit(0) 并打印 native 目录。
 * 空扩展能加载但不 registerProvider 时连这条错误都没有。不在拉起 CLI 之前拒绝，shim 就会交回一份假成功清单。
 */
import { spawn } from "node:child_process";

import {
	assertCliCatalogRegistered,
	findRepoPiInstall,
	resolveCatalogExtensionPaths,
	workerClosureArgs,
} from "../src/pi-runtime-shared.mjs";

let install;
let extensionPaths = [];
try {
	install = findRepoPiInstall(import.meta.url);
	extensionPaths = resolveCatalogExtensionPaths();
	// 预检从已接受的安装导入 SDK，不用裸包名，避免近处错版和这里分叉。
	await assertCliCatalogRegistered(install, {
		cwd: process.cwd(),
		agentDir: process.env.PI_CODING_AGENT_DIR,
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const child = spawn(
	process.execPath,
	[install.cliPath, ...workerClosureArgs(extensionPaths), ...process.argv.slice(2)],
	{
		cwd: process.cwd(),
		env: process.env,
		stdio: "inherit",
		windowsHide: true,
	},
);
child.on("error", (error) => {
	console.error(error.message);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) process.exit(1);
	process.exit(code ?? 1);
});
