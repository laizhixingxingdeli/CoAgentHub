/**
 * 方案文件（`missions/PLAN-*.json`）的形状。
 *
 * 方案只写「做什么、为什么、范围、验收」，**不带** facts / assessment / workOrder：
 * 拆方案那一刻还不知道后面的功能会碰哪些文件，手写一百多个字段也不现实。
 * 路由推迟到功能真要开跑时现做（见 plan-routing.ts）——那时前面的改动已经
 * 在集成分支上，判得更准。
 */

import type { PlanStopConditions } from './plan-run.ts';

export interface PlanFeatureSpec {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  /** 方案声明的改动范围：文件写路径，目录以 `/` 结尾。Fast Lane 工单不得越出。 */
  readonly allowedScope: readonly string[];
  readonly acceptance: readonly string[];
  /** 以前的运行里已经合进集成分支的，标 done，本次不再跑。 */
  readonly status?: 'done';
}

export interface PlanVerificationCommand {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface PlanSpec {
  readonly planId: string;
  readonly projectId: string;
  readonly intent: string;
  readonly integrationBranch: string;
  /** 夜里谁来定升级单。只有它的决定作数。 */
  readonly reviewer: string;
  readonly stopConditions: PlanStopConditions;
  /** 机器 L3 合并**之后**在集成分支上跑的命令：有没有打坏别人。 */
  readonly integrationVerification: readonly PlanVerificationCommand[];
  readonly features: readonly PlanFeatureSpec[];
}
