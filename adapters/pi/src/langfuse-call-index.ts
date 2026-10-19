/**
 * 调用序号的本地耐久高水位（sidecar，与 SDK 会话文件同目录）。
 *
 * 为什么不能只靠 SDK 会话里的 custom entry：pi 0.87.1 的 session-manager
 * `_persist` 在**首个 assistant 消息进入 fileEntries 之前根本不写会话文件**
 * （只把 flushed 置回 false）。于是「已导出一条 GENERATION，但进程在该 assistant
 * 持久化之前退出」这个窗口里，custom entry 记的高水位整个丢失，重开的进程会从 0
 * 重新编号，把已导出的编号再发一遍——在 Langfuse 里那就是同一个 observation，
 * 两次调用被合成为一次，复核数据凭空少一次。
 * 所以序号必须落到一个不依赖「assistant 是否已经持久化」的地方。
 *
 * 只存一条定长小记录（version / attemptId / callIndex）：这一层是旁路观测的
 * 元数据，正文、模型配置、凭据都不该因此多出第二个落盘位置。
 * 不追加日志、不做网络等待：每次预留是一次小文件写 + 一次 rename。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 记录格式版本。字段含义一旦变化就换版本：老记录读不懂时应关观测，而不是猜。 */
const SIDECAR_VERSION = 1;

/** sidecar 是单条记录，正常几十字节。超过这个上界说明文件被别的东西写脏了。 */
const MAX_SIDECAR_BYTES = 4_096;

export interface DurableCallIndexOptions {
	/** SDK 会话文件路径（可以尚不存在：首个 assistant 还没持久化）。 */
	sessionFile: string;
	attemptId: string;
}

export interface CallIndexRecord {
	version: number;
	attemptId: string;
	callIndex: number;
}

export interface DurableCallIndex {
	/** 本 attempt 的 sidecar 绝对路径（测试用它断言落盘内容）。 */
	readonly file: string;
	/** 读出已有高水位；不存在返回 -1。内容损坏或 identity 不匹配时抛。 */
	read(): number;
	/** 原子替换写入新高水位。失败时抛，由调用方关闭观测。 */
	write(callIndex: number): void;
	/** 清掉自己可能留下的临时文件（best effort），不碰会话文件本身。 */
	dispose(): void;
}

/**
 * attemptId 是不可信输入（可能带路径分隔符、控制字符或极长），
 * 直接拼文件名会写到别处或超出文件名上限，所以只把它的哈希拼进去。
 */
export function callIndexSidecarPath(sessionFile: string, attemptId: string): string {
	const digest = createHash("sha256").update(attemptId, "utf8").digest("hex").slice(0, 32);
	return `${sessionFile}.coagent-langfuse-call-index.${digest}.json`;
}

export function createDurableCallIndex(options: DurableCallIndexOptions): DurableCallIndex {
	const { sessionFile, attemptId } = options;
	if (typeof sessionFile !== "string" || sessionFile.length === 0) {
		throw new Error("call index sidecar requires a session file path");
	}
	if (typeof attemptId !== "string" || attemptId.length === 0) {
		throw new Error("call index sidecar requires an attempt id");
	}

	const file = callIndexSidecarPath(sessionFile, attemptId);
	const dir = dirname(file);
	let tempFile: string | undefined;
	let sequence = 0;

	return {
		file,

		read() {
			// 不存在就是「没有历史」：新 Attempt 的正常起点，不是错误。
			if (!existsSync(file)) return -1;
			const size = statSync(file).size;
			if (size <= 0 || size > MAX_SIDECAR_BYTES) {
				// 损坏按错误处理：退回 0 会把已导出的编号重新发一遍。
				throw new Error("call index sidecar is not a single valid record");
			}
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CallIndexRecord>;
			if (parsed?.version !== SIDECAR_VERSION) {
				throw new Error("call index sidecar version mismatch");
			}
			// 路径里已经有 attemptId 的哈希，这里再核对一次：哈希碰撞或被别的
			// attempt 的记录覆盖时，宁可不观测也不能接着别人的编号。
			if (parsed.attemptId !== attemptId) {
				throw new Error("call index sidecar identity mismatch");
			}
			const index = parsed.callIndex;
			if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
				throw new Error("call index sidecar holds an invalid call index");
			}
			return index;
		},

		write(callIndex) {
			if (typeof callIndex !== "number" || !Number.isInteger(callIndex) || callIndex < 0) {
				throw new Error("refusing to persist a non-integer call index");
			}
			sequence += 1;
			const temp = join(dir, `.${basename(file)}.${process.pid}.${sequence}.tmp`);
			tempFile = temp;
			const record: CallIndexRecord = { version: SIDECAR_VERSION, attemptId, callIndex };
			writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "w" });
			// 先写临时文件再 rename：中途崩掉只会留下临时文件，
			// 已经落盘的高水位不会被写坏的半截内容替换。
			renameSync(temp, file);
			tempFile = undefined;
		},

		dispose() {
			const pending = tempFile;
			tempFile = undefined;
			if (!pending) return;
			try {
				rmSync(pending, { force: true });
			} catch {
				// 临时文件清不掉只是脏文件，绝不能再往上抛：观测失败不能变成模型失败。
			}
		},
	};
}
