/**
 * 子进程入口。平台的 SpawnRuntime 通过它跑一次 pi。
 *
 * 协议刻意做得很笨：stdin 收一份 JSON spec，stdout 最后一行吐一份 JSON
 * outcome，中间的都是给人看的流式输出。这样平台侧不需要依赖 pi SDK，
 * 也不需要 import 这个包——**进程边界即依赖边界**。
 *
 * 用子进程而不是同进程 SDK，是为了保住两件事：一个 agent 死循环或 OOM 不会
 * 带走平台；平台永远可以 kill 掉它。
 */

import { startRun } from "./runtime.js";
import type { AgentRunSpec } from "./runtime.js";
import { failureOf } from "./failure-classify.js";

const OUTCOME_PREFIX = "__COAGENT_OUTCOME__ ";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function main() {
	const raw = await readStdin();
	if (!raw.trim()) throw new Error("agent-entry: stdin 没有收到 spec");
	const spec = JSON.parse(raw) as AgentRunSpec;
	const outcome = await startRun({ ...spec, stream: true });
	// 前缀让平台能从流式输出里把这一行挑出来。
	process.stdout.write(`\n${OUTCOME_PREFIX}${JSON.stringify(outcome)}\n`);
}

main().catch((error) => {
	// 失败也要吐结构化结果：平台需要区分「上游失败」和「跑完没提交」，
	// 拿不到 outcome 就只能一律当成后者，那会误判成不可重试。
	// 抛出的异常可能已经带了结构化分类（例如模型不存在），原样带出去。
	const message = error instanceof Error ? error.message : String(error);
	process.stdout.write(
		`\n${OUTCOME_PREFIX}${JSON.stringify({
			endedBy: "upstream_failure",
			failureMessage: message,
			upstreamFailure: failureOf(error),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, quality: "unknown" },
			toolCalls: 0,
		})}\n`,
	);
	process.stderr.write(`${error instanceof Error ? error.stack : message}\n`);
	process.exit(0);
});
