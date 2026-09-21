/**
 * DETECT-001：纯确定性 diff 晋升触发检测（changed_files / top_level_modules）。
 *
 * 只消费 trusted WorkspaceManager.diff / getMissionDiff 的 files 清单。
 * 无 filesystem / git / Mission / Platform / Decision / Validation / budget 依赖。
 * 各 code 检测器独立；本模块不选择优先级、不接线、不自动 promote。
 */

/** 检测器输入：仅 trusted diff 的路径清单。 */
export interface DiffPromotionDetectInput {
  readonly files: readonly string[];
}

/**
 * 最小规范化：trim、丢空串、统一分隔符为 `/`、按规范化路径去重（保序）。
 * 不解析 stat、不读盘、不改写调用方数组。
 */
export function normalizeDiffFiles(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of files) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().replace(/\\/g, '/');
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** 取路径第一个非空 segment（分隔符已规范化为 `/`）。 */
function firstPathSegment(normalizedPath: string): string | undefined {
  for (const part of normalizedPath.split('/')) {
    if (part.length > 0) return part;
  }
  return undefined;
}

/**
 * >3 个唯一规范化路径 → `changed_files_gt_3`。
 * 0..3 → null。重复路径不计多次。
 */
export function detectChangedFilesGt3(
  input: DiffPromotionDetectInput,
): 'changed_files_gt_3' | null {
  const unique = normalizeDiffFiles(input.files);
  return unique.length > 3 ? 'changed_files_gt_3' : null;
}

/**
 * 唯一 top-level 路径段 >2 → `top_level_modules_gt_2`。
 * 段取规范化路径的第一个非空 segment。
 */
export function detectTopLevelModulesGt2(
  input: DiffPromotionDetectInput,
): 'top_level_modules_gt_2' | null {
  const unique = normalizeDiffFiles(input.files);
  const modules = new Set<string>();
  for (const path of unique) {
    const top = firstPathSegment(path);
    if (top !== undefined) modules.add(top);
  }
  return modules.size > 2 ? 'top_level_modules_gt_2' : null;
}
