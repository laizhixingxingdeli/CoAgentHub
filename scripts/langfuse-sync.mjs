/**
 * 质量同步 CLI（W-722）：把平台上已经投影好的质量记录经既有传输写入本机 Langfuse。
 *
 * 为什么需要这个独立入口：pi 运行时只观测「模型调用」，平台的 L2/L3/VR 事实不在它的
 * 视野里；而把这些结论塞进 agent 的 prompt 或工具，等于让模型替平台解释自己的评审。
 * 独立 CLI 的好处是它没有身份、没有写权限：只能 GET 几个只读接口，只能 POST 到本机
 * Langfuse，失败也不会影响平台状态。
 *
 * 三条硬约束决定了本文件的结构：
 * 1) 只读。只允许五个 GET 路径（列表/Mission/activity/attempt/report），别的一律
 *    在发请求之前拒掉。为什么不用 fetch：fetch 会吃系统代理，回环地址被代理转走时
 *    错误会伪装成「网络故障」，而这里失败的后果是「没同步」，非常难排查。
 * 2) 不猜关联。受评 Attempt、report id 只从 HTTP 实际给出的字段取；取不到就是缺失，
 *    由投影层落 missing 观察。用别的 Attempt 顶上会让 Langfuse 里两条 trace 看起来
 *    一样正常，错了也看不出来。
 * 3) 进度与发送分离。`capturedReviews`（已捕获的完整记录）在发送前就原子落盘，
 *    所以 Langfuse 断连时「捕获到的原文」不会跟着丢；而 `acked`（已确认 id）只在
 *    传输层真的 resolve(true) 之后才写。把两者混成一个列表，就会出现「断网一分钟后
 *    重跑，历史评审被当成已同步，永远不进 Langfuse」。
 *
 * 只依赖 Node 内置模块（clone 下来不装依赖就能跑）；不读 process.env、不打印凭据。
 */
import http from 'node:http';
import https from 'node:https';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTransport, loadConfig } from './langfuse-transport.mjs';
import { projectQualityRecords } from './langfuse-quality-records.mjs';

const DEFAULT_PLATFORM_URL = 'http://127.0.0.1:3101';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_MISSIONS = 50;
const MIN_CLI_INTERVAL_MS = 1000;
const MAX_CLI_ITERATIONS = 50;
/**
 * ACK 去重集合的有界保留条数。
 *
 * 为什么必须有界：这是一个只增不减的集合，长期运行的同步器会把它写成几十 MB，
 * 而每轮都要整份读写。超出后丢最旧的 id 是安全的——服务器对同 id 幂等，最坏情况
 * 是重发一条早就发过的记录；而未确认的 id 从来不进这个集合，所以丢的永远不是
 * 「还没发出去」的那一条。
 */
const MAX_ACKED_IDS = 20000;
/** 每个工单每轮最多翻多少页：有界是为了让「一条工单有几千条历史」不会吃掉整轮预算。 */
const MAX_REVIEW_PAGES_PER_WORK_ITEM = 50;
const REVIEW_PAGE_LIMIT = 50;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * 只读路径白名单。白名单而不是黑名单：黑名单漏一个（`/live`、`/diff`、
 * `/delivery/...`）就是把平台内部状态当观测数据发出去，而这类路径还在不断增加。
 * attempt id 里带点（`W-1.exec-1`），所以段用 `[^/]+` 而不是「只允许字母数字」。
 */
const REVIEW_HISTORY_PATH_RE = /^\/api\/missions\/[^/]+\/work-items\/[^/]+\/reviews$/;

const ALLOWED_PATHS = [
  /^\/api\/missions$/,
  /^\/api\/missions\/[^/]+$/,
  /^\/api\/missions\/[^/]+\/activity$/,
  /^\/api\/missions\/[^/]+\/attempts\/[^/]+$/,
  /^\/api\/missions\/[^/]+\/validation-reports\/[^/]+$/,
  REVIEW_HISTORY_PATH_RE,
];

/**
 * 查询串白名单：**只有**评审历史允许带参数，而且只允许 cursor/limit 两个键、
 * 取值只能是数字（cursor >= 0，limit 1..100）。
 *
 * 为什么逐键校验而不是「路径对就行」：带查询串的只读请求是路径穿越最方便的形状
 * （`?x=../../state`、`?limit=1e9`、重复键把校验值覆盖掉）。平台自己也不会给
 * 这两个参数之外的语义，所以拒绝比兼容便宜。
 */
