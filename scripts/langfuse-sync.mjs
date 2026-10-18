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
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * 只读路径白名单。白名单而不是黑名单：黑名单漏一个（`/live`、`/diff`、
 * `/delivery/...`）就是把平台内部状态当观测数据发出去，而这类路径还在不断增加。
 * attempt id 里带点（`W-1.exec-1`），所以段用 `[^/]+` 而不是「只允许字母数字」。
 */
const ALLOWED_PATHS = [
  /^\/api\/missions$/,
  /^\/api\/missions\/[^/]+$/,
  /^\/api\/missions\/[^/]+\/activity$/,
  /^\/api\/missions\/[^/]+\/attempts\/[^/]+$/,
  /^\/api\/missions\/[^/]+\/validation-reports\/[^/]+$/,
];

/** 即使将来白名单放宽，这几样也永远不读：平台自己的运行状态与 Delivery 不属于观测面。 */
const FORBIDDEN_PATH_RE = /\.coagent-state\.json|delivery|\/live$|\/diff$/i;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const emptyProgress = () => ({ version: 1, acked: [], capturedReviews: [] });

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
  if (path.includes('..') || path.includes('\\') || path.includes('%') || path.includes('?')) return false;
  return ALLOWED_PATHS.some((pattern) => pattern.test(path));
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
  return { ok: true, progress: { version: 1, acked: [...parsed.acked], capturedReviews: parsed.capturedReviews } };
}

let tempCounter = 0;

/**
 * 原子写：同目录临时文件写完再 rename。
 *
 * 为什么必须原子：进度文件是唯一的去重依据，写到一半崩掉会留下一个既不能读、也
 * 不能当空的半截 JSON；下一轮读它会判成 ok:false，同步就永久停在那里。
 * Windows 上 rename 到已存在的目标会失败，所以失败后先删目标再 rename 一次——
 * 那次窗口很短，比「直接写目标」的风险小得多。
 */
async function writeProgress(file, progress, now) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const stamp = typeof now === 'function' ? now() : Date.now();
  tempCounter += 1;
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${stamp}.${tempCounter}.tmp`);
  await writeFile(tmp, `${JSON.stringify(progress)}\n`, 'utf8');
  try {
    await rename(tmp, file);
  } catch {
    try {
      await unlink(file);
    } catch {
      // 目标本来就不在：下面的 rename 才是真正的那一次。
    }
    try {
      await rename(tmp, file);
    } catch (error) {
      try {
        await unlink(tmp);
      } catch {
        // 清不掉临时文件不该盖住真正的写失败。
      }
      throw error;
    }
  }
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
 * 同步一个 Mission 的全部可证实记录。
 *
 * 顺序是刻意的：读事实 -> 投影 -> 先把捕获写盘 -> 再发送 -> 最后写已确认。
 * 任何一步失败都停在原地，绝不把「没发出去」记成「发过了」。
 */
async function syncMission({ missionId, get, progressPath, config, transport, now, signal }) {
  const result = { ok: true, sent: 0, skipped: 0, unconfirmed: 0, missing: 0 };
  const missionRead = await get(`/api/missions/${missionId}`);
  if (!missionRead.ok || !isObject(missionRead.json)) return { ...result, ok: false };
  const mission = missionRead.json;
  if (mission.missionId !== missionId) return { ...result, ok: false };
  const activityRead = await get(`/api/missions/${missionId}/activity`);
  if (!activityRead.ok || !Array.isArray(activityRead.json)) return { ...result, ok: false };
  const activity = activityRead.json;

  // 只取「受评」Attempt 与 ValidationReport：review.recorded 上的 attemptId 是评审者，
  // 把它也当受评者去取明细，就等于给了投影层一份错身份的材料。
  const attemptIds = new Set();
  const reportIds = new Set();
  for (const item of Array.isArray(mission.workItems) ? mission.workItems : []) {
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
    const read = await get(`/api/missions/${missionId}/validation-reports/${reportId}`);
    if (read.ok && isObject(read.json)) reports[reportId] = read.json;
    // 404 是「这份报告不存在」这个事实本身，不是读取故障；其它状态/网络错误才是故障。
    else if (read.status !== 404) result.ok = false;
    if (!isObject(reports[reportId])) result.missing += 1;
  }
  for (const attemptId of attemptIds) {
    const read = await get(`/api/missions/${missionId}/attempts/${attemptId}`);
    if (read.ok && isObject(read.json)) attempts[attemptId] = read.json;
    else if (read.status !== 404) result.ok = false;
    if (!isObject(attempts[attemptId])) result.missing += 1;
  }

  const read = await readProgress(progressPath);
  if (!read.ok) {
    // 进度读不出来就不发：没有去重依据，发一遍等于把整段历史重投。
    return { ...result, ok: false, progressUnreadable: true };
  }
  const projected = projectQualityRecords({
    mission,
    activity,
    reports,
    attempts,
    capturedReviews: read.progress.capturedReviews,
    config,
  });
  const acked = new Set(read.progress.acked);
  const capturedReviews = projected.capturedReviews;
  const snapshot = { version: 1, acked: [...acked], capturedReviews };

  // 先落捕获：断连时这一步已经完成，下一轮还能从进度里投影出同样的记录。
  try {
    await writeProgress(progressPath, snapshot, now);
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

  try {
    await writeProgress(progressPath, { version: 1, acked: [...acked, ...pending], capturedReviews }, now);
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
} = {}) {
  const summary = { ok: true, missions: [], sent: 0, skipped: 0, unconfirmed: 0, missing: 0, disabled: false };
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
    if (matched.length > MAX_PROJECT_MISSIONS) {
      // 一轮里同步上百个 Mission 既跑不完也没人看得懂：宁可说清楚「范围太大」。
      return { ...summary, ok: false, truncated: true, missions: [] };
    }
    missionIds = matched;
  }

  for (const id of missionIds) {
    const result = await syncMission({ missionId: id, get, progressPath, config, transport: active, now, signal });
    summary.missions.push(id);
    summary.sent += result.sent;
    summary.skipped += result.skipped;
    summary.unconfirmed += result.unconfirmed;
    summary.missing += result.missing;
    if (result.ok !== true) summary.ok = false;
  }
  // flush 有界（配置里 flushTimeoutMs）。返回 false 不代表可以改判：已确认与否只由
  // 每条 enqueue 的结算决定，这里不做任何补记。
  await active.flush();
  return summary;
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
  if (result.truncated) {
    process.stdout.write('project scope truncated\n');
    return;
  }
  const missions = result.missions.length === 0 ? '-' : result.missions.join(',');
  // 只写计数与 missionId：这个字段集合就是「允许出现在日志里的全部质量信息」。
  process.stdout.write(
    `mission ${missions} ok=${result.ok === true} sent=${result.sent} skipped=${result.skipped} ` +
      `unconfirmed=${result.unconfirmed} missing=${result.missing ?? 0}\n`,
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
