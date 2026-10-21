/**
 * 原 MCP server 用 `node PI_CLI_JS ...` 启动，不带 --import。
 * 这个文件必须是普通 JS：指向 .ts 会让 server 的 spawn 直接失败，平台注册了 provider 也进不了 CLI 进程。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	findRepoPiInstall,
	resolveCatalogExtensionPaths,
	workerClosureArgs,
} from "../src/pi-runtime-shared.mjs";

const install = findRepoPiInstall(import.meta.url);
const userArgs = process.argv.slice(2);
let extensionPaths = [];
try {
	// 目录命令与真正的 -p 会话都要吃同一份声明，不能只在平台进程 registerProvider。
	extensionPaths = resolveCatalogExtensionPaths();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const child = spawn(
	process.execPath,
	[install.cliPath, ...workerClosureArgs(extensionPaths), ...userArgs],
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