function allowedQuery(path, query) {
  if (!REVIEW_HISTORY_PATH_RE.test(path)) return false;
  const params = new URLSearchParams(query);
  for (const [key, value] of params) {
    if (!/^\d+$/.test(value)) return false;
    if (key === 'cursor') continue;
    if (key === 'limit') {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** 即使将来白名单放宽，这几样也永远不读：平台自己的运行状态与 Delivery 不属于观测面。 */
const FORBIDDEN_PATH_RE = /\.coagent-state\.json|delivery|\/live$|\/diff$/i;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const emptyProgress = () => ({
  version: 1,
  acked: [],
  capturedReviews: [],
  // projects：项目范围的轮转游标（lastMissionId / wrapped）。
  // reviewCursors：missionId -> workItemId -> 下一页 cursor。
  // 两者都是**可选**字段：version 1 的旧进度里没有它们，读进来就是空对象。
  projects: {},
  reviewCursors: {},
});

/**
 * platformUrl 只允许本机回环、http(s)、无用户信息、无查询串。
 * 带 userinfo 的地址会把凭据塞进每次请求行，查询串会被平台日志原样记下来；
 * 两者都不该出现在「读质量数据」的地址里。`..` 与编码过的分隔符同理拒绝：
 * URL 归一化之后剩下的逃逸途径就是这些。
 */
function safePlatformUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  for (const segment of url.pathname.split('/')) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === '..' || decoded === '.') return null;
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * 请求前的路径检查。`%` 一并拒绝：编码是绕过段数限制的唯一手段（`%2F` 解出来是分隔符），
 * 而平台自己的 id 不需要编码（`M-1`、`W-1.exec-1`），所以拒绝整条更简单也更安全。
 */
function allowedPath(path) {
  if (typeof path !== 'string') return false;
  if (FORBIDDEN_PATH_RE.test(path)) return false;
  // `%` 一律拒绝（编码是绕过段数限制的手段），所以查询串也不接受百分号编码。
  if (path.includes('..') || path.includes('\\') || path.includes('%')) return false;
  const parts = path.split('?');
  if (parts.length > 2) return false;
  const [plain, query] = parts;
  if (query !== undefined && !allowedQuery(plain, query)) return false;
  return ALLOWED_PATHS.some((pattern) => pattern.test(plain));
}

/**
 * 一次 GET。**不抛异常**：网络问题一律变成 `{ ok:false }`，否则一条超时会把整轮同步
 * 连同已确认的进度一起打断。`status` 单独带出来，调用方需要区分 404（缺失的事实）
 * 与真故障（读取失败）。
 */
function httpGetJson({ url, controlToken, timeoutMs }) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, status: 0 });
      return;
    }
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const headers = { accept: 'application/json' };
    // 控制面凭据只放请求头；不加 x-coagent-run——这不是 agent 的 run token，混进来会
    // 让平台把「同步器」当成某次执行。
    if (isText(controlToken)) headers.authorization = `Bearer ${controlToken}`;
    const client = target.protocol === 'https:' ? https : http;
    let req;
    try {
      req = client.request(target, { method: 'GET', headers }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          // 响应体也要有界：对端吐个不停时不能把内存吃干。
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy();
            done({ ok: false, status: 0 });
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => done({ ok: false, status: 0 }));
        res.on('end', () => {
          const status = Number(res.statusCode) || 0;
          if (status < 200 || status >= 300) {
            done({ ok: false, status });
            return;
          }
          try {
            done({ ok: true, status, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            done({ ok: false, status });
          }
        });
      });
    } catch {
      done({ ok: false, status: 0 });
      return;
    }
    timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        // 已经结束的请求 destroy 无害。
      }
      done({ ok: false, status: 0 });
    }, timeoutMs);
    timer.unref?.();
    req.on('error', () => done({ ok: false, status: 0 }));
    req.end();
  });
}

/** 进度文件名只由 scope 决定：同一 Mission 每次都写同一个文件，去重才有意义。 */
const fileSafe = (value) => String(value).replace(/^\.+/, '_').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

export function defaultProgressPath({ missionId, projectId } = {}) {
  const scope = isText(missionId) ? `mission-${fileSafe(missionId)}` : `project-${fileSafe(projectId ?? 'unknown')}`;
  // 默认落在用户家目录：进度里有评审正文片段，放在仓库里会被误提交。
  return join(homedir(), '.coagent', 'langfuse-progress', `${scope}.json`);
}

/**
 * 读进度。坏 JSON / 版本不符 / 形状不符一律 `ok:false` + 空进度。
 * 为什么空进度还要标失败：这时无法判断哪些已经发过，若继续发送就会把整段历史再发
 * 一遍，而 Langfuse 侧会把它读成「又评审了一次」。调用方看到 ok:false 必须停手，
 * 并且**不覆盖**这个文件（用户可能只是手改坏了一行）。
 */
async function readProgress(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, progress: emptyProgress() };
    return { ok: false, progress: emptyProgress() };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, progress: emptyProgress() };
  }
  if (!isObject(parsed) || parsed.version !== 1) return { ok: false, progress: emptyProgress() };
  if (!Array.isArray(parsed.acked) || !Array.isArray(parsed.capturedReviews)) {
    return { ok: false, progress: emptyProgress() };
  }
  if (parsed.acked.some((id) => !isText(id))) return { ok: false, progress: emptyProgress() };
  return {
    ok: true,
    progress: {
      version: 1,
      acked: [...parsed.acked],
      capturedReviews: parsed.capturedReviews,
      projects: normalizeProjects(parsed.projects),
      reviewCursors: normalizeCursors(parsed.reviewCursors),
    },
  };
}

/** 轮转游标逐项校验：读不懂的那一条当没有，绝不把坏值写回平台读取逻辑。 */
function normalizeProjects(value) {
  const out = {};
  if (!isObject(value)) return out;
  for (const [projectId, entry] of Object.entries(value)) {
    if (!isText(projectId) || !isObject(entry)) continue;
    out[projectId] = {
      lastMissionId: isText(entry.lastMissionId) ? entry.lastMissionId : null,
      wrapped: entry.wrapped === true,
    };
  }
  return out;
}

function normalizeCursors(value) {
  const out = {};
  if (!isObject(value)) return out;
  for (const [missionId, cursors] of Object.entries(value)) {
    if (!isText(missionId) || !isObject(cursors)) continue;
    const items = {};
    for (const [workItemId, cursor] of Object.entries(cursors)) {
      if (!isText(workItemId) || !Number.isInteger(cursor) || cursor < 0) continue;
      items[workItemId] = cursor;
    }
    out[missionId] = items;
  }
  return out;
}

