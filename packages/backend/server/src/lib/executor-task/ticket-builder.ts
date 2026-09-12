import { serverPort } from "@server/lib/config";
import type { DataBase } from "@server/lib/database";
import { reviewRequestCarryAllowed } from "./review-request-policy";
import {
  buildExecutionModeLines,
  buildReportLines,
  loadTicketTemplate,
  type TicketRole,
} from "./ticket-template";
import type { GroupPromptInfo, QueuedRun } from "./types";

/* ---------------- 测试执行器选择 / 任务书模板 ---------------- */

/** 测试职责关键词(分工提示词匹配用,大小写不敏感)。 */
const TEST_KEYWORDS = [
  "测试",
  "验证",
  "检验",
  "test",
  "verify",
  "review",
] as const;

/** 统计 needle 在 haystack 中的出现次数(调用方保证同为小写)。 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * 测试执行器选择(任务书「执行与测试要求」段):群成员中 roles 含
 * executor/specialist 且分工提示词(prompt)匹配测试职责(关键词:测试/验证/
 * 检验/test/verify/review,大小写不敏感)的执行器。
 * - 匹配多个 → 取 prompt 中测试关键词出现次数最多的(并列按名字字典序,稳定);
 * - 无匹配 → null(任务书写「默认由实现执行器完成测试」)。
 * targetExecutorName = 实现执行器的 participant 名,候选排除其本身(避免自测
 * 自验);与 buildTicket 解耦、独立可单测。
 */
export async function resolveTestExecutor(
  db: DataBase,
  groupId: string,
  targetExecutorName: string,
): Promise<string | null> {
  const members = await db.query.groupMember.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
  });
  const executorMembers = members.filter((m) =>
    m.roles.some((r) => r === "executor" || r === "specialist"),
  );
  if (executorMembers.length === 0) return null;
  const participants = await db.query.participant.findMany({
    where: (t, { inArray: inFn }) =>
      inFn(
        t.id,
        executorMembers.map((m) => m.participantId),
      ),
    columns: { id: true, name: true },
  });
  const nameById = new Map(participants.map((p) => [p.id, p.name]));
  const target = targetExecutorName.trim().toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const m of executorMembers) {
    const name = nameById.get(m.participantId);
    if (!name || !m.prompt) continue;
    if (name.trim().toLowerCase() === target) continue; // 排除实现执行器本身
    const lower = m.prompt.toLowerCase();
    const score = TEST_KEYWORDS.reduce(
      (acc, kw) => acc + countOccurrences(lower, kw),
      0,
    );
    if (score > 0) scored.push({ name, score });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored[0].name;
}

/**
 * 执行器任务书固定模板(票7):标题 + 执行器/项目/发布时间 + 任务内容 + 汇报
 * 格式要求(执行器 stdout 按「提交/测试/汇报/遗留」四段输出,server 按段落
 * 解析成结构化 diffSummary)。模板只影响任务书文本,不改任务触发逻辑。
 * 角色解绑后的「本群分工」段与「默认约束」作为尾部附加说明保留(前序票的
 * 既有行为,删除会回归)。「执行与测试要求」段(任务书模板固化):实现执行器 =
 * 定向目标 label;测试执行器 = resolveTestExecutor 解析结果或默认由实现执行器
 * 完成测试;body 中的显式「**测试执行器:**」行原样保留(执行器读任务书即可)。
 */
/**
 * 规范驱动下发:「关联规范」段(CLI ticket 与 a2a prompt 共用,避免两路漂移)。
 * 平台事实(路径 / 哈希)留在代码;「指令」方法论文案来自模板(R1 自行判断切分)。
 * specRef 为空时应由调用方自行跳过,本函数不做判断。
 */
export function buildSpecSection(
  specRef: string,
  specHash: string | null,
  instruction: string,
): string[] {
  return [
    `## 📜 关联规范 (Spec Reference)`,
    `- **文档路径**: ${specRef}`,
    ...(specHash ? [`- **版本哈希**: ${specHash}`] : []),
    ...(instruction ? [`- **指令**: ${instruction}`] : []),
  ];
}

/** HTTP coordinates embedded in every task book/prompt; no plugin env is needed. */
export function executionApiBase(): string {
  const configured = process.env.COAGENTHUB_API_BASE?.trim();
  const base = configured || `http://localhost:${serverPort()}/api`;
  return base.replace(/\/+$/, "");
}

