/**
 * 快照与还原。
 *
 * 聚合的字段全是 `#` 私有的，外部映射层够不着——所以序列化必须由聚合自己
 * 提供。这里进出的都是**纯数据**（能直接 JSON 化的普通对象），不涉及文件、
 * 数据库或任何存储概念：存到哪里是上层的事。
 *
 * 还原走的是"直接装配"而不是"重放动作"：重放会重新触发不变量校验，
 * 而历史状态是既成事实，不该被今天的规则重新审一遍。
 */

import type { MissionExecutionMode, RunKind } from './payloads.ts';

export interface AttemptSnapshot {
  id: string;
  kind: 'coordinator' | 'executor';
  missionId?: string;
  workItemId?: string;
  status: 'in_progress' | 'succeeded' | 'failed';
  /** 租约：最近一次心跳与它的持有者。见 Attempt.isAbandoned。 */
  heartbeatAt?: string;
  leaseOwner?: string;
  failReason?: string;
  evidence: unknown[];
  usage: unknown;
  endedBy?: string;
  resumeRef?: string;
  output?: string;
  profile?: unknown;
  outputRef?: string;
  toolActivity?: unknown[];
}

export interface WorkItemSnapshot {
  id: string;
  missionId: string;
  title: string;
  status: string;
  order?: unknown;
  /** 拆出它时的规划版本（S05.2）。 */
  planRevision?: number;
  result?: unknown;
  submitted: boolean;
  reviews: unknown[];
  blocked?: unknown;
  /** 被作废时写下的理由。老快照没有这个字段，读出来就是 undefined。 */
  retired?: unknown;
  attempts: AttemptSnapshot[];
  executorSeq: number;
}

export interface MissionSnapshot {
  id: string;
  projectId: string;
  status: string;
  contract?: unknown;
  contractRevision: number;
  plan?: unknown;
  planRevision: number;
  result?: unknown;
  escalations: unknown[];
  origin?: unknown;
  hasMutated?: boolean;
  workspaceRef?: unknown;
  finalReview?: unknown;
  waitReason?: string;
  waitDetail?: string;
  /** 最后一次状态变化的时间。 */
  updatedAt?: string;
  paused?: boolean;
  /** 老快照可能没有；restore 时缺省/非法 -> standard。 */
  executionMode?: MissionExecutionMode;
  /** 老快照可能没有；restore 时缺省/非法 -> mutation。 */
  runKind?: RunKind;
  workItems: WorkItemSnapshot[];
  coordinatorAttempts: AttemptSnapshot[];
  coordinatorSeq: number;
}

export interface ProjectSnapshot {
  id: string;
  missions: MissionSnapshot[];
}
