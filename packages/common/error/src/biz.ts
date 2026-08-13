/** Error codes the CoAgentHub API actually emits. */
export const BizCodeEnum = {
  InvalidRequest: "INVALID_REQUEST",
  Unauthorized: "UNAUTHORIZED",
  Forbidden: "FORBIDDEN",
  Conflict: "CONFLICT",
  MessageNotFound: "MESSAGE_NOT_FOUND",
  ParticipantNotFound: "PARTICIPANT_NOT_FOUND",
  GroupNotFound: "GROUP_NOT_FOUND",
  MemberNotFound: "MEMBER_NOT_FOUND",
  TaskNotFound: "TASK_NOT_FOUND",
  ExecutorNotFound: "EXECUTOR_NOT_FOUND",
} as const;

export type BizCode = (typeof BizCodeEnum)[keyof typeof BizCodeEnum];

const STATUS_AND_MESSAGE: Record<BizCode, [status: number, fallback: string]> =
  {
    [BizCodeEnum.InvalidRequest]: [400, "Invalid request"],
    [BizCodeEnum.Unauthorized]: [401, "Unauthorized"],
    [BizCodeEnum.Forbidden]: [403, "Forbidden"],
    [BizCodeEnum.Conflict]: [409, "Conflict"],
    [BizCodeEnum.MessageNotFound]: [404, "Message not found"],
    [BizCodeEnum.ParticipantNotFound]: [404, "Participant not found"],
    [BizCodeEnum.GroupNotFound]: [404, "Group not found"],
    [BizCodeEnum.MemberNotFound]: [404, "Member not found"],
    [BizCodeEnum.TaskNotFound]: [404, "Task not found"],
    [BizCodeEnum.ExecutorNotFound]: [404, "Executor config not found"],
  };

/** An API error carrying a stable machine-readable code plus an HTTP status. */
export default class BizError extends Error {
  readonly code: BizCode;
  readonly statusCode: number;

  constructor(code: BizCode, customMessage?: string) {
    const [status, fallback] = STATUS_AND_MESSAGE[code];
    super(customMessage ?? fallback);
    this.name = "BizError";
    this.code = code;
    this.statusCode = status;
  }
}
