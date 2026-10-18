/**
 * Langfuse v4 旁路传输：pi 观测与独立质量同步共用的唯一实现。
 *
 * 为什么要有这一层：pi runtime 与质量同步 CLI 各自写一份 HTTP 代码，必然在
 * 超时、队列上界、脱敏规则上漂移；漂移的后果是「有的路径把 token 发出去了，
 * 有的路径把模型调用卡住了」，而两者都只在真实环境里才暴露。所以把「默认关闭、
 * 有界、失败隔离」一次性做在这里，上层只负责挑选字段。
 *
 * 只允许 Node 内置模块：git clone 下来不装依赖，这些测试就能跑。
 * 只连本机回环：凭据只应留在用户自己的机器上，不接受远程 baseUrl。
 * 不经 fetch：fetch 会吃环境代理，本地回环被代理转走时错误会被伪装成网络故障。
 *
 * 本模块不 console 打印任何东西，也不读 process.env / 其它凭据文件。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NAMESPACE = 'coagent.langfuse.v1';
const REDACTED = '[REDACTED]';
const MAX_CONTENT_CHARS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_QUEUE = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
const MAX_CONCURRENCY = 2;
const OTLP_PATH = '/api/public/otel/v1/traces';
const INGESTION_PATH = '/api/public/ingestion';
const INGESTION_VERSION = '4';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const DISABLED_DEFAULTS = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:3300',
  publicKey: '',
  secretKey: '',
  captureContent: false,
  maxContentChars: 2000,
  requestTimeoutMs: 5000,
  maxQueueSize: 100,
  flushTimeoutMs: 5000,
};

const clampInt = (value, fallback, min, max) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;

const disabledConfig = () => ({ ...DISABLED_DEFAULTS });

/**
 * baseUrl 只允许 http(s) 本机回环，且不允许用户信息、查询串、片段或 `..` 路径段。
 * 为什么会有人踩：把 baseUrl 写成 `https://user:key@host` 或 `...?token=...` 时，
 * 凭据会随每次请求头/日志/报错散出去；`..` 则让请求打到预期之外的路径。
 */
function safeBaseUrl(input) {
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
  const segments = url.pathname.split('/');
  for (const segment of segments) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    // URL 会归一化字面的 `..`，剩下的逃逸途径就是编码过的分隔符/点段
    // （`%2E%2E%2F` 解出来是 `../`）：解出分隔符就说明这一段能跳到别的路径去。
    if (decoded === '..' || decoded === '.') return null;
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * 读用户本地配置。无文件、坏 JSON、未显式 `enabled:true`、地址或凭据不合法，
 * 一律返回关闭配置且不打印内容——配置文件里有密钥，任何「顺手打一行日志」都会
 * 把密钥写进平台日志或终端回滚区。
 */
export async function loadConfig({ path } = {}) {
  const file = typeof path === 'string' && path ? path : join(homedir(), '.coagent', 'langfuse.json');
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return disabledConfig();
  }
  const config = disabledConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return config;
  const baseUrl = safeBaseUrl(raw.baseUrl ?? DISABLED_DEFAULTS.baseUrl);
  const publicKey = typeof raw.publicKey === 'string' ? raw.publicKey.trim() : '';
  const secretKey = typeof raw.secretKey === 'string' ? raw.secretKey.trim() : '';
  // 默认关闭：只有显式 true 且三要素齐全才开启，缺一样就当没配。
  if (raw.enabled !== true || !baseUrl || !publicKey || !secretKey) return config;
  return {
    enabled: true,
    baseUrl,
    publicKey,
    secretKey,
    captureContent: raw.captureContent === true,
    maxContentChars: clampInt(raw.maxContentChars, DISABLED_DEFAULTS.maxContentChars, 0, MAX_CONTENT_CHARS),
    requestTimeoutMs: clampInt(raw.requestTimeoutMs, DISABLED_DEFAULTS.requestTimeoutMs, 100, MAX_TIMEOUT_MS),
    maxQueueSize: clampInt(raw.maxQueueSize, DISABLED_DEFAULTS.maxQueueSize, 1, MAX_QUEUE),
    flushTimeoutMs: clampInt(raw.flushTimeoutMs, DISABLED_DEFAULTS.flushTimeoutMs, 100, MAX_TIMEOUT_MS),
  };
}