/** 写盘用的视图：只写这四个字段，顺序固定，便于人工核对差异。 */
const progressSnapshot = (progress) => ({
  version: 1,
  acked: progress.acked,
  capturedReviews: progress.capturedReviews,
  projects: progress.projects,
  reviewCursors: progress.reviewCursors,
});

/** 某个项目的轮转游标（就地建好，便于后续写入）。 */
function projectCursor(progress, projectId) {
  if (!isObject(progress.projects)) progress.projects = {};
  const existing = progress.projects[projectId];
  if (isObject(existing)) return existing;
  const created = { lastMissionId: null, wrapped: false };
  progress.projects[projectId] = created;
  return created;
}

/** 某个 Mission 的评审分页游标（就地建好）。 */
function missionCursors(progress, missionId) {
  if (!isObject(progress.reviewCursors)) progress.reviewCursors = {};
  const existing = progress.reviewCursors[missionId];
  if (isObject(existing)) return existing;
  const created = {};
  progress.reviewCursors[missionId] = created;
  return created;
}

let tempCounter = 0;

/**
 * 杀软 / 索引器会短暂占住刚写完的临时文件或目标，rname 抛这三个码。
 * 只认这三个：别的错误（盘满、路径不对）重试也没用，早抛才不会把同步拖满两秒。
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** 最多 10 次（含首次）；退避总等待封顶 2s。同步进度不是常驻服务，但也不能为一次占文件无限睡。 */
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_MAX_WAIT_MS = 2_000;

/** 异步等待：进度写在 async 路径上，不能用 Atomics.wait 卡住事件循环。 */
function sleepMs(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 同一个临时文件重试原地 rename。耗尽或不可重试时抛出原错误，从不删目标。
 *
 * 为什么不能失败后 unlink 目标再 rename：那次窗口里第二次 rename 再失败，唯一的去重依据就没了。
 * 下一轮要么停住，要么把整段历史再发一遍。
 */
async function renameReplacing(tmp, file, renameFile, retryWait) {
  let wait = 5;
  let waited = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFile(tmp, file);
      return;
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : '';
      const transient = TRANSIENT_RENAME_CODES.has(code);
      if (!transient || attempt >= RENAME_MAX_ATTEMPTS || waited + wait > RENAME_MAX_WAIT_MS) {
        throw error;
      }
      await retryWait(wait);
      waited += wait;
      wait = Math.min(wait * 2, 200);
    }
  }
}

/**
 * 原子写：同目录唯一临时文件写完再原地 rename。
 *
 * 为什么必须原子：进度文件是唯一的去重依据，写到一半崩掉会留下一个既不能读、也
 * 不能当空的半截 JSON；下一轮读它会判成 ok:false，同步就永久停在那里。
 * 替换失败只清本次临时文件：清不掉也不能盖住原错误，更不能顺手删掉旧目标。
 *
 * `io.renameFile` / `io.retryWait` 默认是真实的 fs.rename 与 setTimeout，只给测试注入。
 * 不做 CLI 开关：开关会跟着进真实同步，而这里要挡的是替换约定本身。
 *
 * 返回写进去的字节数：调用方把它报出来，让「进度在变大」这件事看得见（捕获的
 * 历史事实不能随便删，所以只能靠观测提醒）。不做 fsync：这里不承诺断电级持久化。
 */
