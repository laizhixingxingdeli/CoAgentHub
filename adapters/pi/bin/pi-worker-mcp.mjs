/**
 * 薄启动器：只通过原 server 已有的 PI_CLI_JS / PI_WORKER_* 环境变量接上仓库 1.3.0。
 * 不改 server 的成功判定、回退、会话或取消。个人 server 路径由调用方传入，不写进仓库。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { findRepoPiInstall, workerModels } from "../src/pi-runtime-shared.mjs";

function fail(message) {
	console.error(message);
	process.exit(1);
}

const argv = process.argv.slice(2);
let server = process.env.PI_WORKER_MCP_SERVER;
const pass = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--server") {
		server = argv[i + 1];
		i++;
		continue;
	}
	pass.push(argv[i]);
}
if (!server) {
	fail("pi-runtime 缺少 MCP server 路径：传入 --server 或 PI_WORKER_MCP_SERVER（不要把个人路径写进仓库）");
}

let install;
try {
	install = findRepoPiInstall(import.meta.url);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
let worker;
try {
	worker = workerModels();
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

// 用 import.meta.url 生成 shim 路径。junction 启动时这是别名路径，server 会按别名 spawn，不能改成词法拼接后的另一套路径。
const shimPath = fileURLToPath(new URL("./pi-cli-shim.mjs", import.meta.url));
const env = {
	...process.env,
	PI_CLI_JS: shimPath,
	PI_WORKER_DEFAULT_MODEL: worker.defaultModel,
	PI_WORKER_FALLBACK_MODEL: worker.fallbackModel,
};
console.error(`pi-runtime shim cli=${install.cliPath} version=${install.version}`);

const child = spawn(process.execPath, [server, ...pass], {
	cwd: process.cwd(),
	env,
	stdio: "inherit",
	windowsHide: true,
});
child.on("error", (error) => fail(error.message));
child.on("exit", (code, signal) => {
	if (signal) process.exit(1);
	process.exit(code ?? 1);
});