const digest = (parts) => createHash('sha256').update(JSON.stringify([NAMESPACE, ...parts])).digest('hex');

/** 同一命名空间的完整 hex 摘要；拼数组而不是拼字符串，`('ab','c')` 与 `('a','bc')` 不会撞。 */
export function stableEventId(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  return digest(list);
}

/**
 * 确定性 ID：只由事实构成，不含时间/随机值，重放同一次调用必须给出同一个 ID。
 * Mission 级 trace 是不带 attemptId 的版本；try 之间靠 attemptId 隔离，
 * 否则两次尝试的 span 会被拼成同一条 trace，复核时看不出是几次尝试。
 */
export function stableIds({ missionId, attemptId = null, callIndex = null, eventKey = null } = {}) {
  if (typeof missionId !== 'string' || !missionId) {
    throw new TypeError('stableIds 需要非空 missionId');
  }
  const attempt = attemptId ?? null;
  const call = callIndex ?? null;
  const event = eventKey ?? null;
  return {
    traceId: digest(['trace', missionId, attempt]).slice(0, 32),
    spanId: digest(['span', missionId, attempt, call, event]).slice(0, 16),
  };
}

const SENSITIVE_NAMES = new Set([
  'authorization',
  'auth',
  'authconfig',
  'authheader',
  'apikey',
  'secret',
  'secretkey',
  'clientsecret',
  'password',
  'passwd',
  'passphrase',
  'token',
  'accesstoken',
  'refreshtoken',
  'runtoken',
  'privatekey',
  'publickey',
  'credential',
  'credentials',
  'cookie',
  'setcookie',
  'proxy',
  'proxyurl',
  'proxyaddress',
  'httpproxy',
  'httpsproxy',
  'no_proxy',
  'proxybypass',
]);

const AUTH_CONFIG_NAMES = new Set([
  'authconfig',
  'authentication',
  'authorizationconfig',
  'bearertoken',
  'accesstoken',
  'refreshtoken',
]);

/** 代理字段的**名字**：命中就整块换成固定占位，不能只清掉 userinfo 留一个地址。 */
const PROXY_NAME_RE = /proxy/i;
/** 主机字段只在与代理同处一个对象时才清（见 stripProxyHosts），普通配置里的 host 不该被抹。 */
const PROXY_HOST_NAME_RE = /^(?:host|hostname|hostaddress|port|server|endpoint)$/;

/**
 * 一行里提到代理时清掉其中的具体地址。
 * 保留原值的引号：`"proxy":"http://host:7890"` 清完必须是 `"proxy":"[REDACTED]"`，
 * 否则周围整段字符串化 JSON 就不再是合法 JSON，后续的字段级清理和重排全部失效。
 */
const scrubProxyUrls = (line) =>
  line.replace(/["']?(?:https?|socks[45]?):\/\/[^\s"'`,;)]*["']?/gi, (match) => {
    const quote = /^["']/.test(match) ? match[0] : '';
    return `${quote}${REDACTED}${quote}`;
  });

/**
 * 先归一化再判：`api-key`/`apiKey`/`API_KEY` 指同一个东西，漏一种就是一个泄露口。
 * 不写 `name.includes('token')` 这种宽匹配：`max_tokens`/`num_tokens`/`top_logprobs`
 * 都在正常模型输出里，抹掉就把复核正文损毁了。
 */
function sensitiveKey(key) {
  if (typeof key !== 'string' || !key) return false;
  const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SENSITIVE_NAMES.has(name) ||
    name.includes('secret') ||
    name.includes('password') ||
    name.includes('passwd') ||
    name.includes('credential') ||
    name.includes('apikey') ||
    name.includes('privatekey') ||
    name.includes('proxy') ||
    // `authorization-header` 这类前缀变体不是恰好同名。
    name.startsWith('authorization') ||
    AUTH_CONFIG_NAMES.has(name) ||
    // 任意取值的 `*Token` 字段（runToken/accessToken/...）。
    (name.endsWith('token') && !name.startsWith('max') && !name.startsWith('num') && !name.startsWith('top'))
  );
}