async function writeProgress(file, progress, now, io) {
  const renameFile = typeof io?.renameFile === 'function' ? io.renameFile : rename;
  const retryWait = typeof io?.retryWait === 'function' ? io.retryWait : sleepMs;
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const stamp = typeof now === 'function' ? now() : Date.now();
  tempCounter += 1;
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${stamp}.${tempCounter}.tmp`);
  const text = `${JSON.stringify(progress)}\n`;
  await writeFile(tmp, text, 'utf8');
  try {
    await renameReplacing(tmp, file, renameFile, retryWait);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      // 清不掉本次临时文件不该盖住真正的写失败，也不去动旧目标。
    }
    throw error;
  }
  return Buffer.byteLength(text, 'utf8');
}

/** 必须且只能有一个 scope。库函数也校验：CLI 之外还有人直接 import。 */
function scopeOf({ missionId, projectId }) {
  const hasMission = isText(missionId);
  const hasProject = isText(projectId);
  if (hasMission === hasProject) throw new TypeError('必须且只能指定 missionId 或 projectId 之一');
  return hasMission ? { kind: 'mission', id: missionId } : { kind: 'project', id: projectId };
}

/** 传输层的 promise 从不 reject，但注入进来的实现可能抛：抛错按未确认处理。 */
async function confirmedBy(send) {
  try {
    return (await send()) === true;
  } catch {
    return false;
  }
}

/**
 * 读一张工单的评审历史（逐页）。
 *
 * 三个诚实性要求决定了形状：
 * 1) 只有 404 才代表「旧平台没有这个接口」，此时调用方退回 lastReview。其它任何
 *    失败（网络/500/形状不符）都是「没读到」，必须让本轮整体未完成，不能把当前
 *    lastReview 当成全部历史。
 * 2) 分页有界：每轮最多翻 MAX_REVIEW_PAGES_PER_WORK_ITEM 页，没翻完就显式标 partial，
 *    并把下一页 cursor 落进进度，下一轮从那里继续。
 * 3) cursor 必须是平台给的 nextCursor；自己拿 items.length 推会在一页里夹杂不可识别
 *    条目时错位，那等于凭空少读几条。
 * 4) 「读完了」只有一个证据：nextCursor 明确为 null。缺失、负数、回退、相同、小数、
 *    字符串都只说明这一页没给出可信的下一页，本轮必须未完成（保留已读条目、cursor
 *    停在当前页起点，下一轮重试），不能当成「已经拿全了」。
 */
async function readReviewHistory({ missionId, workItemId, get, cursor }) {
  const items = [];
  let next = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  let pages = 0;
  let total;
  for (;;) {
    const read = await get(
      `/api/missions/${missionId}/work-items/${workItemId}/reviews?cursor=${next}&limit=${REVIEW_PAGE_LIMIT}`,
    );
    // 404 只在**第一页的第一次请求**才代表「旧平台没有这个接口」。翻到中间才 404 是读取
    // 故障：丢掉已读条目退回 lastReview，等于把读到的历史整段抹掉。续读时（进参 cursor
    // 非零）第一次请求就已经是中间页，同样不得退回 legacy。
    if (read.status === 404) {
      if (pages === 0 && next === 0) return { legacy: true, items: [], nextCursor: 0 };
      return { ok: false, items, nextCursor: next, partial: true };
    }
    if (!read.ok || !isObject(read.json) || !Array.isArray(read.json.items)) {
      return { ok: false, items, nextCursor: next };
    }
    pages += 1;
    for (const entry of read.json.items) {
      if (isObject(entry) && isObject(entry.review)) items.push(entry.review);
    }
    if (Number.isFinite(read.json.total)) total = Number(read.json.total);
    const advanced = read.json.nextCursor;
    if (advanced === null) {
      // 唯一的「读完」证据：平台明确说没有下一页了。
      return { ok: true, items, nextCursor: null, total };
    }
    if (!Number.isInteger(advanced) || advanced < 0 || advanced <= next) {
      // 坏 cursor 不是「读完」：保留已读条目，cursor 停在当前页起点，下一轮重试。
      // 也不能拿它接着翻，否则同一个 cursor 会无限循环。
      return { ok: false, items, nextCursor: next, partial: true };
    }
    next = advanced;
    if (pages >= MAX_REVIEW_PAGES_PER_WORK_ITEM) {
      // 有界：把「还有多少没读到」显式写出来，并由调用方标 partial、保留已捕获。
      return { ok: true, items, nextCursor: next, total, partial: true };
    }
  }
}

/**
 * 同步一个 Mission 的全部可证实记录。
 *
 * 顺序是刻意的：读事实 -> 投影 -> 先把捕获写盘 -> 再发送 -> 最后写已确认。
 * 任何一步失败都停在原地，绝不把「没发出去」记成「发过了」。
 */
async function syncMission({ missionId, get, progressPath, config, transport, now, signal, io }) {
  const result = {
    ok: true,
    sent: 0,
    skipped: 0,
    unconfirmed: 0,
    missing: 0,
    reviewPages: 0,
    capturedReviews: 0,
    partial: false,
  };
  const missionRead = await get(`/api/missions/${missionId}`);
  if (!missionRead.ok || !isObject(missionRead.json)) return { ...result, ok: false };
  const mission = missionRead.json;
  if (mission.missionId !== missionId) return { ...result, ok: false };
  const activityRead = await get(`/api/missions/${missionId}/activity`);
  if (!activityRead.ok || !Array.isArray(activityRead.json)) return { ...result, ok: false };
  const activity = activityRead.json;

  const read = await readProgress(progressPath);
  if (!read.ok) {
    // 进度读不出来就不发：没有去重依据，发一遍等于把整段历史重投。
    return { ...result, ok: false, progressUnreadable: true };
  }
  const progress = read.progress;

  // 1) 评审历史：逐工单逐页读。每一条都是完整快照，受评者只认记录自己的字段。
  const reviewHistory = {};
  const lastReviewFallback = [];
  const cursors = missionCursors(progress, missionId);
  for (const item of Array.isArray(mission.workItems) ? mission.workItems : []) {
    if (!isObject(item) || !isText(item.id)) continue;
    const workItemId = item.id;
    const history = await readReviewHistory({
      missionId,
      workItemId,
      get,
      cursor: Number.isInteger(cursors[workItemId]) ? cursors[workItemId] : 0,
    });
    if (history.legacy) {
      // 旧平台：这个工单退回 lastReview。记录下 fallback，投影层才敢用它。
      lastReviewFallback.push(workItemId);
      delete cursors[workItemId];
      continue;
    }
    if (!history.ok) {
      // 历史读失败：不投影这件工单的 lastReview（不把「没读到」当成「只有这一条」），
      // 但已经读到的页是真的，保留它们并把本轮标成 partial；cursor 停在失败的那一页，
      // 下一轮从那里重试。
      result.ok = false;
      result.historyIncomplete = true;
      result.partial = true;
      if (history.items.length > 0) reviewHistory[workItemId] = history.items;
      if (Number.isInteger(history.nextCursor)) cursors[workItemId] = history.nextCursor;
      continue;
    }
    result.reviewPages += Math.max(1, Math.ceil(history.items.length / REVIEW_PAGE_LIMIT));
    reviewHistory[workItemId] = history.items;
    if (history.nextCursor === null || history.nextCursor === undefined) delete cursors[workItemId];
    else {
      cursors[workItemId] = history.nextCursor;
      // 截断是事实，必须显式上报：否则读的人会以为这一轮已经拿全了历史。
      result.partial = true;
    }
  }

  // 只取「受评」Attempt 与 ValidationReport：review.recorded 上的 attemptId 是评审者，
  // 把它也当受评者去取明细，就等于给了投影层一份错身份的材料。
  const attemptIds = new Set();
  const reportIds = new Set();
  for (const history of Object.values(reviewHistory)) {
    for (const review of history) {
      if (isText(review.submittedAttemptId)) attemptIds.add(review.submittedAttemptId);
    }
  }
  for (const workItemId of lastReviewFallback) {
    const item = (Array.isArray(mission.workItems) ? mission.workItems : []).find(
      (entry) => isObject(entry) && entry.id === workItemId,
    );
    const submitted = isObject(item) && isObject(item.lastReview) ? item.lastReview.submittedAttemptId : undefined;
    if (isText(submitted)) attemptIds.add(submitted);
  }
  for (const event of activity) {
    if (!isObject(event) || event.kind !== 'validation.reported') continue;
    const data = isObject(event.data) ? event.data : {};
    if (isText(data.submittedAttemptId)) attemptIds.add(data.submittedAttemptId);
    if (isText(data.reportId)) reportIds.add(data.reportId);
  }

  const reports = {};
  const attempts = {};
  for (const reportId of reportIds) {
    const reportRead = await get(`/api/missions/${missionId}/validation-reports/${reportId}`);
    if (reportRead.ok && isObject(reportRead.json)) reports[reportId] = reportRead.json;
    // 404 是「这份报告不存在」这个事实本身，不是读取故障；其它状态/网络错误才是故障。
    else if (reportRead.status !== 404) result.ok = false;
    if (!isObject(reports[reportId])) result.missing += 1;
  }
  for (const attemptId of attemptIds) {
    const attemptRead = await get(`/api/missions/${missionId}/attempts/${attemptId}`);
    if (attemptRead.ok && isObject(attemptRead.json)) attempts[attemptId] = attemptRead.json;
    else if (attemptRead.status !== 404) result.ok = false;
    if (!isObject(attempts[attemptId])) result.missing += 1;
  }

  const projected = projectQualityRecords({
    mission,
    activity,
    reports,
    attempts,
    capturedReviews: progress.capturedReviews,
    reviewHistory,
    lastReviewFallback,
    config,
  });
  // ACK 去重集合有界：超出后丢最旧的 id（服务器对同 id 幂等，最坏情况是重发）。
  // 未确认的 id 从不进这个集合，所以这里丢的永远不是「还没发出去」的那一条。
  const acked = new Set(progress.acked);
  const trimAcked = () => {
    if (acked.size <= MAX_ACKED_IDS) return;
    const kept = [...acked].slice(acked.size - MAX_ACKED_IDS);
    acked.clear();
    for (const id of kept) acked.add(id);
  };
  // 项目范围下多个 Mission 共用一份进度文件，而投影层会丢掉 missionId 不是当前 Mission 的
  // 快照（normalizePriorSnapshot）。所以这里不能直接把返回值整表写回：后同步的 Mission
  // 会清掉先同步那个的捕获记录，那批判定就永远投影不出来、也进不了 Langfuse。
  // 保留旧进度里属于**别的** Mission 的项；当前 Mission 用投影结果整体替换——投影层
  // 已经把当前 Mission 的旧快照合并进去了，再把旧项拼回来就会重复存储。
  // capturedReviews 是历史事实：不因为数量增长就丢弃（丢掉的快照永远补不回来）。
  const carriedOver = progress.capturedReviews.filter(
    (entry) => isObject(entry) && isText(entry.missionId) && entry.missionId !== missionId,
  );
  const capturedReviews = [...carriedOver, ...projected.capturedReviews];
  result.capturedReviews = projected.capturedReviews.length;

  const snapshot = () =>
    progressSnapshot({
      acked: [...acked],
      capturedReviews,
      projects: progress.projects,
      reviewCursors: progress.reviewCursors,
    });

  // 先落捕获：断连时这一步已经完成，下一轮还能从进度里投影出同样的记录。
  try {
    result.progressBytes = await writeProgress(progressPath, snapshot(), now, io);
  } catch {
    return { ...result, ok: false, progressWriteFailed: true };
  }

  const pending = new Set();
  for (const record of projected.records) {
    // 收到中断就不再往队列里塞新的：已经在途的那点由 flush 结算，
    // 继续塞只会让「这次退出」拖得更久，而多塞的那几条也未必等得到确认。
    if (signal?.aborted) break;
    const recordKnown = acked.has(record.id);
    if (recordKnown) result.skipped += 1;
    else if (await confirmedBy(() => transport.enqueueSpan(record.span))) pending.add(record.id);
    else result.unconfirmed += 1;
    for (const score of Array.isArray(record.scores) ? record.scores : []) {
      if (signal?.aborted) break;
      if (acked.has(score.id)) {
        result.skipped += 1;
        continue;
      }
      if (await confirmedBy(() => transport.enqueueScore(score))) pending.add(score.id);
      else result.unconfirmed += 1;
    }
  }
  result.sent = pending.size;
  if (pending.size === 0) return result;

  for (const id of pending) acked.add(id);
  trimAcked();
  try {
    result.progressBytes = await writeProgress(progressPath, snapshot(), now, io);
  } catch {
    // 已经发出去了但记不下来：下一轮会重发同样的稳定 id，Langfuse 按 id 去重。
    // 比「假装记下来」诚实，也比丢掉已确认的事实安全。
    return { ...result, ok: false, progressWriteFailed: true };
  }
  return result;
}

/**
 * 单次同步。返回可序列化汇总，CLI 只按它决定退出码与 stdout。
 *
 * `fetchImpl` 是可选注入点（测试用它替掉只读 HTTP），默认实现就是本文件的
 * `httpGetJson`——**任何情况下都不调用全局 fetch**，原因见文件头。
 */
export async function syncQualityOnce({
  config,
  platformUrl = DEFAULT_PLATFORM_URL,
  missionId,
  projectId,
  progressPath,
  controlToken,
  fetchImpl,
  transport,
  now,
  signal,
  renameFile,
  retryWait,
} = {}) {
  // 只往下传函数：缺省就让 writeProgress 用真实 rename / setTimeout，不在这里造假实现。
  const io = { renameFile, retryWait };
  const summary = {
    ok: true,
    missions: [],
    sent: 0,
    skipped: 0,
    unconfirmed: 0,
    missing: 0,
    reviewPages: 0,
    capturedReviews: 0,
    partial: false,
    disabled: false,
  };
  // 关闭时连参数都不校验：用户没启用功能，任何请求/写盘都是不该发生的副作用。
  if (!isObject(config) || config.enabled !== true) return { ...summary, disabled: true };

  const scope = scopeOf({ missionId, projectId });
  const base = safePlatformUrl(platformUrl);
  if (!base) throw new TypeError('platformUrl 只允许本机回环 http(s) 地址');
  if (!isText(progressPath)) throw new TypeError('需要 progressPath');
  const timeoutMs = Number.isFinite(config.requestTimeoutMs) ? Math.trunc(config.requestTimeoutMs) : DEFAULT_TIMEOUT_MS;
  const active = transport ?? createTransport(config);

  const get = async (path) => {
    // 拒绝发生在发请求之前：路径不合规时连 socket 都不建。
    if (!allowedPath(path)) return { ok: false, status: 0, refused: true };
    const url = `${base}${path}`;
    if (typeof fetchImpl === 'function') {
      try {
        return await fetchImpl(url, { timeoutMs, controlToken, method: 'GET' });
      } catch {
        return { ok: false, status: 0 };
      }
    }
    return httpGetJson({ url, controlToken, timeoutMs });
  };

  let missionIds;
  let rotation = null;
  if (scope.kind === 'mission') {
    // 显式 Mission 不调列表：多一次全量列表读取就多一次把别的 Mission 带进来的机会。
    missionIds = [scope.id];
  } else {
    const listed = await get('/api/missions');
    if (!listed.ok || !Array.isArray(listed.json)) return { ...summary, ok: false };
    const matched = [];
    for (const row of listed.json) {
      if (!isObject(row) || row.projectId !== scope.id) continue;
      if (!isText(row.missionId)) continue;
      if (!matched.includes(row.missionId)) matched.push(row.missionId);
    }
    // 稳定排序：列表顺序不是契约，靠它决定「下一批从哪开始」会让游标在两次
    // 读取之间漂移，于是有的 Mission 被跳过、有的被重复。
    matched.sort((a, b) => a.localeCompare(b));
    if (matched.length === 0) {
      summary.missions = [];
      summary.project = { total: 0, pending: 0, wrapped: false };
    } else {
      // 轮转：按稳定 missionId 顺序，每轮最多 MAX_PROJECT_MISSIONS 个，从上一轮停下的
      // 下一个开始，走到末尾再绕回开头——这样 50 个之后的 Mission 不会被永久漏掉。
      const readForCursor = await readProgress(progressPath);
      const lastMissionId = readForCursor.ok
        ? readForCursor.progress.projects?.[scope.id]?.lastMissionId
        : undefined;
      const start = rotationStart(matched, lastMissionId);
      const batch = [];
      for (let offset = 0; offset < matched.length && batch.length < MAX_PROJECT_MISSIONS; offset += 1) {
        batch.push(matched[(start + offset) % matched.length]);
      }
      missionIds = batch;
      rotation = {
        total: matched.length,
        // 是否真的绕回了开头：只影响 summary 文案，不影响读取顺序。
        wrapped: start + batch.length > matched.length,
        projectId: scope.id,
      };
    }
  }

  let advancedCount = 0;
  for (const id of missionIds) {
    const result = await syncMission({ missionId: id, get, progressPath, config, transport: active, now, signal, io });
    summary.missions.push(id);
    summary.sent += result.sent;
    summary.skipped += result.skipped;
    summary.unconfirmed += result.unconfirmed;
    summary.missing += result.missing;
    summary.reviewPages += result.reviewPages ?? 0;
    summary.capturedReviews += result.capturedReviews ?? 0;
    if (result.partial === true) summary.partial = true;
    if (result.ok !== true) summary.ok = false;
    if (result.progressWriteFailed === true) summary.progressWriteFailed = true;
    // 轮转游标只按**连续成功前缀**推进：只有这一个 Mission 真正读全、发全、没有被中断时
    // 才把游标挪到它身上。任何失败、未确认、partial 或中断都立刻停住本批，游标留在
    // 最后一个成功的位置——否则失败那一批会被当成「已处理」跳过，下一轮直接从它后面
    // 开始，它就再也轮不到了。
    const advanced = result.ok === true && result.unconfirmed === 0 && result.partial !== true && !signal?.aborted;
    let cursorFailed = false;
    if (rotation && advanced) {
      const moved = await advanceProjectCursor({
        progressPath,
        projectId: rotation.projectId,
        missionId: id,
        wrapped: rotation.wrapped,
        now,
        io,
      });
      // 游标没写成也是失败：静默当成功会让下一轮从旧位置重头再读一遍。而且必须当场
      // 停住本批——继续同步后面的 Mission 只会让盘上的游标离实际读过的位置更远，
      // 这批就更不可能被完整重来一次。
      cursorFailed = moved !== true;
      if (cursorFailed) summary.ok = false;
      else advancedCount += 1;
    }
    if (Number.isFinite(result.progressBytes)) summary.progressBytes = result.progressBytes;
    if (!advanced || cursorFailed) break;
  }
  // pending 按「本轮真正推进了多少」算：提前停住时剩下的（包括没轮到的那几个）都还没处理，
  // 报成已处理会让人以为下一轮不必再读它们。
  if (rotation) {
    summary.project = {
      total: rotation.total,
      pending: Math.max(0, rotation.total - advancedCount),
      wrapped: rotation.wrapped,
    };
  }
  // flush 有界（配置里 flushTimeoutMs）。返回 false 不代表可以改判：已确认与否只由
  // 每条 enqueue 的结算决定，这里不做任何补记。
  await active.flush();
  return summary;
}

/**
 * 轮转起点：上一轮停在 lastMissionId，这一轮从它的**下一个**开始。
 * 找不到那个 id（Mission 被删/改名）就从 0 开始：宁可多读一轮，也不能因为一个
 * 消失的 id 让整个项目永久停在同一处。
 */
function rotationStart(sortedIds, lastMissionId) {
  if (!isText(lastMissionId)) return 0;
  const index = sortedIds.indexOf(lastMissionId);
  if (index < 0) return 0;
  return (index + 1) % sortedIds.length;
}

/**
 * 推进并保存项目轮转游标。
 *
 * 只改 projects 这一格，其余字段原样写回：这里读的是刚被 syncMission 写过的文件，
 * 用读-改-写的方式保留 acked/capturedReviews/reviewCursors。读不出来时**不写**：
 * 拿空进度覆盖会把已捕获的历史和已确认的 id 一起抹掉，那是不可恢复的。
 */
async function advanceProjectCursor({ progressPath, projectId, missionId, wrapped, now, io }) {
  const read = await readProgress(progressPath);
  if (!read.ok) return false;
  const cursor = projectCursor(read.progress, projectId);
  cursor.lastMissionId = missionId;
  if (wrapped === true) cursor.wrapped = true;
  try {
    await writeProgress(progressPath, progressSnapshot(read.progress), now, io);
    return true;
  } catch {
    return false;
  }
}

/** 中断时也要能醒：只 sleep 而不看 signal，SIGINT 之后进程要等满一个区间才退。 */
function sleepUnlessAborted(intervalMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    let timer = null;
    let listener = null;
    let settled = false;
    const finish = (aborted) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (listener) signal?.removeEventListener?.('abort', listener);
      resolve(aborted);
    };
    timer = setTimeout(() => finish(false), intervalMs);
    timer.unref?.();
    listener = () => finish(true);
    signal?.addEventListener?.('abort', listener, { once: true });
  });
}

/**
 * 有界持续模式：最多 iterations 轮，轮间隔 intervalMs；signal 一响就不再开下一轮。
 *
 * 库函数允许比 CLI 更小的正 interval（测试要跑得快），但 iterations 必须有限——
 * 「一直跑到被杀掉」的循环在断网时只会把进度文件写成同一个未确认状态，
 * 而且没人能判断它到底同没同步过。
 */
export async function runBounded({
  iterations,
  intervalMs,
  signal,
  config,
  platformUrl,
  missionId,
  projectId,
  progressPath,
  controlToken,
  fetchImpl,
  transport,
  now,
  renameFile,
  retryWait,
} = {}) {
  if (!Number.isInteger(iterations) || iterations < 1) throw new TypeError('iterations 必须是 >=1 的整数');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs 必须是正数');
  const active = transport ?? createTransport(config);
  const results = [];
  try {
    for (let index = 0; index < iterations; index += 1) {
      if (signal?.aborted) break;
      const result = await syncQualityOnce({
        config,
        platformUrl,
        missionId,
        projectId,
        progressPath,
        controlToken,
        fetchImpl,
        transport: active,
        now,
        signal,
        renameFile,
        retryWait,
      });
      results.push(result);
      // 关闭状态再跑一遍也是空转：没必要为一个永远不会发东西的循环等 interval。
      if (result.disabled || index === iterations - 1) break;
      if (await sleepUnlessAborted(intervalMs, signal)) break;
    }
  } finally {
    // 中断路径也走这里：已入队的确认要交给传输层结算，不是直接丢在内存里。
    await active.flush();
  }
  return results;
}

/** CLI 参数错误统一走这里：消息里绝不带任何凭据或文件内容。 */
function parseArgs(argv) {
  const options = {
    once: false,
    intervalMs: undefined,
    iterations: undefined,
    mission: undefined,
    project: undefined,
    platformUrl: DEFAULT_PLATFORM_URL,
    config: undefined,
    progress: undefined,
    controlTokenFile: undefined,
  };
  const take = (index, name) => {
    const value = argv[index + 1];
    if (!isText(value) || value.startsWith('--')) throw new TypeError(`${name} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--once':
        options.once = true;
        break;
      case '--mission':
        options.mission = take(index, '--mission');
        index += 1;
        break;
      case '--project':
        options.project = take(index, '--project');
        index += 1;
        break;
      case '--platform-url':
        options.platformUrl = take(index, '--platform-url');
        index += 1;
        break;
      case '--config':
        options.config = take(index, '--config');
        index += 1;
        break;
      case '--progress':
        options.progress = take(index, '--progress');
        index += 1;
        break;
      case '--control-token-file':
        options.controlTokenFile = take(index, '--control-token-file');
        index += 1;
        break;
      case '--interval-ms': {
        const raw = take(index, '--interval-ms');
        index += 1;
        const value = Number(raw);
        if (!Number.isInteger(value)) throw new TypeError('--interval-ms 必须是整数');
        options.intervalMs = value;
        break;
      }
      case '--iterations': {
        const raw = take(index, '--iterations');
        index += 1;
        const value = Number(raw);
        if (!Number.isInteger(value)) throw new TypeError('--iterations 必须是整数');
        options.iterations = value;
        break;
      }
      default:
        throw new TypeError(`未知参数：${arg}`);
    }
  }
  scopeOf({ missionId: options.mission, projectId: options.project });
  const hasInterval = options.intervalMs !== undefined || options.iterations !== undefined;
  if (options.once && hasInterval) throw new TypeError('--once 与 --interval-ms/--iterations 只能二选一');
  if (!options.once && !hasInterval) throw new TypeError('需要 --once，或同时给出 --interval-ms 与 --iterations');
  if (!options.once) {
    if (options.intervalMs === undefined || options.iterations === undefined) {
      throw new TypeError('持续模式必须同时给出 --interval-ms 与 --iterations');
    }
    // CLI 的 1 秒下限是给真实部署的：比这更密只会打满平台读接口，图不到更多数据。
    if (options.intervalMs < MIN_CLI_INTERVAL_MS) throw new TypeError(`--interval-ms 不得小于 ${MIN_CLI_INTERVAL_MS}`);
    if (options.iterations < 1 || options.iterations > MAX_CLI_ITERATIONS) {
      throw new TypeError(`--iterations 必须在 1..${MAX_CLI_ITERATIONS}`);
    }
  }
  return options;
}

