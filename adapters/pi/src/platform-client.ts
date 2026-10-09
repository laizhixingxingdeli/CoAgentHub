/**
 * 平台客户端。
 *
 * 适配层与 CoAgentHub 之间唯一的耦合点，也是全部耦合：一次带 run token 的
 * POST。**工具的真实实现在平台侧**，这里不做任何领域判断——否则接第二个
 * agent 时要把十来个工具重写一遍。
 */

export interface ToolCallResult {
	ok: boolean;
	/** 回给模型看的文本。失败时是平台给出的「下一步该干什么」。 */
	text: string;
	json: unknown;
}

export class PlatformClient {
	#base: string;
	#token: string;
	/**
	 * 是否出现过"连不上平台"。
	 *
	 * 要和"上游模型服务不可用"分开报：前者是平台坏了，冷却任何候选都是
	 * 误伤——换一个照样连不上，还把好候选白白冻起来。
	 */
	#unreachable = false;

	constructor(base: string, token: string) {
		this.#base = base.replace(/\/$/, "");
		this.#token = token;
	}

	get sawUnreachable(): boolean {
		return this.#unreachable;
	}

	/**
	 * 读一个带 run token 的只读端点。
	 *
	 * 和 call() 分开：那个是工具调用，结果要回给模型看；这个是适配层自己取
	 * 上下文，模型不参与。取不到返回 undefined 而不是抛——这条路上的东西都是
	 * "少走一轮弯路"，不该因为取不到就把整跳搞失败。
	 */
	async get<T>(path: string): Promise<T | undefined> {
		try {
			const res = await fetch(`${this.#base}/api/${path}`, {
				headers: { "x-coagent-run": this.#token },
			});
			if (!res.ok) return undefined;
			return (await res.json()) as T;
		} catch {
			this.#unreachable = true;
			return undefined;
		}
	}

	async call(tool: string, body: unknown): Promise<ToolCallResult> {
		let res: Response;
		try {
			res = await fetch(`${this.#base}/api/agent/${tool}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-coagent-run": this.#token,
				},
				body: JSON.stringify(body ?? {}),
			});
		} catch (e) {
			this.#unreachable = true;
			// 平台不可达要**如实**告诉模型，不能装作工具调用成功了。
			return {
				ok: false,
				text: `平台不可达：${e instanceof Error ? e.message : String(e)}。不要继续，也不要把结果写在回复里——停下来报告。`,
				json: null,
			};
		}
		const json: unknown = await res.json().catch(() => null);
		if (!res.ok) {
			const detail = json as { error?: string; message?: string } | null;
			return {
				ok: false,
				text: detail?.message ?? `平台拒绝了这次调用（HTTP ${res.status}）`,
				json,
			};
		}
		return { ok: true, text: JSON.stringify(json, null, 2), json };
	}
}

/** 控制面：开一次 attempt，换到 run token。调度器用，不是 agent 用。 */
export async function startAttempt(
	base: string,
	missionId: string,
	role: "coordinator" | "executor",
	workItemId?: string,
): Promise<{ attemptId: string; token: string }> {
	const path =
		role === "coordinator"
			? `/api/missions/${missionId}/coordinator-attempts`
			: `/api/missions/${missionId}/work-items/${workItemId}/executor-attempts`;
	const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	const json = (await res.json()) as { attemptId?: string; token?: string; message?: string };
	if (!res.ok || !json.attemptId || !json.token) {
		throw new Error(`开 attempt 失败（HTTP ${res.status}）：${json.message ?? JSON.stringify(json)}`);
	}
	return { attemptId: json.attemptId, token: json.token };
}

export async function finishAttempt(
	base: string,
	missionId: string,
	attemptId: string,
	body: unknown,
): Promise<void> {
	const res = await fetch(
		`${base.replace(/\/$/, "")}/api/missions/${missionId}/attempts/${attemptId}/finish`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	if (!res.ok) {
		const json = (await res.json().catch(() => null)) as { message?: string } | null;
		throw new Error(`收尾 attempt 失败（HTTP ${res.status}）：${json?.message ?? ""}`);
	}
}

export async function missionView(base: string, missionId: string): Promise<unknown> {
	const res = await fetch(`${base.replace(/\/$/, "")}/api/missions/${missionId}`);
	if (!res.ok) throw new Error(`读 Mission 失败（HTTP ${res.status}）`);
	return res.json();
}
