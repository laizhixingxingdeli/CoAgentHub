/**
 * 会话输出着色（Contract AC1 / AC3 的呈现层）。
 *
 * 要解决的问题：实时输出的每一行都来自某一跳，而**行本身不知道自己是谁吐的**。
 * 面板上全是同一种颜色时，协调者和执行者的正文混在一起，人只能靠时间顺序猜，
 * 猜错的代价是把 L2 说的话当成 L1 交回来的结论。
 *
 * 身份从哪来，按可信度排：
 *   1. 本 Mission 的 `attempt.started.data.kind`——发牌那一刻平台写下来的，
 *      是权威来源（`independent_reviewer` → 检视者）。
 *   2. 已经取到的 Attempt 明细的 `kind`——同一份权威数据的另一个取件口，
 *      用来补齐活动流里没写 kind 的那些 id（深链进来时活动流可能还没有那一跳）。
 *   3. `coord-N` / `*.exec-N` 的形状——只在**当前 Mission 的活动流里确实出现过
 *      这个 id**、且没有任何显式 kind 时兜底。再放宽一步（凭形状直接认）就会把
 *      别的 Mission 的同名 id 认成自己的——`coord-1` 每条任务都有。
 *   4. 其余一律「未知」灰。**不能默认协调者**：默认成协调者，一行没认出来的
 *      输出就理直气壮地冒充 L2 的结论，而界面上看不出它是猜的。
 *
 * 为什么不把角色缓存到 chunk 上：身份是**随数据变**的——实时行常常先于活动流
 * 到达，那一刻只能判未知，活动流一到就得变。把角色写死在 chunk 上，先到的那批
 * 行会永远停在灰色，刷新一下又对了；这种 bug 最难被当成 bug 报上来。
 *
 * 零 import、不拼 HTML、不 esc、不碰 DOM：和 narrate.js 同一层，node 里能直接
 * 喂假数据断言，浏览器里也不会有第二份实现（转义留给调用方）。
 */

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();

/** 呈现角色白名单。CSS 类名只从这一份来；多一个拼错的角色名就是一行没颜色的输出。 */
export const OUTPUT_ROLES = ['coordinator', 'executor', 'reviewer', 'platform', 'unknown'];

const ROLE_LABELS = {
  coordinator: '协调者',
  executor: '执行者',
  reviewer: '检视者',
  platform: '平台',
  unknown: '未知',
};

const ROLE_CLASSES = {
  coordinator: 'so-coordinator',
  executor: 'so-executor',
  reviewer: 'so-reviewer',
  platform: 'so-platform',
  unknown: 'so-unknown',
};

/** 白名单外的角色一律落到「未知」——宁可灰，也不要一个 CSS 里没有的类名。 */
export function normalizeOutputRole(role) {
  const r = text(role);
  return OUTPUT_ROLES.includes(r) ? r : 'unknown';
}

export function outputRoleLabel(role) {
  return ROLE_LABELS[normalizeOutputRole(role)];
}

export function outputRoleClass(role) {
  return ROLE_CLASSES[normalizeOutputRole(role)];
}

/**
 * `attempt.started.data.kind` → 呈现角色。
 *
 * 空 kind 回**空串**（不是 'unknown'）：调用方要靠这个区别决定能不能用形状兜底。
 * 认不出来的 kind 回 'unknown'，那是**显式的未知**——再拿 id 形状去猜，等于把
 * 平台明确说过的话推翻。
 */
export function outputRoleFromKind(kind) {
  const k = text(kind);
  if (!k) return '';
  if (k === 'coordinator') return 'coordinator';
  if (k === 'executor') return 'executor';
  if (k === 'independent_reviewer' || k === 'reviewer') return 'reviewer';
  if (k === 'platform') return 'platform';
  return 'unknown';
}

/**
 * 实时行只保留判定身份与去重需要的字段。
 *
 * `seq` 不显示在屏幕上，但它是游标之外「这一行是第几条」的凭据；丢掉之后，
 * 「这两段输出是不是同一次流」就再也答不上来了。`missionId` 留作防串校验：
 * 换任务时残留的行会被解析器按它判成未知。
 */
export function normalizeLiveLine(chunk) {
  const c = chunk || {};
  return {
    missionId: c.missionId === undefined || c.missionId === null ? '' : String(c.missionId),
    attemptId: c.attemptId === undefined || c.attemptId === null ? '' : String(c.attemptId),
    seq: c.seq,
    at: c.at,
    kind: c.kind || 'text',
    text: c.text === undefined || c.text === null ? '' : String(c.text),
  };
}

