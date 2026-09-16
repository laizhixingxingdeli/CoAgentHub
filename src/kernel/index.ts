/**
 * 纯领域 kernel 的公共入口。测试只从这里导入。
 *
 * 这一层只讲领域状态与流转：不 import 任何非相对路径模块，
 * 也不涉及任何运行时基础设施 / 外部服务概念（见 test/kernel-imports.test.ts）。
 */
export { KernelError, IllegalTransitionError, InvariantViolationError } from './errors.ts';

export { Attempt } from './attempt.ts';
export type {
  AttemptEndReason,
  AttemptKind,
  AttemptStatus,
  AttemptInit,
} from './attempt.ts';

export { EMPTY_USAGE, freezePayload } from './payloads.ts';
export type {
  BlockedRecord,
  EscalationBody,
  ContextRef,
  ContextRefKind,
  EvidenceKind,
  EvidenceRecord,
  ExecutionOutcome,
  FinalReview,
  ExecutionResultBody,
  MemoryDeltaProposal,
  MissionContract,
  MissionResultBody,
  OriginChannel,
  PlanBody,
  ReviewRecord,
  TokenUsage,
  UsedProfile,
  WaitReason,
  WorkOrder,
  WorkspaceRef,
} from './payloads.ts';

export { WorkItem } from './work-item.ts';
export type { WorkItemInit, WorkItemStatus, ReviewVerdict } from './work-item.ts';

export { Mission } from './mission.ts';
export type { MissionInit, MissionStatus } from './mission.ts';

export { Project } from './project.ts';
export type { ProjectInit } from './project.ts';
