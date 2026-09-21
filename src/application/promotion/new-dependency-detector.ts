/**
 * DETECT-002：纯确定性 new_dependency 晋升触发检测。
 *
 * 只比较两份仓库根 package.json 文本（base / current）。
 * 无 filesystem / git / Mission / Platform / Decision / Validation / budget 依赖。
 * 本模块不接线、不自动 promote、不读 lockfile / 嵌套 manifest。
 */

/** 检测器输入：trusted showRootPackageJson 在 base/current revision 的原文。 */
export interface NewDependencyDetectInput {
  readonly baseText: string | undefined;
  readonly currentText: string | undefined;
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析一侧 package.json 的依赖 key 并集。
 * undefined / 非法 JSON / 非 object 根 / 非 plain-object 段 → null（fail closed）。
 */
function dependencyKeyUniverse(text: string | undefined): Set<string> | null {
  if (typeof text !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const keys = new Set<string>();
  for (const section of DEPENDENCY_SECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, section)) {
      // 缺失段 ≡ 空对象
      continue;
    }
    const value = parsed[section];
    if (!isPlainObject(value)) return null;
    for (const key of Object.keys(value)) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * current 依赖 key 并集相对 base 出现至少一个新 key → `new_dependency`。
 * 版本变更 / 段间搬迁 / 仅删除 / 任一侧不可用 → null。
 */
export function detectNewDependency(
  input: NewDependencyDetectInput,
): 'new_dependency' | null {
  const baseKeys = dependencyKeyUniverse(input.baseText);
  const currentKeys = dependencyKeyUniverse(input.currentText);
  if (baseKeys === null || currentKeys === null) return null;

  for (const key of currentKeys) {
    if (!baseKeys.has(key)) return 'new_dependency';
  }
  return null;
}
