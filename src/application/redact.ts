/**
 * 凭据脱敏（优化方案 §7 P0.3 末条）：agent 产出、要落盘或给人看的文本，进门先过一遍。
 *
 * 两类命中：
 *   1. **已知值**：平台进程环境里名字像凭据的变量（KEY / TOKEN / SECRET / PASSWORD …）的值。
 *      agent 一句 `env` 或 `cat .env` 就能把本机真 key 写进证据——按值精确替换最可靠，
 *      而且替换成 `[REDACTED:变量名]`，人还看得出那里原来是什么。
 *   2. **形状**：私钥块、Bearer、JWT、常见前缀的 key（sk- / xai- / ghp_ / AKIA …）、`xxx_key=…` 赋值。
 *
 * 只替换命中的那一段，保留上下文——与 decision-remote-input 的「整条丢弃」不同：那里是往外发，
 * 宁缺毋滥；这里是给人看的证据，丢掉整段就看不懂了。
 *
 * 不碰：纯数字（token 计数、耗时）、40 位提交哈希、裸 UUID。宁可漏掉一个没前缀的随机串，
 * 也不能把 `total=67360` 和提交号抹成一片 REDACTED——那样证据就废了。
 */

export interface Redactor {
  redact(text: string): string;
  /** 深拷贝一份，所有字符串叶子过 redact；非字符串原样。不改入参。 */
  redactDeep<T>(value: T): T;
}

/** 变量名像凭据：按名字挑，不按值猜。 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
/** 太短的值替换了会误伤（`true`、`local`、端口号）。 */
const MIN_KNOWN_VALUE = 8;

const SHAPES: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED:PRIVATE KEY]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED:JWT]'],
  [
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})/g,
    '[REDACTED]',
  ],
  // `api_key=…` / `"apiKey": "…"` / `SECRET: …`：保留名字，只抹值。值里至少有一个字母——
  // 纯数字多半是计数（`tokenCount=12345678`），不是凭据。已经是 [REDACTED…] 的不再动：
  // 否则按值换出来的 `[REDACTED:变量名]` 会被这一条再抹成光秃秃的 `[REDACTED]`，丢了是哪个变量。
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)(["']?)(?!\[REDACTED)((?=[^\s"'`,;]*[A-Za-z])[^\s"'`,;]{8,})\3/gi,
    '$1$2$3[REDACTED]$3',
  ],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRedactor(env: Readonly<Record<string, string | undefined>>): Redactor {
  // 长的先换：一个值是另一个值的子串时，先换短的会把长的切碎、剩半截漏出去。
  const known = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.trim().length >= MIN_KNOWN_VALUE)
    .map(([name, value]) => ({ name, pattern: new RegExp(escapeRegExp(value!.trim()), 'g') , length: value!.trim().length }))
    .sort((a, b) => b.length - a.length);

  function redact(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = text;
    for (const { name, pattern } of known) out = out.replace(pattern, `[REDACTED:${name}]`);
    for (const [pattern, replacement] of SHAPES) out = out.replace(pattern, replacement);
    return out;
  }

  function redactDeep<T>(value: T): T {
    if (typeof value === 'string') return redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(item);
      return out as T;
    }
    return value;
  }

  return { redact, redactDeep };
}

let processRedactor: Redactor | undefined;

/**
 * 按平台进程自己的环境脱敏。第一次用到时才读 process.env，之后不再变：
 * 平台启动后新设的环境变量本来也到不了它派生的 agent。
 */
export function redactSecrets(text: string): string {
  processRedactor ??= createRedactor(process.env);
  return processRedactor.redact(text);
}

export function redactSecretsDeep<T>(value: T): T {
  processRedactor ??= createRedactor(process.env);
  return processRedactor.redactDeep(value);
}
