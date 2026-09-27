/**
 * 方案功能点的「现做分类」：只读协调者读集成分支现状、交回**事实**，平台的
 * 确定性分类器按事实定路由。
 *
 * 协调者的判断是概率性的，所以它只能**选路**：它报事实，不报路由；路由只由
 * `classifyTask` 定，关键事实拿不准就是 unknown，unknown 就走完整的 Standard。
 * 开门（合进集成分支）另有确定性证据把关，见 `Platform.finalizeMissionByMachine`。
 *
 * 任何一处读不懂、越界、自相矛盾，都回落 Standard——被一段话骗进 Fast Lane
 * 的代价，是一条没有协调者把关的改动；回落 Standard 的代价只是多花一点钱。
 */

import type { ComplexityAssessment, WorkOrder } from '../kernel/index.ts';
import {
  ClassifiedMissionInputError,
  parseComplexityAssessmentStrict,
  parseTaskFactsStrict,
} from './classified-mission-intake.ts';
import { classifyTask, type ClassificationResult, type TaskFacts } from './task-classifier.ts';
import { isEscapePath, normalizePath, scopeMatches } from './validation/engine.ts';
import type { PlanFeatureSpec, PlanSpec } from './plan-spec.ts';

export interface RoutingProposal {
  readonly facts: TaskFacts;
  readonly assessment?: ComplexityAssessment;
  readonly workOrder?: WorkOrder;
}

export type RoutingDecision =
  /** 按分类器的结论建 classified Mission；只有 lightweight 带工单。 */
  | {
      readonly kind: 'classified';
      readonly facts: TaskFacts;
      readonly assessment?: ComplexityAssessment;
      readonly workOrder?: WorkOrder;
      readonly classification: ClassificationResult;
    }
  /** 不分类，按老路建 Standard Mission，协调者从头调查规划。 */
  | { readonly kind: 'standard_fallback'; readonly reason: string }
  /** 禁止副作用未证明安全，或其它必须停下来问人的路由；不建 Mission。 */
  | { readonly kind: 'needs_human'; readonly reason: string; readonly needsDecision: string };

const PROPOSAL_KEYS = new Set(['facts', 'assessment', 'workOrder']);

/** 取**最后一个** ```json 块：模型常先举一个例子再给结论。 */
function lastJsonBlock(output: string): string | undefined {
  const blocks = [...output.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  return blocks.at(-1)?.[1];
}

/**
 * 评估的时间盖平台的，不用模型的。
 *
 * 让模型填 `assessedAt`，它就编一个：E2 实测 7/7 全是编的整点，有半年前的，也有比实际晚
 * 11 小时的——审计链上「这条路由什么时候定的」就成了假的。模型给了照样覆盖；没给也补上，
 * 否则严格解析会因为缺这个字段把整份评估拒掉，白白退回 Standard。
 */
function stampAssessedAt(raw: unknown, assessedAt: string): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  return { ...(raw as Record<string, unknown>), assessedAt };
}

