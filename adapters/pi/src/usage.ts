import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type UsageRow = {
	provider: "xai" | "tenrouter";
	status: "ok" | "no_auth" | "error" | "timeout";
	modelPrefix?: string;
	upstream?: string;
	usedPercent?: number;
	remainingPercent?: number;
	resetAt?: string;
	periodStart?: string;
	plan?: string;
	fetchedAt?: string;
};

type OAuthRuntime = {
	isUsingOAuth(provider: string): boolean;
	getAuth(provider: string): Promise<unknown>;
};
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface UsageDependencies {
	fetch?: FetchLike;
	oauth?: () => Promise<string | undefined>;
	runtime?: OAuthRuntime;
	now?: () => Date;
	timeoutMs?: number;
}

const USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const PROVIDERS = ["xai", "xai-auth"];

function bearer(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const outer = result as { auth?: unknown };
	const auth = outer.auth && typeof outer.auth === "object" ? outer.auth as { apiKey?: unknown; headers?: Record<string, string> } : result as { apiKey?: unknown; headers?: Record<string, string> };
	if (typeof auth.apiKey === "string" && auth.apiKey) return auth.apiKey;
	const header = auth.headers?.Authorization;
	return typeof header === "string" && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() || undefined : undefined;
}

/** Resolve credentials only when Pi explicitly identifies the provider auth as OAuth. */
export async function resolveXaiOAuth(runtime: OAuthRuntime): Promise<string | undefined> {
	for (const provider of PROVIDERS) {
		if (!runtime.isUsingOAuth(provider)) continue;
		const token = bearer(await runtime.getAuth(provider));
		if (token) return token;
	}
	return undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validTime(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) return undefined;
	return value;
}

