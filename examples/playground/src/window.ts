/** 取前 n 个元素；n <= 0 返回空数组。 */
export function head<T>(values: readonly T[], n: number): T[] {
  return n <= 0 ? [] : values.slice(0, n);
}
