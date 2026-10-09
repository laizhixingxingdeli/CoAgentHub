/**
 * 档案表对照上游目录的静态审计（纯函数，无 IO）。
 *
 * 为什么需要它：档案表（src/profiles.ts）是**静态**的，上游目录是**活的**。
 * 上游把一个 provider 整个改名（bai → opencode-go）时，模型 id 一个都没变，
 * 于是档案表里的那一行静默过期。症状很有迷惑性：任务跑起来几秒就死、报
 * 「模型不可用」，看上去像这个候选质量不行 —— 实测因此白换了好几轮候选。
 *
 * 判定口径很关键：**过期 = provider+model 不在目录里**（等价于 getModel 找不到），
 * 不能用「有没有 API key」当不存在 —— 那会把「有模型但没配凭证」误报成过期，
 * 指向一个跟真实原因无关的方向。
 *
 * 这里只做纯计算：输入档案条目 + 目录列表，输出结构化结果和一段给人看的文本。
 * 拉目录、打印、定退出码都是 CLI 的事（见 src/cli.ts 的 audit 命令）。
 */

/** 一条档案条目（profileId → 实际 provider/model）。 */
export interface AuditProfileEntry {
	profileId: string;
	/** 表里写的 provider。 */
	provider: string;
	/** 表里写的模型 id（对应 SDK 的 Model.id）。 */
	model: string;
}

/** 上游目录里的一项。`model` 对应 SDK 的 `Model.id`。 */
export interface CatalogEntry {
	provider: string;
	model: string;
}

/** 一条过期的档案条目。 */
export interface StaleProfile extends AuditProfileEntry {
	/** 目录里 model id 相同、但 provider 不同的项（bai/hy3 → opencode-go/hy3）。 */
	sameNameElsewhere: CatalogEntry[];
}

export interface AuditResult {
	/** 全部对得上才为 true。 */
	ok: boolean;
	/** 对得上的条目，保持输入顺序。 */
	matched: AuditProfileEntry[];
	/** 对不上的条目，保持输入顺序。 */
	stale: StaleProfile[];
}

const key = (provider: string, model: string): string => `${provider}/${model}`;

/**
 * 把档案条目对照目录列表，找出哪些已经不存在。
 *
 * @param profiles 档案条目（用 knownProfileIds() + resolveProfile() 取）
 * @param catalog  上游目录（runtime.getModels()，只看存在性）
 */
export function auditProfiles(
	profiles: readonly AuditProfileEntry[],
	catalog: readonly CatalogEntry[],
): AuditResult {
	// 存在性集合：provider+model 都对上才算存在。
	const present = new Set(catalog.map((c) => key(c.provider, c.model)));
	// 同名索引：model id → 目录里出现过它的 provider 集合。
	const providersByModel = new Map<string, Set<string>>();
	for (const entry of catalog) {
		let set = providersByModel.get(entry.model);
		if (!set) providersByModel.set(entry.model, (set = new Set()));
		set.add(entry.provider);
	}

	const matched: AuditProfileEntry[] = [];
	const stale: StaleProfile[] = [];
	for (const profile of profiles) {
		if (present.has(key(profile.provider, profile.model))) {
			matched.push(profile);
			continue;
		}
		const others = providersByModel.get(profile.model);
		const sameNameElsewhere: CatalogEntry[] = others
			? [...others]
					.filter((provider) => provider !== profile.provider)
					.sort()
					.map((provider) => ({ provider, model: profile.model }))
			: [];
		stale.push({ ...profile, sameNameElsewhere });
	}

	return { ok: stale.length === 0, matched, stale };
}

/** provider → 该 provider 下的 model id（均排序，输出稳定）。 */
function groupByProvider(
	entries: readonly CatalogEntry[],
): { provider: string; models: string[] }[] {
	const byProvider = new Map<string, Set<string>>();
	for (const entry of entries) {
		let set = byProvider.get(entry.provider);
		if (!set) byProvider.set(entry.provider, (set = new Set()));
		set.add(entry.model);
	}
	return [...byProvider.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([provider, models]) => ({ provider, models: [...models].sort() }));
}

/**
 * 把审计结果打成给人看的文本。
 *
 * @param result     auditProfiles() 的结果
 * @param available  上游**现在可用**的清单（runtime.getAvailable()）。
 *   这是「该改成什么」的答案，所以单独传进来；目录（getModels）
 *   有一千多条，把全量打进报告等于什么都没说。
 */
export function formatAuditReport(
	result: AuditResult,
	available: readonly CatalogEntry[] = [],
): string {
	const lines: string[] = [];
	const availableKeys = new Set(available.map((a) => key(a.provider, a.model)));
	const total = result.matched.length + result.stale.length;

	if (result.ok) {
		// 全对也要有输出：空输出会被当成"命令没跑"。
		lines.push(`档案审计：${total} 条都对得上上游目录。`);
		for (const profile of result.matched) {
			lines.push(`  ✓ ${profile.profileId.padEnd(18)} ${key(profile.provider, profile.model)}`);
		}
		return lines.join("\n");
	}

	lines.push(
		`档案审计：${result.stale.length} 条对不上上游目录，${result.matched.length} 条对得上。`,
	);
	lines.push("");
	lines.push("过期条目（表里写的 provider/model 已经不在目录里）：");
	for (const profile of result.stale) {
		lines.push(`  ✗ ${profile.profileId}`);
		lines.push(`      表里写的是：${key(profile.provider, profile.model)}`);
		if (profile.sameNameElsewhere.length === 0) {
			lines.push("      同名模型在上游目录里也找不到了——模型 id 本身可能已经下线。");
			continue;
		}
		const named = profile.sameNameElsewhere
			.map(
				(c) =>
					`${key(c.provider, c.model)}${availableKeys.has(key(c.provider, c.model)) ? "（有凭证，可用）" : "（目录里有，但当前没有凭证）"}`,
			)
			.join("、");
		lines.push(`      同名模型现在在：${named}`);
	}
	if (result.matched.length > 0) {
		lines.push("");
		lines.push("对得上的条目：");
		for (const profile of result.matched) {
			lines.push(`  ✓ ${profile.profileId.padEnd(18)} ${key(profile.provider, profile.model)}`);
		}
	}

	const groups = groupByProvider(available);
	lines.push("");
	if (groups.length === 0) {
		lines.push("上游现在可用的（getAvailable）：一条都没有——先检查凭证/代理。");
	} else {
		lines.push("上游现在可用的（按 provider 分组）：");
		for (const group of groups) {
			lines.push(`  ${group.provider}`);
			for (const model of group.models) lines.push(`    - ${model}`);
		}
	}
	return lines.join("\n");
}