function validPlan(value: unknown): string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : "SuperGrok";
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("usage-timeout"));
		}, milliseconds);
	});
	try {
		return await Promise.race([operation(controller.signal), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function queryXai(deps: UsageDependencies): Promise<UsageRow> {
	const now = deps.now ?? (() => new Date());
	const fetcher = deps.fetch ?? globalThis.fetch;
	try {
		return await withDeadline(async (signal) => {
			const token = deps.oauth ? await deps.oauth() : deps.runtime
				? await resolveXaiOAuth(deps.runtime)
				: await resolveXaiOAuth(await ModelRuntime.create() as unknown as OAuthRuntime);
			if (!token) return { provider: "xai", status: "no_auth" };
			const headers = { Authorization: `Bearer ${token}` };
			const identityResponse = await fetcher(USER_URL, { headers, signal });
			if (!identityResponse.ok) return { provider: "xai", status: "error" };
			const identity = await identityResponse.json() as { userId?: unknown };
			if (typeof identity?.userId !== "string" || !identity.userId) return { provider: "xai", status: "error" };
			const billingResponse = await fetcher(BILLING_URL, { headers: { ...headers, "x-userid": identity.userId }, signal });
			if (!billingResponse.ok) return { provider: "xai", status: "error" };
			const billing = await billingResponse.json() as any;
			const config = billing?.config;
			let used = finite(config?.creditUsagePercent);
			if (used !== undefined && used > 100) used = undefined;
			if (used === undefined) {
				const amount = finite(config?.used?.val);
				const limit = finite(config?.monthlyLimit?.val);
				if (amount !== undefined && limit !== undefined && limit > 0) used = Math.min(100, amount / limit * 100);
			}
			const row: UsageRow = { provider: "xai", status: "ok", fetchedAt: now().toISOString() };
			if (used !== undefined) {
				row.usedPercent = used;
				row.remainingPercent = Math.max(0, 100 - used);
			}
			const end = validTime(config?.currentPeriod?.end);
			const start = validTime(config?.currentPeriod?.start);
			if (end) row.resetAt = end;
			if (start) row.periodStart = start;
			row.plan = validPlan(billing?.subscriptionTier);
			return row;
		}, deps.timeoutMs ?? 5000);
	} catch (error) {
		return { provider: "xai", status: error instanceof Error && error.message === "usage-timeout" ? "timeout" : "error" };
	}
}

/**
 * 10Router 上游（connections[].provider，真实为长名）→ 对外的安全模型前缀（短白名单）；
 * 不在表内的上游一律不出行。
 */
const TENROUTER_UPSTREAMS: ReadonlyArray<{ upstream: string; modelPrefix: string }> = [
	{ upstream: "codebuddy-cn", modelPrefix: "cbcn" },
	{ upstream: "antigravity", modelPrefix: "ag" },
	{ upstream: "qoder-cn", modelPrefix: "qdc" },
];
const TENROUTER_DEFAULT_URL = "http://127.0.0.1:20128";
const TENROUTER_QUOTAS_PATH = "/api/usage/quotas";

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function percentScale(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 100;
}

/**
 * 单个额度的百分比（0..100），取不到就返回 undefined——未知绝不猜成 0。
 * 优先用 remainingPercentage 按有效正 percentScale 归一；否则用 remaining/total
 * 或 (total-used)/total，要求 finite 非负且 total>0，最后截断到 0..100。
 */
function bucketPercent(bucket: Record<string, unknown>): number | undefined {
	const raw = finite(bucket.remainingPercentage);
	if (raw !== undefined) {
		const normalized = raw / percentScale(bucket.percentScale) * 100;
		if (Number.isFinite(normalized)) return clampPercent(normalized);
	}
	const total = finite(bucket.total);
	if (total !== undefined && total > 0) {
		const remaining = finite(bucket.remaining);
		if (remaining !== undefined) return clampPercent(remaining / total * 100);
		const used = finite(bucket.used);
		if (used !== undefined) return clampPercent((total - used) / total * 100);
	}
	return undefined;
}

/**
 * 账号内的额度只按最高存在的那一层判断，低层不参与加总也不参与取极值：
 * 1. 摘要桶（aggregate / summarizesDetail）——已概括明细，优先且不与明细混算；
 * 2. 总池桶——非礼包且 resetAt 为 null/缺省，即 CodeBuddy 的 Total Points 这类账户级余额；
 * 3. 其余可服务窗口/备用桶——Antigravity 的 5h/周窗口等。
 * 只选最高层：被总池覆盖的小包既不能把可用性压低，也不能把它的 0 抬成可用。
 */
type TenrouterTier = { buckets: Array<Record<string, unknown>>; kind: "pool" | "window" };

function selectTenrouterTier(serviceable: Array<Record<string, unknown>>): TenrouterTier {
	const summary = serviceable.filter((bucket) => bucket.aggregate === true || bucket.summarizesDetail === true);
	if (summary.length > 0) return { buckets: summary, kind: "pool" };
	const pool = serviceable.filter((bucket) => bucket.giftPack !== true && (bucket.resetAt === null || bucket.resetAt === undefined));
	if (pool.length > 0) return { buckets: pool, kind: "pool" };
	return { buckets: serviceable, kind: "window" };
}

/**
 * 只取未来的「会刷新」额度恢复时刻，取最早候选——任一桶恢复即可用，不必全部同时恢复。
 * - 汇总/总池型：在全部非 detailOnly 桶里找 recurring===true；显式 recurring===false 的
 *   一次性礼包 resetAt 是到期而非恢复，永不作恢复证据。
 * - 窗口型：从选中的窗口桶里找有效将来 resetAt。
 * 过期或缺失一律放弃——没有恢复证据就不给时间。
 */
function tenrouterAccountReset(serviceable: Array<Record<string, unknown>>, tier: TenrouterTier, nowMs: number): string | undefined {
	const candidates = tier.kind === "pool" ? serviceable : tier.buckets;
	let earliest: { at: string; time: number } | undefined;
	for (const bucket of candidates) {
		if (tier.kind === "pool" && bucket.recurring !== true) continue;
		const at = validTime(bucket.resetAt);
		if (at === undefined) continue;
		const time = Date.parse(at);
		if (!Number.isFinite(time) || time <= nowMs) continue;
		if (!earliest || time < earliest.time) earliest = { at, time };
	}
	return earliest?.at;
}

type TenrouterAccount =
	| { state: "available"; percent?: number }
	| { state: "exhausted"; resetAt?: string }
	| { state: "unknown" };

/**
 * 把一个 active 账号折叠成可用性判断。这是可用性指标而非账务统计：
 * - detailOnly 已被 aggregate/summarizesDetail 概括，既不重复计入也不能单独证明耗尽。
 * - 只看 selectTenrouterTier 选中的最高层；小包被总池覆盖时不参与，避免误判耗尽。
 * - unlimited 表示可用但不伪造百分比；有已知正数时用最大正数。
 * - 没有正数但有无法解释的桶就判未知；只有非空且全部明确为 0 才判耗尽。
 * - limitReached 不是可服务额度，单独出现不能证明 0。
 */
function resolveTenrouterAccount(connection: Record<string, unknown>, nowMs: number): TenrouterAccount {
	const quotas = Array.isArray(connection.quotas)
		? connection.quotas.filter((bucket): bucket is Record<string, unknown> => !!bucket && typeof bucket === "object")
		: [];
	const serviceable = quotas.filter((bucket) => bucket.detailOnly !== true);
	if (serviceable.length === 0) return { state: "unknown" };
	const tier = selectTenrouterTier(serviceable);

	const percents: number[] = [];
	let unlimited = false;
	let unknownBucket = false;
	for (const bucket of tier.buckets) {
		const pct = bucketPercent(bucket);
		if (pct !== undefined) percents.push(pct);
		else if (bucket.unlimited === true) unlimited = true;
		else unknownBucket = true;
	}

	const positive = percents.filter((value) => value > 0);
	if (unlimited) return { state: "available", percent: positive.length > 0 ? Math.max(...positive) : undefined };
	if (positive.length > 0) return { state: "available", percent: Math.max(...positive) };
	if (unknownBucket) return { state: "unknown" };
	return { state: "exhausted", resetAt: tenrouterAccountReset(serviceable, tier, nowMs) };
}

/** 上游取「明确可用账号的最佳 known 百分比」；恢复时间只在整行明确耗尽（0/100）时才给。 */
function tenrouterUpstreamRow(
	connections: Array<Record<string, unknown>>,
	upstream: string,
	modelPrefix: string,
	now: Date,
): UsageRow | undefined {
	const active = connections.filter((connection) => connection.isActive === true);
	if (active.length === 0) return undefined;
	const accounts = active.map((connection) => resolveTenrouterAccount(connection, now.getTime()));

	const row: UsageRow = {
		provider: "tenrouter",
		modelPrefix,
		upstream,
		status: "ok",
		fetchedAt: now.toISOString(),
	};
	const positive = accounts.flatMap((account) => (account.state === "available" && account.percent !== undefined && account.percent > 0 ? [account.percent] : []));
	const unlimitedOnly = accounts.some((account) => account.state === "available" && account.percent === undefined);
	const hasUnknown = accounts.some((account) => account.state === "unknown");

	if (positive.length > 0) {
		const best = Math.max(...positive);
		row.remainingPercent = best;
		row.usedPercent = 100 - best;
	} else if (unlimitedOnly) {
		// 只有 unlimited（无可解释百分比）可用时省略两个百分比，不伪造 100%。
	} else if (!hasUnknown) {
		// 每个 active 账号都明确耗尽，才给出 0/100。
		row.remainingPercent = 0;
		row.usedPercent = 100;
	}
	// 其余情况（有未知账号且无可用账号）省略百分比——未知不猜。

	// resetAt 只在整行确实输出 0/100 时携带：可用（含 unlimited）或未知行不提供恢复时间。
	if (row.remainingPercent === 0) {
		let earliest: { at: string; time: number } | undefined;
		for (const account of accounts) {
			if (account.state !== "exhausted" || account.resetAt === undefined) continue;
			const time = Date.parse(account.resetAt);
			if (!Number.isFinite(time)) continue;
			if (!earliest || time < earliest.time) earliest = { at: account.resetAt, time };
		}
		if (earliest) row.resetAt = earliest.at;
	}
	return row;
}

/** 请求失败无法枚举连接时，按白名单输出三行安全状态，绝不外泄错误正文。 */
function tenrouterFallbackRows(status: UsageRow["status"], fetchedAt: string): UsageRow[] {
	return TENROUTER_UPSTREAMS.map(({ upstream, modelPrefix }) => ({
		provider: "tenrouter" as const,
		modelPrefix,
		upstream,
		status,
		fetchedAt,
	}));
}

/**
 * 查询本机 10Router 的上游额度。根地址默认 http://127.0.0.1:20128，
 * 可用 COAGENT_TENROUTER_URL 覆盖；这是只读本机端点，不读取 pi 的模型或凭据配置，
 * 请求不带 Authorization 或任何凭据头。只解析聚合所需字段，绝不输出 message、PII 或原始对象。
 */
async function queryTenrouter(deps: UsageDependencies): Promise<UsageRow[]> {
	const now = deps.now ?? (() => new Date());
	const fetcher = deps.fetch ?? globalThis.fetch;
	const root = (process.env.COAGENT_TENROUTER_URL ?? "").trim().replace(/\/+$/, "") || TENROUTER_DEFAULT_URL;
	const url = `${root}${TENROUTER_QUOTAS_PATH}`;
	try {
		return await withDeadline(async (signal) => {
			const response = await fetcher(url, { method: "GET", signal });
			if (response.status === 401 || response.status === 403) return tenrouterFallbackRows("no_auth", now().toISOString());
			if (!response.ok) return tenrouterFallbackRows("error", now().toISOString());
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				return tenrouterFallbackRows("error", now().toISOString());
			}
			const connections = body && typeof body === "object" ? (body as { connections?: unknown }).connections : undefined;
			if (!Array.isArray(connections)) return tenrouterFallbackRows("error", now().toISOString());
			const rows: UsageRow[] = [];
			for (const { upstream, modelPrefix } of TENROUTER_UPSTREAMS) {
				const matching = connections.filter(
					(connection): connection is Record<string, unknown> =>
						!!connection && typeof connection === "object" && (connection as { provider?: unknown }).provider === upstream,
				);
				const row = tenrouterUpstreamRow(matching, upstream, modelPrefix, now());
				if (row) rows.push(row);
			}
			return rows;
		}, deps.timeoutMs ?? 5000);
	} catch (error) {
		const status = error instanceof Error && error.message === "usage-timeout" ? "timeout" : "error";
		return tenrouterFallbackRows(status, now().toISOString());
	}
}

/**
 * Provider registry boundary intentionally keeps future providers out of xAI parsing.
 * xAI 与 10Router 各自持独立 deadline，并发执行；xAI 行始终是第一行且形状不变。
 */
export async function queryUsage(deps: UsageDependencies = {}): Promise<UsageRow[]> {
	const [xai, tenrouter] = await Promise.all([queryXai(deps), queryTenrouter(deps)]);
	return [xai, ...tenrouter];
}