/** @param assessedAt 平台时钟给的时间（ISO），拿到分类员回答的那一刻。 */
export function parseRoutingProposal(
  output: string,
  assessedAt: string,
): { ok: true; proposal: RoutingProposal } | { ok: false; reason: string } {
  const block = lastJsonBlock(output);
  if (block === undefined) return { ok: false, reason: '输出里没有 ```json 块。' };
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch (error) {
    return {
      ok: false,
      reason: `最后一个 json 块不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'json 块不是对象。' };
  }
  const extra = Object.keys(raw).filter((key) => !PROPOSAL_KEYS.has(key));
  if (extra.length > 0) {
    // 多出来的键（尤其 route / executionMode）是在试图替分类器下结论。
    return { ok: false, reason: `json 块里有不认识的键：${extra.join(', ')}。` };
  }
  const body = raw as { facts?: unknown; assessment?: unknown; workOrder?: unknown };
  try {
    const facts = parseTaskFactsStrict(body.facts);
    const assessment = parseComplexityAssessmentStrict(stampAssessedAt(body.assessment, assessedAt));
    if (assessment && assessment.decidedBy !== 'coordinator') {
      return {
        ok: false,
        reason: `评估是只读协调者做的，decidedBy 必须是 coordinator，收到 ${assessment.decidedBy}。`,
      };
    }
    const workOrder = body.workOrder;
    if (workOrder !== undefined) {
      const scope = (workOrder as { allowedScope?: unknown } | null)?.allowedScope;
      if (
        workOrder === null ||
        typeof workOrder !== 'object' ||
        !Array.isArray(scope) ||
        scope.length === 0 ||
        !scope.every((item) => typeof item === 'string')
      ) {
        return { ok: false, reason: 'workOrder 必须是对象且带非空的 allowedScope。' };
      }
    }
    return {
      ok: true,
      proposal: {
        facts,
        ...(assessment ? { assessment } : {}),
        ...(workOrder !== undefined ? { workOrder: workOrder as WorkOrder } : {}),
      },
    };
  } catch (error) {
    if (error instanceof ClassifiedMissionInputError) return { ok: false, reason: error.message };
    throw error;
  }
}

/** 与平台 HA 建单闸同一组字段；true / unknown / 缺失都算未证明安全。 */
const HA_FORBIDDEN_SIDE_EFFECTS = [
  'productionDeployRelease',
  'externalPaidOp',
  'destructiveData',
  'unrecoverableExternalSideEffect',
] as const;

function unprovenHaForbiddenSideEffects(facts: TaskFacts): string[] {
  const ha = facts.highAssurance;
  return HA_FORBIDDEN_SIDE_EFFECTS.filter((key) => ha[key] !== false);
}

/**
 * 工单的每一条范围都得落在方案声明的范围里。语义与 validator 的 changed-paths
 * 一致：文件精确匹配，目录以 `/` 结尾含子孙。工单里的目录只能落进方案里的目录。
 */
function outOfScope(workOrderScope: readonly string[], declared: readonly string[]): string[] {
  const outer = declared.map(normalizePath);
  return workOrderScope.filter((raw) => {
    const inner = normalizePath(raw);
    if (inner === '' || isEscapePath(inner) || /[*?[]/.test(inner)) return true;
    if (!inner.endsWith('/')) return !outer.some((scope) => scopeMatches(scope, inner));
    return !outer.some((scope) => scope.endsWith('/') && inner.startsWith(scope));
  });
}

export function decideRoute(
  proposal: RoutingProposal | undefined,
  feature: PlanFeatureSpec,
  unreadReason = '只读协调者没给出可用的事实。',
): RoutingDecision {
  if (!proposal) return { kind: 'standard_fallback', reason: unreadReason };
  const classification = classifyTask({
    facts: proposal.facts,
    ...(proposal.assessment ? { assessment: proposal.assessment } : {}),
  });
  const base = {
    facts: proposal.facts,
    ...(proposal.assessment ? { assessment: proposal.assessment } : {}),
    classification,
  };
  const { recommended } = classification;
  if (recommended.runKind === 'query') {
    return {
      kind: 'standard_fallback',
      reason: '只读协调者判它不用改代码。方案里的功能点不该是只读的，交给协调者完整核实。',
    };
  }
  // 分类器把 HA 字段 unknown 抬成 Standard；禁止副作用仍必须在建单前停。
  const forbidden = unprovenHaForbiddenSideEffects(proposal.facts);
  if (forbidden.length > 0) {
    const fields = forbidden.join('、');
    return {
      kind: 'needs_human',
      reason: `high_assurance 禁止副作用未证明为 false：${fields}`,
      needsDecision:
        `分类触及禁止副作用（${fields}）：不建 Mission。` +
        `要你定：亲自主导 ${feature.id}，还是去掉这些副作用后重排进方案？`,
    };
  }
  if (recommended.executionMode === 'high_assurance' || recommended.executionMode === 'standard') {
    // HA / Standard 都禁止带 Lightweight 工单；合格 HA 把原始 facts 交给 createClassifiedMission。
    return { kind: 'classified', ...base };
  }
  const workOrder = proposal.workOrder;
  if (!workOrder) {
    return { kind: 'standard_fallback', reason: '判成 Fast Lane 却没给冻结工单。' };
  }
  const outside = outOfScope(workOrder.allowedScope, feature.allowedScope);
  if (outside.length > 0) {
    return {
      kind: 'standard_fallback',
      reason: `工单范围越出方案声明（${feature.allowedScope.join('、')}）：${outside.join('、')}。`,
    };
  }
  return { kind: 'classified', ...base, workOrder };
}

const LIST = (items: readonly string[]) => items.map((item) => `  - ${item}`).join('\n');

/** 给只读协调者的话。它只读、只报事实；路由不归它定。 */
export function buildRoutingPrompt(plan: PlanSpec, feature: PlanFeatureSpec): string {
  return `你是 CoAgentHub 方案运行里的**只读分类员**。你不能改任何文件；你的工具只有 read / grep / find / ls。

方案 ${plan.planId}：${plan.intent}
你看到的工作区就是集成分支 ${plan.integrationBranch} 的当前状态——方案里前面的功能已经合进来了。

这次要判的功能点：${feature.id}「${feature.title}」
为什么要做：${feature.why}
方案声明的改动范围（文件写路径，目录以 / 结尾；工单范围不得越出）：
${LIST(feature.allowedScope)}
验收：
${LIST(feature.acceptance)}

你的任务：读代码，如实报告这个功能的**事实**。你不决定路由——平台的确定性分类器按事实定。
拿不准的一律写 "unknown"：那会让它走完整的协调流程，这是安全的默认，不算你没做好。

事实的含义（true / false / "unknown"）：
- mutationSideEffect：要不要改仓库里的文件。readOnlyProven：能不能证明完全只读。
- highAssurance.*：productionDeployRelease 生产/部署/发布/对外通知；externalPaidOp 付费操作；
  destructiveData 删除、批量覆盖、数据迁移；credentialsPermissionsSecurity 凭据、权限或安全策略；
  schemaPublicApiPersistenceCompat 数据库 Schema、公开接口、持久化格式或向后兼容；
  unrecoverableExternalSideEffect 不能靠 Git 恢复的外部副作用。
- standardFloor.*：publicInterface 要改公共接口；buildSystemOrDependency 构建系统或依赖；
  multipleDomainModules 跨多个领域模块；acceptanceNotCheckableUpfront 验收没法事先写成可检查的条目；
  rootCauseOrCompetingDesigns 要先查根因或比较多个方案。

六维评估（各 0 / 1 / 2）：goalUncertainty 目标确定性、changeScope 影响范围、operationalRisk 运行风险、
verificationDifficulty 验证难度、coordinationNeed 协调依赖、recoveryDifficulty 失败恢复。

只有当 standardFloor 全是 false、highAssurance 全是 false、六维合计不超过 5——也就是一个执行者照着工单
就能做完的小改动——才附 workOrder；否则省略这个键。workOrder 的 validation.commands 至少一条能证明验收的命令。

最后输出**一个** \`\`\`json 代码块，键不多不少：

\`\`\`json
{
  "facts": {
    "mutationSideEffect": true,
    "readOnlyProven": false,
    "highAssurance": {
      "productionDeployRelease": false,
      "externalPaidOp": false,
      "destructiveData": false,
      "credentialsPermissionsSecurity": false,
      "schemaPublicApiPersistenceCompat": false,
      "unrecoverableExternalSideEffect": false
    },
    "standardFloor": {
      "publicInterface": "unknown",
      "buildSystemOrDependency": false,
      "multipleDomainModules": false,
      "acceptanceNotCheckableUpfront": false,
      "rootCauseOrCompetingDesigns": false
    }
  },
  "assessment": {
    "goalUncertainty": 0, "changeScope": 1, "operationalRisk": 1,
    "verificationDifficulty": 1, "coordinationNeed": 0, "recoveryDifficulty": 0,
    "reasons": ["每一维为什么这么判，一句话"],
    "decidedBy": "coordinator"
  },
  "workOrder": {
    "objective": "…", "allowedScope": ["…"], "requiredBehaviour": "…",
    "constraints": [], "acceptance": ["…"], "verification": ["…"], "doNot": [], "contextRefs": [],
    "validation": { "commands": [{ "argv": ["node", "--test", "test/….test.ts"], "timeoutMs": 120000 }] }
  }
}
\`\`\`
`;
}