/**
 * 由「本页活动流 + 已取到的 Attempt kind」造一个身份解析器。
 *
 * 每次渲染都新造一个，**不往 chunk 上写**（见文件头「为什么不缓存」）。
 * `attemptKinds` 是 id → kind 的补件口：`loadAttempt` 拉到明细后把 kind 记进来，
 * 于是「活动流还没出现这一跳但人已经深链到它」时也认得出身份。
 */
export function createOutputIdentity(context) {
  const ctx = context || {};
  const missionId = ctx.missionId === undefined || ctx.missionId === null ? '' : String(ctx.missionId);
  const activity = ctx.activity || [];
  const extra = ctx.attemptKinds || {};
  const seenIds = new Set();
  const kinds = new Map();

  for (const e of activity) {
    if (!e || e.attemptId === undefined || e.attemptId === null || String(e.attemptId) === '') continue;
    const id = String(e.attemptId);
    seenIds.add(id);
    if (e.kind !== 'attempt.started') continue;
    const kind = outputRoleFromKind(e.data && e.data.kind);
    if (kind) kinds.set(id, kind);
  }
  for (const id of Object.keys(extra)) {
    const kind = outputRoleFromKind(extra[id]);
    if (!kind) continue;
    // 活动流里已经有显式 kind 时不覆盖：那是同一份权威数据，先后不该改结果。
    if (seenIds.has(id) && kinds.has(id)) continue;
    kinds.set(id, kind);
  }

  const roleOf = (chunk) => {
    if (!chunk) return 'unknown';
    const chunkMission = chunk.missionId === undefined || chunk.missionId === null ? '' : String(chunk.missionId);
    // 别的 Mission 的残留行不认身份：宁可灰，也不能拿别的任务的活动流给这一页涂色。
    if (chunkMission && missionId && chunkMission !== missionId) return 'unknown';
    const id = chunk.attemptId === undefined || chunk.attemptId === null ? '' : String(chunk.attemptId);
    if (!id) return 'unknown';
    if (kinds.has(id)) return kinds.get(id);
    // 形状兜底的前提是「这个 id 是本 Mission 活动流里出现过的」。
    if (!seenIds.has(id)) return 'unknown';
    if (/^coord-\d+$/.test(id)) return 'coordinator';
    if (/\.exec-\d+$/.test(id)) return 'executor';
    return 'unknown';
  };

  return { roleOf, missionId, knownIds: seenIds };
}

/**
 * 右侧「历史输出末尾」该不该出现（Contract AC3）。
 *
 * 门禁三件：**id 必须是所选这一跳的**、这一跳**已经结束**、保存的 output
 * **非空**。少一条就会出现「点了个还在跑的环节，旁边却摆着一段已保存输出」，
 * 人会把上一跳的结尾当成这一跳正在进行的东西。
 *
 * `status === undefined` 放行是刻意的：真实接口 (getAttemptDetail) 一定回 status，
 * 所以生产里「在跑」永远被 `in_progress` 挡掉；只有手工夹具/旧形状会缺 status，
 * 那时按「没有相反证据」处理，不假装它一定没结束。
 */
export function savedTailEligible(input) {
  const it = input || {};
  const groupId = text(it.groupAttemptId);
  const attemptId = text(it.attemptId);
  if (!groupId || !attemptId || attemptId !== groupId) return false;
  if (text(it.attemptOutput) === '') return false;
  const status = text(it.attemptStatus);
  if (status === 'in_progress') return false;
  return status === 'succeeded' || status === 'failed' || status === '' || Boolean(it.groupEnded);
}

/**
 * 历史尾部正文：**整份原样切片**，不按 `read` / `bash` 开头删行。
 * 那是模型的正文，不是工具明细——正文里以工具名开头的句子被删掉，
 * 读的人只会觉得「它跳过了这一段」，而不会怀疑是界面删的。
 */
export function savedTailText(attemptOutput, maxChars = 20000) {
  const raw = attemptOutput === undefined || attemptOutput === null ? '' : String(attemptOutput);
  if (raw.trim() === '') return '';
  return raw.length <= maxChars ? raw : raw.slice(-maxChars);
}

/** 折叠入口的名字。只在这里写一次：入口文案与测试各写一份，改了其中一处就悄悄对不上。 */
export function savedTailTitle() {
  return '历史输出末尾（已保存原始尾部）';
}

/** 折叠入口旁边那句脱敏说明：写清「为什么这一块看起来不像完整输出」。 */
export function savedTailNote() {
  return '这是脱敏后保存的原始尾部，只保留最后 20000 字符。';
}