/** 平台事实段:不可被模板覆盖或删除(R1 / R5)。 */
function buildExecutionContextSection(run: QueuedRun): string[] {
  const lines = [
    "## 执行上下文 (用于直接调用 CoAgentHub HTTP API)",
    `- apiBase: ${executionApiBase()}`,
    `- participantId: ${run.participantId} (这是接收者自己的 participant id)`,
    `- groupId: ${run.groupId}`,
    `- taskId: ${run.taskId} (这是你自己的 task id)`,
    `- 认证:全信模型,请求带 HTTP 头 X-Participant-Id: ${run.participantId}`,
  ];
  if (run.detached) {
    lines.push(
      `- 这是 detached 任务。完成后必须 PATCH ${executionApiBase()}/groups/${run.groupId}/tasks/${run.taskId}，带 status 与 diffSummary 回写终态。`,
      "- 不回写会使任务保持 running，直到 detachedTimeoutMinutes(默认 1440 分钟)兜底超时，检视者会一直等不到结果。",
    );
  }
  return lines;
}

function ticketRole(groupPrompt: GroupPromptInfo | null): TicketRole {
  const roles = groupPrompt?.roles ?? [];
  if (roles.includes("coordinator")) return "coordinator";
  if (roles.includes("executor")) return "executor";
  return "fallback";
}

/**
 * 执行器任务书(票7 + S6):标题 / 平台上下文 / 任务内容由代码组装;
 * 「执行方式」「汇报格式」方法论文案按 dispatchKind 读仓库模板(R2),
 * 每次 build 读盘,改模板无需重建 server。
 */
export function buildTicket(
  body: string,
  label: string,
  repoRoot: string,
  run: QueuedRun,
  groupPrompt: GroupPromptInfo | null = null,
  testExecutor: string | null = null,
  specRef: string | null = null,
  specHash: string | null = null,
  groupHasReviewer = false,
): string {
  // 策略模板:dispatchKind 专属 → 全局;平台不得写(只读)。
  const template = loadTicketTemplate(run.dispatchKind);
  const lines = [
    `# CoAgentHub 任务`,
    `执行器: ${label}`,
    `项目: ${repoRoot}`,
    `发布时间: ${new Date().toISOString()}`,
  ];
  // 规范驱动下发:specRef 非空时,在「任务内容」之前插入「关联规范」段
  // (Spec 优先于任务内容——执行器严格按 Spec 实现,冲突以 Spec 为准)。
  if (specRef) {
    lines.push(
      ...buildSpecSection(specRef, specHash, template.specInstruction),
    );
  }
  const role = ticketRole(groupPrompt);
  // 可携带判定仍走平台机制(与 tasks.ts R3 共用),文案来自模板。
  const reportHasReviewer = reviewRequestCarryAllowed(
    run.dispatchKind,
    groupHasReviewer,
  );
  lines.push(
    `## 任务内容`,
    body,
    ...buildExecutionModeLines(template, role),
    ...buildReportLines(template, role, reportHasReviewer),
  );
  // R5:平台段在模板组装之后强制插入,模板无法删掉 taskId / detached 回写要求。
  const context = buildExecutionContextSection(run);
  lines.splice(4, 0, ...context);
  // 角色解绑后:成员在本群有分工提示词时,任务书插入「本群分工」段(先角色后
  // 提示词原文);无 prompt 时整段不输出,任务书与解绑前完全一致。
  if (groupPrompt?.prompt?.trim()) {
    lines.push(
      `本群分工:角色=[${groupPrompt.roles.join(",")}];提示词=${groupPrompt.prompt}`,
    );
  }
  // 执行与测试要求段(任务书模板固化):实现执行器 = 定向目标 label;测试执行器 =
  // resolveTestExecutor 解析结果,无匹配 → 默认由实现执行器完成测试。
  // 测试口径与 AGENTS.md 对齐:票面清单 / 失败数不增加 / 前后基线对照
  // (本机有既有红基线,「全部通过后再提交」不可达成)。
  lines.push(
    "## 执行与测试要求",
    `- 实现执行器:${label}(必选,由发布者定向)`,
    `- 测试执行器:${testExecutor ?? "默认由实现执行器完成测试"}`,
    "- 只跑票面指定的测试文件清单,不要跑全量。",
    "- 验收口径是「失败数不增加」(本机存在既有红基线),不是「全部用例通过」。",
    "- 改动前先取一次基线,改动后再取一次,汇报给出前后对照。",
    "- 取基线:node scripts/test-baseline.mjs <包目录> <测试文件...>",
    "- 汇报需包含测试结果(含前后基线对照)。",
  );
  lines.push(
    `默认约束(除非消息里明确说明):不动 schema/迁移/scripts/ 下其他脚本、不删数据;按票面清单跑测且失败数不增加后提交,commit message 按功能写。`,
  );
  return lines.join("\n");
}
