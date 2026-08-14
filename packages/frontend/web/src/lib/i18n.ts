/**
 * 极简 i18n:t(key, params?) 从当前语言词典取文案,支持 {name} 占位符。
 * 语言解析顺序:
 *   1. localStorage["coagenthub.lang"]("zh" | "en")——显式设置优先;
 *   2. navigator.language 前缀:en* → en,其余(含 zh*)→ zh(默认中文)。
 * 无第三方依赖,零配置。
 */
import { en } from "./i18n/en";
import { type DictKey, zh } from "./i18n/zh";

export type Lang = "zh" | "en";

const LANG_STORAGE_KEY = "coagenthub.lang";

function readStoredLang(): Lang | null {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    return saved === "en" || saved === "zh" ? saved : null;
  } catch {
    // localStorage 不可用(隐私模式 / SSR)时回落到 navigator.language。
    return null;
  }
}

export function getLang(): Lang {
  const stored = readStoredLang();
  if (stored) {
    return stored;
  }
  const navLang = typeof navigator !== "undefined" ? navigator.language : "";
  return navLang.toLowerCase().startsWith("en") ? "en" : "zh";
}

export function t(
  key: DictKey,
  params?: Record<string, string | number>,
): string {
  const dict = getLang() === "en" ? en : zh;
  let text: string = dict[key];
  if (text === undefined) {
    // 词典缺 key 时兜底返回 key 本身,便于发现遗漏。
    return key;
  }
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