/**
 * 字符串化 JSON 里的一对 `"key": value`。
 *
 * 为什么先用字段正则再用 JSON.parse：正则阶段不重建文本，能处理非严格 JSON
 * （`{'a':1}`、被截断的片段），而解析阶段才能看到嵌套结构。两层都做，
 * 因为只做解析的话，不合法的片段就完全没人管。
 */
const JSON_FIELD_RE = /(")([^"\\]{1,120})\1[ \t]*(?::|=>)[ \t]*(?:"((?:[^"\\]|\\.)*)"|([^\s,}\]{\["][^,}\]\r\n]*))/g;
const JSON_TEXT_MAX = 1024 * 1024;

/**
 * 有界解析：嵌套 JSON 字符串（工具参数被再 stringify 一层）要清到里层，
 * 但输入长度和深度都必须有界，否则一段畸形长文本就能把采集拖住。
 */
const parseEmbedded = (text) => {
  if (text.length > JSON_TEXT_MAX) return undefined;
  let depth = 0;
  for (const ch of text) {
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    if (depth > MAX_DEPTH) return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * 带续行处理的行扫描：Authorization/Cookie 这类头行的值可能折到下一行。
 * 不处理续行的话，凭据的后半段会留在日志里，等于只遮了一半。
 * 值一律整行换成替代标记：`Basic <base64>` 这种形式没有任何可识别的前缀
 * （不是 sk-，也不是 Bearer），只清“看起来像凭据”的部分等于把凭据留下。
 * 续行只认「以空白开头」的行，否则下一行正常的头会被一并当成续行抹掉。
 */
const scrubLines = (text) => {
  const lines = text.split(/\r?\n/);
  let inHeader = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inHeader && /^[ \t]+\S/.test(line)) {
      lines[i] = REDACTED;
      continue;
    }
    inHeader = false;
    const header = /^([ \t]*[A-Za-z0-9_.-]*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)[A-Za-z0-9_.-]*[ \t]*:[ \t]*).+/i.exec(
      line,
    );
    if (header) {
      lines[i] = `${header[1]}${REDACTED}`;
      inHeader = true;
      continue;
    }
    // 没有引号的 `proxy: http://host:7890` / `HTTP_PROXY=...` 行：地址整块清。
    // 必须在通用 key=value 规则之前，否则那条规则只清 userinfo，地址仍在。
    const proxy = /^([ \t]*[a-z0-9_.-]*proxy[a-z0-9_.-]*[ \t]*[:=][ \t]*)(.+)$/i.exec(line);
    if (proxy && !proxy[2].includes(REDACTED)) {
      lines[i] = `${proxy[1]}${REDACTED}`;
      continue;
    }
    lines[i] = scrubString(line);
    // 一行里提到代理、又带着具体地址（比如工具描述 `proxy -> http://10.5.5.5:8080`）：
    // “代理字段必须清除整个地址”意味着这种松散写法也不能放过。
    if (PROXY_NAME_RE.test(lines[i])) lines[i] = scrubProxyUrls(lines[i]);
  }
  return lines.join('\n');
};

/**
 * 同一行里的多处赋值（`a=1; Proxy=http://...`）：行首扫描只能处理第一条，
 * 剩下的必须按边界再扫一遍，否则后面的代理地址整块留在原处。
 */
const scrubProxyAssignments = (text) =>
  text.replace(
    /(^|[\s;&,])([a-z0-9_.-]*proxy[a-z0-9_.-]*[ \t]*[:=][ \t]*)(?!\[REDACTED\])([^\s;&,)\]}]+)/gi,
    (match, lead, name, value) => (value.includes(REDACTED) ? match : `${lead}${name}${REDACTED}`),
  );

