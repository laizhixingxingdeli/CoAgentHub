/**
 * 429 响应头的只读采集点。
 *
 * 为什么需要它：hy4（codebuddy/hy4-preview）被限流时，平台拿到的只有一句
 * 「429」——看不到要等到几点，调度器就只能盲等或盲换。上游到底带不带
 * Retry-After 事先不知道（正常响应里一个限流头都没有，429 又没法主动触发），
 * 所以先装一个只读观察点：真被限流那次，从失败信息里直接读出来。
 *
 * 只观察，不改行为：请求原样发出、响应原样返回、原 fetch 抛出的异常原样上抛，
 * 且不读响应体（读了会破坏流式消费）。只记 429 的**响应头名**，以及名字含
 * retry-after / ratelimit / rate-limit / reset 的头**值**；请求头一律不碰
 * （那里有凭据）。
 *
 * 为什么用 defineProperty 的 getter/setter 而不是直接赋值：pi 起来之后
 * `undici.install()` 会把 globalThis.fetch 换成 undici 的实现，直接赋值包装
 * 会被它整个盖掉。留一个 setter，谁往上赋值都再包一层。
 */

// 名字里含这些片段的头才取值；其余只记名字。大小写不敏感（Headers 已归一化）。
const RATE_LIMIT_HEADER_NAME = /retry-after|ratelimit|rate-limit|reset/i;

/** 一次 run 最多留多少条 429 观察，以及一条响应最多记多少头。 */
const MAX_OBSERVATIONS = 16;
const MAX_HEADERS_PER_RESPONSE = 64;

export interface RateLimitObservation {
	/** 429 响应的全部响应头名（不含值）。 */
	headerNames: string[];
	/** 限流相关头的名字与值。顺序按首次出现。 */
	rateLimitHeaders: { name: string; value: string }[];
}

export interface RateLimitProbe {
	observations(): readonly RateLimitObservation[];
	/** 本次观察的合并结果；一个 429 都没收到时返回 undefined。 */
	summary(): RateLimitObservation | undefined;
	/** 摘掉包装、恢复建观察器之前那个 fetch。 */
	stop(): void;
}

/** 包装过的 fetch 记住被它包住的那一个，stop() 时好还原。 */
const wrappedInner = new WeakMap<object, unknown>();
/** 包装过的 fetch 记住是哪一次观察器包的：自己人不再包第二层。 */
const wrappedOwner = new WeakMap<object, object>();

/** 抽头名/值：优先 Headers（keys+get），退化到数组对与普通对象。 */
function headerEntries(headers: unknown): { name: string; value: string }[] {
	const entries: { name: string; value: string }[] = [];
	const asHeaders = headers as { keys?: () => Iterable<string>; get?: (name: string) => unknown } | undefined;
	if (headers && typeof asHeaders?.keys === "function" && typeof asHeaders.get === "function") {
		for (const name of asHeaders.keys()) {
			if (typeof name !== "string") continue;
			const value = asHeaders.get(name);
			if (typeof value === "string") entries.push({ name, value });
			if (entries.length >= MAX_HEADERS_PER_RESPONSE) break;
		}
		return entries;
	}
	if (Array.isArray(headers)) {
		for (const pair of headers) {
			if (!Array.isArray(pair)) continue;
			const [name, value] = pair;
			if (typeof name === "string" && typeof value === "string") entries.push({ name, value });
			if (entries.length >= MAX_HEADERS_PER_RESPONSE) break;
		}
		return entries;
	}
	if (headers && typeof headers === "object") {
		for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
			if (typeof value === "string") entries.push({ name, value });
			if (entries.length >= MAX_HEADERS_PER_RESPONSE) break;
		}
	}
	return entries;
}

function observeResponse(response: unknown, observations: RateLimitObservation[]): void {
	const status = (response as { status?: unknown } | undefined)?.status;
	if (status !== 429) return;
	const entries = headerEntries((response as { headers?: unknown } | undefined)?.headers);
	const observation: RateLimitObservation = {
		headerNames: entries.map((entry) => entry.name),
		rateLimitHeaders: entries
			.filter((entry) => RATE_LIMIT_HEADER_NAME.test(entry.name))
			.map((entry) => ({ name: entry.name, value: entry.value })),
	};
	if (observations.length >= MAX_OBSERVATIONS) observations.shift();
	observations.push(observation);
}

function wrapFetch(base: typeof fetch, observations: RateLimitObservation[], owner: object): typeof fetch {
	const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		// 不在这里 catch：原 fetch 的异常行为必须原样上抛，观察失败也不能影响它。
		const response = await base(input, init);
		try {
			observeResponse(response, observations);
		} catch {
			/* 观察失败绝不影响主流程 */
		}
		return response;
	}) as typeof fetch;
	wrappedInner.set(wrapped as unknown as object, base);
	wrappedOwner.set(wrapped as unknown as object, owner);
	return wrapped;
}

/**
 * 装观察器。每个 Attempt 装一个：观察结果只属于这一次，上一个 Attempt 的
 * 429 不会漏到下一次。
 */
export function startRateLimitProbe(): RateLimitProbe {
	const observations: RateLimitObservation[] = [];
	const owner = {};
	const previous = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	let current = wrapFetch(globalThis.fetch, observations, owner);

	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		enumerable: previous?.enumerable ?? true,
		get: () => current,
		set: (value: unknown) => {
			// 自己包过的那一层不再包第二遍，否则同一个 429 会被记两次。
			current =
				typeof value === "function" && wrappedOwner.get(value as object) !== owner
					? wrapFetch(value as typeof fetch, observations, owner)
					: (value as typeof fetch);
		},
	});

	return {
		observations: () => observations,
		summary: () => summaryOf(observations),
		stop: () => {
			const live = current;
			const inner = typeof live === "function" ? wrappedInner.get(live as unknown as object) : undefined;
			const restored = typeof inner === "function" ? (inner as typeof fetch) : live;
			Object.defineProperty(globalThis, "fetch", {
				configurable: true,
				enumerable: previous?.enumerable ?? true,
				writable: true,
				value: restored,
			});
		},
	};
}

/** 多条 429 合成一条：头名取并集，限流头的值以最后一次为准。 */
export function summaryOf(observations: readonly RateLimitObservation[]): RateLimitObservation | undefined {
	if (observations.length === 0) return undefined;
	const names: string[] = [];
	const seenName = new Set<string>();
	const values = new Map<string, string>();
	for (const observation of observations) {
		for (const name of observation.headerNames) {
			if (seenName.has(name)) continue;
			seenName.add(name);
			names.push(name);
		}
		for (const header of observation.rateLimitHeaders) values.set(header.name, header.value);
	}
	return {
		headerNames: names,
		rateLimitHeaders: [...values].map(([name, value]) => ({ name, value })),
	};
}

/**
 * 把摘要挂到失败信息末尾。没收到 429（summary 为 undefined）时一字不改。
 *
 * 必须在上游失败分类**之后**调用：这段中文摘要是给人看的，不能反过来参与
 * 分类的正则匹配。
 */
export function appendRateLimitSummary(
	failureMessage: string,
	summary: RateLimitObservation | undefined,
): string {
	if (!summary) return failureMessage;
	const names = summary.headerNames.length > 0 ? summary.headerNames.join("、") : "（空）";
	const limited =
		summary.rateLimitHeaders.length > 0
			? summary.rateLimitHeaders.map((header) => `${header.name}=${header.value}`).join("；")
			: "无";
	return `${failureMessage}（429 响应头：${names}；限流相关：${limited}）`;
}
