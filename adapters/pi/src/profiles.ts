/**
 * profileId → 实际 provider/model 的映射。
 *
 * **这张表只存在于适配层。** 平台侧的候选池里只有 profileId 这种不透明的
 * 选择键——它不认识 provider，也不认识模型名（kernel 的守卫测试会把这些词
 * 拦下来）。换模型、换网关都只动这里，平台配置不用改。
 */

export interface ResolvedProfile {
	provider: string;
	model: string;
	reasoning: "off" | "low" | "medium" | "high";
}

/**
 * 这张表的版本（S13.3 [MUST] ExecutionProfile 版本化）。
 *
 * **改下面任何一行都要把它 +1。** 平台会把它连同解析结果一起冻在 Attempt 上；
 * 不冻的话，"这一跳当时跑的是什么"只能回头来查这张表，而表是会变的——
 * 改一次，全部历史归因静默错位，且错得看不出来。
 */
export const PROFILE_TABLE_REVISION = "r2";

const PROFILES: Record<string, ResolvedProfile> = {
	// 协调者：需要长链条推理，给高档位。
	"coordinator-grok": { provider: "xai", model: "grok-4.6", reasoning: "high" },

	// 执行者候选池，按平台配置的顺序使用。
	//
	// r1 → r2：这三条的 provider 从 `bai` 改成 `opencode-go`。上游把 `bai`
	// 这个 provider 整个去掉了，三个**模型本身都还在**，只是前缀换了。
	// 症状很有迷惑性：跑起来几秒就死、报"模型不可用"，看着像这个候选不行——
	// 实测 W3 里 exec-hy3 / exec-mimo 那几次 6~20 秒的失败全是这一个原因，
	// 当时被当成候选质量问题，白换了好几轮候选。
	"exec-qwen-flash": { provider: "opencode-go", model: "qwen3.8-flash", reasoning: "medium" },
	"exec-hy3": { provider: "opencode-go", model: "hy3", reasoning: "medium" },
	"exec-mimo": { provider: "opencode-go", model: "mimo-v2.5", reasoning: "medium" },
};

/**
 * 解析一个 profileId。
 *
 * @param facts 平台带下来的不透明键值。**优先于下面那张静态表**——
 *   资源池里新加的候选是在界面上选模型建出来的，它的身份就在这里，
 *   静态表里根本没有。先查表再报"未知 profileId"的话，界面上加的候选
 *   永远跑不起来，而报错还会指向一个与真实原因无关的方向。
 */
export function resolveProfile(
	profileId: string,
	reasoning?: string,
	facts?: readonly { key: string; value: string }[],
): ResolvedProfile {
	const pick = (key: string) => facts?.find((f) => f.key === key)?.value;
	const provider = pick("provider");
	const model = pick("model");
	if (provider && model) {
		return {
			provider,
			model,
			reasoning: ((reasoning ?? pick("reasoning") ?? "medium") as ResolvedProfile["reasoning"]),
		};
	}

	const base = PROFILES[profileId];
	if (!base) {
		throw new Error(
			`未知 profileId：${profileId}，而且平台也没带下运行时身份。` +
				`已知的有：${Object.keys(PROFILES).join(", ")}`,
		);
	}
	return reasoning ? { ...base, reasoning: reasoning as ResolvedProfile["reasoning"] } : base;
}

export function knownProfileIds(): string[] {
	return Object.keys(PROFILES);
}