/**
 * 去掉同一对象里的主机字段。
 *
 * 为什么需要：`"proxy":{"host":"127.0.0.1","port":7890}` 这种写法里，
 * 只把 `proxy` 这一项换成占位符，地址仍然以 `host`/`port` 的形状完整留在输出里；
 * 而这个地址正是用户机器上的出口。但 `host` 本身是常见配置名（API base、DB），
 * 全局抹掉会毁掉复核需要的正文，所以只在同一个对象里出现过代理字段时才清。
 */
const stripProxyHosts = (value, seen = new WeakSet()) => {
  if (!isPlainObject(value) && !Array.isArray(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) stripProxyHosts(item, seen);
    return;
  }
  const entries = Object.entries(value);
  const hasProxy = entries.some(([key]) => PROXY_NAME_RE.test(key));
  for (const [key, item] of entries) {
    if (hasProxy) {
      const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (PROXY_HOST_NAME_RE.test(name) || AUTH_CONFIG_NAMES.has(name)) value[key] = REDACTED;
    }
    stripProxyHosts(item, seen);
  }
};

/**
 * 文本级清理：行扫描 -> 代理赋值 -> 字段/前缀规则 -> 内层 JSON 递归。
 *
 * 递归不会 parse->scrub 无限互调：解析结果交给 `sanitize`，而 `sanitize`
 * 遇到字符串只走 `scrubText(text, depth + 1)`，`depth` 一旦超过 MAX_DEPTH
 * 就退回只跑 STRING_RULES。
 *
 * 取舍：能解析成 JSON 的文本会被重排成紧凑单行。Langfuse 侧存的是字符串正文，
 * 紧凑化不影响复核内容，但确实会丢掉调用方原本的缩进。
 */
function scrubText(text, depth = 0) {
  if (depth > MAX_DEPTH) return scrubString(text);
  let out = scrubLines(text);
  out = scrubProxyAssignments(out);
  out = out.replace(JSON_FIELD_RE, (match, quote, label, stringValue, bareValue) => {
    if (!sensitiveKey(label)) return match;
    const value = bareValue ?? stringValue;
    // 已带替代标记的值原样留着，否则二次清理会把占位符叠成 `"[REDACTED]"`。
    if (typeof value === 'string' && value.includes(REDACTED)) return match;
    // 原本带引号的值清完还要带引号：这是字符串化 JSON，少一对引号就整段不可解析。
    if (bareValue === undefined) return `${quote}${label}${quote}: ${quote}${REDACTED}${quote}`;
    return `${quote}${label}${quote}: ${REDACTED}`;
  });
  // 只对看起来是对象/数组的文本做解析重建。
  // 为什么这么窄：裸数字串（OTLP 纳秒时间戳、`"1750000000000000000"`）走一遍
  // JSON.parse/stringify 会被 float64 舍入改值，接收端就对不上了。
  const trimmed = out.trim();
  if (!/^[[{]/.test(trimmed) || !/[\]}]$/.test(trimmed)) return out;
  const parsed = parseEmbedded(out);
  if (parsed === undefined) return out;
  try {
    // 结构化的那一半工作（"proxy"/"apiKey" 键、代理主机字段）交给 sanitize，
    // 文本规则认不出 `"apiKey":"任意值"` 这种没前缀的值。
    return JSON.stringify(sanitize(parsed, { seen: new WeakSet(), count: 0 }, depth));
  } catch {
    return out;
  }
}

