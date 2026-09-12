import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { gitExec } from "@server/lib/executor-runner";

/**
 * 外来提交判定(spec retry-rollback-must-not-destroy-foreign-commits R1/R3):
 * 检查点 ref 之后到 HEAD 之间是否存在提交(提交可达性,ADR-0009:判据指名
 * 「checkpoint 之后是否存在提交」这一事实,而非「HEAD 是否等于 checkpoint」)。
 *
 * 为何不是 SHA 相等比较:checkpoint 由 createCheckpoint 的 `commit-tree -p HEAD`
 * 打出的**新**提交对象,其父才是任务起点 HEAD —— checkpoint ref 与 HEAD 的 SHA
 * 恒不相等,直接比较会把每次重试都误判为外来提交。改用
 * `git rev-list --count <ref>..HEAD`:干净重试(起点后无提交)→ 0;共享工作树
 * 在任务启动后接受了外来提交(检视者冻结/其他任务产物/手工提交)→ >0。
 *
 * 返回 null 表示无法读取提交图(ref 无效/非仓库/git 失败):调用方不得据此
 * 跳过回滚(那会静默销毁),应回落既有的「回滚失败 → 终止重试」语义。
 */
export async function countCommitsAfterCheckpoint(
  ref: string,
  repoRoot: string,
): Promise<number | null> {
  const head = await gitExec(["rev-parse", "HEAD"], repoRoot);
  if (head.status !== 0) return null;
  const count = await gitExec(
    ["rev-list", "--count", `${ref}..HEAD`],
    repoRoot,
  );
  if (count.status !== 0) return null;
  const n = parseInt((count.stdout ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 任务书声明仓库解析:任务书 body 显式声明目标仓库路径时(行级
 * `仓库:` / `仓库路径:` / `Repository:` / `Repo:` 大小写不敏感、允许前后空白),
 * 返回该行第一个路径 token(绝对路径且 existsSync 为目录才采用);否则回退群绑定
 * projectPath(保持现行为,允许为空 → 后续由 findRepoRoot() 兜底)。用于 spawn cwd
 * / 执行前快照 / 重试前回滚统一落在任务书声明的仓库上。
 */
export function resolveTaskRepo(
  body: string,
  groupProjectPath: string | null,
): string | null {
  const declared = parseRepoPathFromBody(body);
  if (
    declared &&
    isAbsolute(declared) &&
    existsSync(declared) &&
    statSync(declared).isDirectory()
  ) {
    return declared;
  }
  return groupProjectPath ?? null;
}

/**
 * 从任务书 body 解析显式声明的仓库路径:命中 `仓库:` / `仓库路径:` /
 * `Repository:` / `Repo:` 行(大小写不敏感、允许前后空白,行首即关键字)取行内
 * 第一个路径 token;无声明 → null。关键字严格从行首(仅允许前导空白)开始,避免
 * 正文偶然出现「仓库:」字样误命中。
 */
function parseRepoPathFromBody(body: string): string | null {
  const re = /^\s*(?:仓库路径|仓库|repository|repo)\s*[:：]\s*(.+?)\s*$/i;
  for (const raw of body.split("\n")) {
    const m = re.exec(raw);
    if (m) {
      const token = m[1].trim().split(/\s+/)[0];
      if (token) return token;
    }
  }
  return null;
}