const USAGE =
  'usage: node scripts/langfuse-sync.mjs (--mission <id> | --project <id>) (--once | --interval-ms <ms> --iterations <n>) ' +
  '[--platform-url <url>] [--config <file>] [--progress <file>] [--control-token-file <file>]';

/**
 * stdout 只写计数与 missionId：这里不打印 reasons/evidence/outputTail，
 * 也不打印配置内容或 Authorization——终端输出会进日志与录屏。
 */
function reportSummary(result) {
  if (result.disabled) {
    process.stdout.write('langfuse disabled\n');
    return;
  }
  const missions = result.missions.length === 0 ? '-' : result.missions.join(',');
  // 只写计数、missionId 与进度体量：这个字段集合就是「允许出现在日志里的全部质量信息」。
  // partial / project 必须出现：读到的不是全量时，下游（和看日志的人）要能一眼看出来。
  const extras = [];
  if (result.partial === true) extras.push('partial=true');
  if (isObject(result.project)) {
    extras.push(`project_total=${result.project.total} project_pending=${result.project.pending}`);
    if (result.project.wrapped === true) extras.push('project_wrapped=true');
  }
  if (Number.isFinite(result.reviewPages)) extras.push(`review_pages=${result.reviewPages}`);
  if (Number.isFinite(result.capturedReviews)) extras.push(`captured=${result.capturedReviews}`);
  if (Number.isFinite(result.progressBytes)) extras.push(`progress_bytes=${result.progressBytes}`);
  process.stdout.write(
    `mission ${missions} ok=${result.ok === true} sent=${result.sent} skipped=${result.skipped} ` +
      `unconfirmed=${result.unconfirmed} missing=${result.missing ?? 0}` +
      `${extras.length > 0 ? ` ${extras.join(' ')}` : ''}\n`,
  );
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'bad arguments'}\n${USAGE}\n`);
    return 2;
  }

  const config = await loadConfig(options.config ? { path: options.config } : {});
  if (config.enabled !== true) {
    // 关闭时什么都不做：不读平台、不建传输、不写进度。
    process.stdout.write('langfuse disabled\n');
    return 0;
  }

  let controlToken;
  if (options.controlTokenFile) {
    try {
      controlToken = (await readFile(options.controlTokenFile, 'utf8')).trim();
    } catch {
      // 不回显路径内容，也不把错误对象打出来（可能带路径与片段）。
      process.stderr.write('control token file unreadable\n');
      return 2;
    }
    if (!controlToken) {
      process.stderr.write('control token file empty\n');
      return 2;
    }
  }

  const progressPath = options.progress ?? defaultProgressPath({ missionId: options.mission, projectId: options.project });
  const transport = createTransport(config);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let results;
  try {
    const shared = {
      config,
      platformUrl: options.platformUrl,
      missionId: options.mission,
      projectId: options.project,
      progressPath,
      controlToken,
      transport,
      signal: controller.signal,
    };
    results = options.once
      ? [await syncQualityOnce(shared)]
      : await runBounded({ ...shared, iterations: options.iterations, intervalMs: options.intervalMs, signal: controller.signal });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'sync failed'}\n`);
    return 2;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  for (const result of results) reportSummary(result);
  const last = results[results.length - 1];
  if (!last || last.disabled) return 0;
  // 读取失败或存在未确认就非 0：退出码是给脚本与人工判断看的唯一信号，
  // 「跑过了但没同步上」不能报成成功。
  const degraded = results.some((result) => result.ok !== true || result.unconfirmed > 0);
  return degraded ? 1 : 0;
}

/** 只有被直接执行时才解析 argv：被 import 时（测试）不能碰 process.argv。 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!isText(entry)) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('langfuse sync failed\n');
      process.exitCode = 1;
    });
}