const STRING_RULES = [
  // 私钥整块连内容一起清掉：只遮第一行等于没遮。
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // sk-/pk-/rk- 前缀的 key（含 Langfuse 的 sk-lf-...）统一清。
  [/\b(?:sk|pk|rk)-[A-Za-z0-9._-]{8,}\b/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // JWT：run token 常常就是这种形状。
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  // URL 里的 userinfo（http://user:pass@host），代理地址最常这样带凭据。
  [/(\/\/)[^\s/?#@:]+:[^\s/?#@]+@/g, `$1${REDACTED}:${REDACTED}@`],
  // 查询串里的凭据。
  [/([?&](?:api[_-]?key|key|token|secret|password|access_token|sig)=)[^&#\s"']+/gi, `$1${REDACTED}`],
  // key=value / key: value 形式的凭据。
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|run[_-]?token|token|secret|password|authorization)\s*[:=]\s*)("?)[^\s"',;}]+/gi,
    `$1$2${REDACTED}`,
  ],
  // 头行：Authorization / x-api-key / Cookie 等，值到行尾都要清。
  [/(^|[\r\n])((?:authorization|proxy-authorization|x-api-key|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, `$1$2${REDACTED}`],
];

const scrubString = (text) => {
  let out = text;
  for (const [pattern, replacement] of STRING_RULES) out = out.replace(pattern, replacement);
  return out;
};

/**
 * 采集与 wire 共用的字符串清理入口。
 *
 * 为什么会漏：原先字符串只过 STRING_RULES，规则认的是 `sk-`/`Bearer`/`token=`
 * 这些**形状**；工具结果的字符串化 JSON 里 `"apiKey":"<任意值>"` 和
 * `"proxy":"http://127.0.0.1:7890"` 两种形状都不匹配，于是原样发到了 Langfuse。
 * 任意取值的凭据只能按**字段名**识别，所以这里补上字段匹配。
 */
const scrubTextDeep = (text) => scrubText(text, 0);

/**
 * 递归脱敏。数字/布尔原样保留——OTLP 的 intValue、纳秒时间戳都靠类型正确，
 * 一律转字符串会把 trace 发成不可用的形状。循环引用返回占位符而不是抛异常：
 * 工具参数里出现自引用对象时，整条观测链路不该因此炸掉。
 */
function sanitize(value, ctx, depth) {
  if (depth > MAX_DEPTH || ctx.count > MAX_NODES) return '[TRUNCATED]';
  ctx.count += 1;
  // 字符串走带字段识别的清理：只靠前缀规则会漏掉任意取值的 apiKey/密码。
  if (typeof value === 'string') return scrubTextDeep(value);
  if (value === undefined || value === null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (ctx.seen.has(value)) return '[CIRCULAR]';
  ctx.seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = [];
    for (const item of value) out.push(sanitize(item, ctx, depth + 1));
  } else {
    out = {};
    // OTLP KeyValue 是 {key:'authorization', value:{...}}：名字本身带凭据时连值一起清，
    // 否则属性名合法、值却原样飞出去。
    const namedSecret = typeof value.key === 'string' && sensitiveKey(value.key);
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKey(key)) out[key] = isPlainObject(item) ? { stringValue: REDACTED } : REDACTED;
      // KeyValue 的 value 常是 AnyValue；遮成字符串会把 value 从对象变成字符串，
      // OTLP 结构就不成立了，接收端会拒收整批。
      else if (namedSecret && key === 'value') {
        out[key] = isPlainObject(item) ? { stringValue: REDACTED } : REDACTED;
      } else out[key] = sanitize(item, ctx, depth + 1);
    }
  }
  // 只防环，不误伤复用同一对象的 DAG。
  ctx.seen.delete(value);
  // 值级清理之后再按字段名收代理地址：`proxy.host` / `proxy.port` 这类拆开写的地址，
  // 只换掉 `proxy` 那一项是不够的。
  stripProxyHosts(out);
  return out;
}

const sanitizeValue = (value) => sanitize(value, { seen: new WeakSet(), count: 0 }, 0);

/**
 * 内容采集：默认不保留正文，只留 missing/truncated 两个可判定的事实。
 *
 * 顺序是「先脱敏再截断」：反过来的话，截断点可能正好切在凭据中间，
 * 后半段就绕过正则活下来了。超过上限时返回有界字符串而不是结构，
 * 避免上层再把它原样塞进属性时又变回无界。
 */
export function captureValue(value, config) {
  const missing = value === undefined || value === null;
  if (!config || config.captureContent !== true) return { missing, truncated: false };
  if (missing) return { missing: true, truncated: false };
  if (value === config) return { value: REDACTED, missing: false, truncated: false };
  const limit = clampInt(config.maxContentChars, DISABLED_DEFAULTS.maxContentChars, 0, MAX_CONTENT_CHARS);
  let text;
  try {
    const clean = sanitizeValue(value);
    text = typeof clean === 'string' ? clean : JSON.stringify(clean);
  } catch {
    return { value: REDACTED, missing: false, truncated: true };
  }
  if (typeof text !== 'string') text = String(text ?? '');
  if (text.length > limit) return { value: text.slice(0, limit), missing: false, truncated: true };
  return { value: text, missing: false, truncated: false };
}

/**
 * OTLP 回执判定：2xx 且没有 partialSuccess 拒收才算数。
 * 只看状态码会把「部分 span 被拒」当成全部成功，复核数据就悄悄少了一截。
 */
function otlpConfirmed(status, text) {
  if (status < 200 || status >= 300) return false;
  if (!text) return true;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const partial = parsed && typeof parsed === 'object' ? parsed.partialSuccess : undefined;
  if (partial && typeof partial === 'object') {
    if (Number(partial.rejectedSpans) > 0 || partial.errorMessage) return false;
  }
  return true;
}

/**
 * ingestion 回执判定：逐项看。207 也在 2xx 里，带 errors 或没有本 event id 的
 * success 都说明这次没有被接收——这里放过一次，质量 CLI 就会把缺失当成成功。
 */
function ingestionConfirmed(status, text, eventId) {
  if (status < 200 || status >= 300) return false;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) return false;
  if (!Array.isArray(parsed.successes)) return false;
  return parsed.successes.some((entry) => entry && typeof entry === 'object' && entry.id === eventId);
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 传输。入队同步返回一个靠 promise 结算的确认结果，调用方可以不管（失败隔离），
 * 也可以 await（质量 CLI 需要可判定的确认）。
 */
export function createTransport(config) {
  const enabled = Boolean(
    config && config.enabled === true && typeof config.baseUrl === 'string' && config.baseUrl,
  );
  const baseUrl = enabled ? config.baseUrl.replace(/\/+$/, '') : '';
  const timeoutMs = clampInt(config?.requestTimeoutMs, DISABLED_DEFAULTS.requestTimeoutMs, 100, MAX_TIMEOUT_MS);
  const flushMs = clampInt(config?.flushTimeoutMs, DISABLED_DEFAULTS.flushTimeoutMs, 100, MAX_TIMEOUT_MS);
  const maxQueue = clampInt(config?.maxQueueSize, DISABLED_DEFAULTS.maxQueueSize, 1, MAX_QUEUE);
  // Basic 认证只发往 Langfuse 自己的请求头；属性/日志里一律不带。
  const authorization = enabled
    ? `Basic ${Buffer.from(`${config.publicKey ?? ''}:${config.secretKey ?? ''}`).toString('base64')}`
    : '';

  const queue = [];
  const inflight = new Set();
  const idleWaiters = [];

  const notifyIdle = () => {
    if (queue.length || inflight.size) return;
    while (idleWaiters.length) idleWaiters.shift()();
  };

  function finish(entry, confirmed) {
    if (entry.settled) return;
    entry.settled = true;
    inflight.delete(entry);
    try {
      entry.resolve(confirmed === true);
    } catch {
      // 结算函数是调用方的，抛了也不能影响传输自身。
    }
    if (queue.length && inflight.size < MAX_CONCURRENCY) pump();
    notifyIdle();
  }

  function post(pathSuffix, body, entry) {
    let data;
    try {
      data = JSON.stringify(body);
    } catch {
      finish(entry, false);
      return;
    }
    if (typeof data !== 'string' || data.length > MAX_REQUEST_BYTES) {
      finish(entry, false);
      return;
    }
    let target;
    try {
      target = new URL(`${baseUrl}${pathSuffix}`);
    } catch {
      finish(entry, false);
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      target,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          'x-langfuse-ingestion-version': INGESTION_VERSION,
          authorization,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          // 响应体也要有界：对端一直吐数据时不能把内存吃干。
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            finish(entry, false);
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => finish(entry, false));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          entry.confirm(Number(res.statusCode) || 0, text);
        });
      },
    );
    entry.req = req;
    // 超时就销毁请求，不留一条半死的连接拖住 flush 与进程退出。
    req.setTimeout(timeoutMs, () => req.destroy(new Error('langfuse timeout')));
    req.on('error', () => finish(entry, false));
    req.on('close', () => {
      if (!entry.settled) finish(entry, false);
    });
    req.end(data);
  }

  function spanBody(span) {
    // resource/scope 由本模块封，调用方只交原生 OTLP span 字段。
    const safe = sanitizeValue(span);
    if (!isPlainObject(safe)) return null;
    if (typeof safe.traceId !== 'string' || typeof safe.spanId !== 'string') return null;
    return {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'coagenthub' } }] },
          scopeSpans: [{ scope: { name: 'coagent-langfuse-transport' }, spans: [safe] }],
        },
      ],
    };
  }

  function scoreBody(score) {
    const safe = sanitizeValue(score);
    if (!isPlainObject(safe) || typeof safe.traceId !== 'string' || typeof safe.name !== 'string') return null;
    // 稳定 event id：同步重跑同一条 score 必须复用同一个 id，否则 Langfuse 会收成两条。
    const id =
      typeof safe.id === 'string' && safe.id
        ? safe.id
        : stableEventId(['score', safe.traceId, safe.name, safe.attemptId ?? null, safe.callIndex ?? null, safe.eventKey ?? null]);
    const payload = {
      id,
      name: safe.name,
      traceId: safe.traceId,
      value: safe.value,
    };
    if (typeof safe.dataType === 'string' && safe.dataType) payload.dataType = safe.dataType;
    if (typeof safe.comment === 'string') payload.comment = safe.comment;
    return {
      eventId: id,
      body: {
        batch: [{ id, type: 'score-create', timestamp: new Date().toISOString(), body: payload }],
      },
    };
  }

  function start(item) {
    const entry = { settled: false, req: null, resolve: item.resolve, confirm: () => finish(entry, false) };
    inflight.add(entry);
    try {
      if (item.kind === 'span') {
        const body = spanBody(item.payload);
        if (!body) return finish(entry, false);
        entry.confirm = (status, text) => finish(entry, otlpConfirmed(status, text));
        return post(OTLP_PATH, body, entry);
      }
      const score = scoreBody(item.payload);
      if (!score) return finish(entry, false);
      entry.confirm = (status, text) => finish(entry, ingestionConfirmed(status, text, score.eventId));
      return post(INGESTION_PATH, score.body, entry);
    } catch {
      // 构造请求体时出任何问题都按未确认处理，不向调用者抛。
      return finish(entry, false);
    }
  }

  function pump() {
    while (queue.length && inflight.size < MAX_CONCURRENCY) start(queue.shift());
    notifyIdle();
  }

  function enqueue(kind, payload) {
    if (!enabled) return Promise.resolve(false);
    if (queue.length + inflight.size >= maxQueue) return Promise.resolve(false);
    try {
      return new Promise((resolve) => {
        queue.push({ kind, payload, resolve });
        pump();
      });
    } catch {
      return Promise.resolve(false);
    }
  }

  function whenIdle() {
    if (!queue.length && !inflight.size) return Promise.resolve(true);
    return new Promise((resolve) => idleWaiters.push(() => resolve(true)));
  }

  /**
   * flush 有总期限：到期销毁剩余请求、把未确认项结算成 false。
   * 没有这条，断网时入口处的 flush 会一直等，进程退不掉。
   */
  async function flush() {
    // 关闭时没有任何服务确认，不能报成功。
    if (!enabled) return false;
    if (!queue.length && !inflight.size) return true;
    let timer = null;
    try {
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), flushMs);
        timer.unref?.();
      });
      const inTime = await Promise.race([whenIdle(), deadline]);
      if (inTime !== true) {
        for (const entry of [...inflight]) {
          try {
            entry.req?.destroy(new Error('langfuse flush deadline'));
          } catch {
            // 销毁失败也已按未确认结算。
          }
          finish(entry, false);
        }
        while (queue.length) queue.shift().resolve(false);
        return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    enqueueSpan: (span) => enqueue('span', span),
    enqueueScore: (score) => enqueue('score', score),
    flush,
  };
}
