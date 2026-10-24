// 金额工具。约定见 docs/CONVENTIONS.md：金额以「分」为整数，舍入只在最后一步、用银行家舍入。

export class MoneyError extends Error {}

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * 把十进制字符串解析成放大 10^scale 倍的整数（BigInt）。
 * 小数位超过 scale 时报错，不做舍入：parseDecimal('7.25', 6) === 7250000n。
 */
export function parseDecimal(text, scale) {
  const match = DECIMAL.exec(String(text).trim());
  if (!match) throw new MoneyError(`不是合法的数字：${text}`);
  const fraction = match[3] ?? '';
  if (fraction.length > scale) throw new MoneyError(`小数位超过 ${scale} 位：${text}`);
  const digits = BigInt(match[2] + fraction.padEnd(scale, '0'));
  return match[1] ? -digits : digits;
}

/** '12.3' -> 1230（分，Number）。 */
export function parseAmount(text) {
  return Number(parseDecimal(text, 2));
}

/** 1230 -> '12.30'；接受 Number 或 BigInt。 */
export function formatCents(cents) {
  const value = BigInt(cents);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const text = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/**
 * numerator / denominator 按银行家舍入（四舍六入五成双）到整数，返回 Number。
 * 参数可以是 Number 或 BigInt；中间计算全用 BigInt，不丢精度。
 */
export function roundHalfEven(numerator, denominator) {
  let num = BigInt(numerator);
  let den = BigInt(denominator);
  if (den === 0n) throw new MoneyError('除数不能为 0');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  let quotient = num / den;
  let remainder = num % den;
  if (remainder < 0n) {
    quotient -= 1n;
    remainder += den;
  }
  const twice = 2n * remainder;
  if (twice > den || (twice === den && quotient % 2n !== 0n)) quotient += 1n;
  return Number(quotient);
}
