/**
 * 需求时间线合并(UI-04b-1 升级):把一条需求下的「任务汇报」(TaskItem[])与
 * 群里的「消息」(MessageItem[])合并成一条按时间正序的事件流,供
 * RequirementTimeline 渲染。本文件只做「归属 + 排序」,不做任何展示布局;
 * 角色/配色等渲染关注点仍由 RequirementTimeline 自己决定。
 *
 * ⚠️ 消息 → 需求归属是启发式,不是权威关联:
 *  任务有 specRef,消息没有。前端能拿到的可靠信号只有任务与消息的因果:
 *  - 第一档(强关联):任务的触发消息 —— task.messageId 是服务端在「消息触发
 *    任务」时写入的该消息 id(任务书/指令消息),message.id 命中任一
 *    task.messageId 即视为本需求的会话起点;再加上它的回复子树(消息
 *    parentId 链最终可达某条触发消息)。这两类消息与需求的任务存在直接
 *    因果/会话关系,归属基本可靠。
 *  - 第二档(时间窗口,启发式):落在需求活跃窗口 [最早任务 createdAt, 最新
 *    任务 updatedAt ?? createdAt] 内的其余消息(协调者/检视者围绕该需求
 *    的旁路讨论往往不是任务书消息的回复,也没有 specRef 可对齐,只能用
 *    时间窗兜底)。⚠️ 已知局限:多条需求在同一时间窗内并行推进时,别的
 *    需求的广播/闲聊消息可能被误归到本需求 —— 后端消息表没有 specRef,
 *    前端无法消歧;本票范围不改后端加字段。
 *  不满足以上两档的消息不显示(宁缺毋滥,不把无关对话混进需求时间线)。
 */

import {
  type CoordinationPayload,
  parseKnownCoordinationPayload,
} from "@laizhixingxingdeli/database/schema";
import type {
  TaskItem,
  TaskStatus,
} from "@/pages/app/groups/messages/TaskPanel";
import {
  DELETED_MESSAGE_BODY,
  type Member,
  type MessageItem,
} from "@/pages/app/groups/messages/types";

/** 消息的定向对象(broadcast 消息无定向对象 → null)。 */
export type TimelineTarget = {
  audience: "participant" | "role";
  /** participant:成员名;role:角色名(audienceRef 原样)。 */
  name: string;
};

/** 合并流里的一条事件:消息卡片或任务汇报卡片。 */
export type TimelineEvent =
  | {
      kind: "message";
      message: MessageItem;
      /** senderId 未匹配到群成员时为 null(渲染层回落 senderId 前缀)。 */
      sender: Member | null;
      target: TimelineTarget | null;
      softDeleted: boolean;
      /** 纯 task_status 隐藏后挂回触发消息的状态标记。 */
      taskStatus: { status: TaskStatus; retries: number } | null;
      /** 消息发生时间。 */
      timestamp: string;
    }
  | {
      kind: "task";
      task: TaskItem;
      /** 汇报落库时刻(updatedAt),缺失回退 createdAt —— 与现有卡片一致。 */
      timestamp: string;
    };

export type RequirementTimelineLayer = "l1" | "l2" | "l3";

function isSkillSystemMessage(message: MessageItem): boolean {
  return (
    /skill/i.test(message.body) &&
    /(请先.*安装|先安装|已安装|install)/i.test(message.body)
  );
}

function isPureTaskStatus(message: MessageItem): boolean {
  return (
    message.contentType === "task_status" &&
    /^(?:🚀|📋|↻|🛑|⚠️)/u.test(message.body.trim())
  );
}

function coordinationPayload(body: string): CoordinationPayload | null {
  try {
    return parseKnownCoordinationPayload(body.trim()) ?? null;
  } catch {
    return null;
  }
}

/** Known coordination records can arrive after the task's active window. */
function isRequirementCoordinationMessage(
  message: MessageItem,
  taskIds: ReadonlySet<string>,
  specRefs: ReadonlySet<string>,
): boolean {
  const payload = coordinationPayload(message.body);
  if (!payload) return false;
  if (payload.type === "review_result" || payload.type === "review_request") {
    return taskIds.has(payload.taskId);
  }
  return specRefs.has(payload.specRef);
}

/** 发送者角色 → 层(R1):reviewer/human → L3,coordinator → L2,executor → L1。
 * 角色不在四档内(observer/specialist 等)或发送者未知 → null(由调用方回落形态判据)。 */
function layerForSenderRoles(
  roles: string[] | undefined,
): RequirementTimelineLayer | null {
  if (!roles) return null;
  const lower = roles.map((r) => r.toLowerCase());
  if (lower.includes("reviewer")) return "l3";
  if (lower.includes("coordinator")) return "l2";
  if (lower.includes("executor")) return "l1";
  if (lower.includes("human")) return "l3";
  return null;
}

export function timelineLayerForEvent(
  event: TimelineEvent,
  executionTaskIds: ReadonlySet<string>,
  coordinationTaskId: string | null,
): RequirementTimelineLayer {
  if (event.kind === "task") {
    if (executionTaskIds.has(event.task.id)) return "l1";
    if (event.task.id === coordinationTaskId) return "l2";
    return "l1";
  }

  // 主判据是发送者在本群的角色(R1),不再按消息形态分层。
  const roleLayer = layerForSenderRoles(event.sender?.roles);
  if (roleLayer) return roleLayer;

  // 兜底(R2/R3):发送者角色查不到(已退群/历史数据/observer 等)→ 回落形态判据。
  const payload = coordinationPayload(event.message.body);
  if (
    payload?.type === "review_result" ||
    payload?.type === "spec_amended" ||
    payload?.type === "spec_published"
  ) {
    return "l3";
  }
  if (payload?.type === "review_request") return "l2";
  return "l1";
}

export function partitionRequirementTimeline(
  events: TimelineEvent[],
  executionTaskIds: ReadonlySet<string>,
  coordinationTaskId: string | null,
): Record<RequirementTimelineLayer, TimelineEvent[]> {
  const layers: Record<RequirementTimelineLayer, TimelineEvent[]> = {
    l1: [],
    l2: [],
    l3: [],
  };
  for (const event of events) {
    layers[
      timelineLayerForEvent(event, executionTaskIds, coordinationTaskId)
    ].push(event);
  }
  return layers;
}

/** 解析消息的定向对象(broadcast / 无 audienceRef → null)。 */
function resolveTarget(
  message: MessageItem,
  memberById: Map<string, Member>,
): TimelineTarget | null {
  if (message.audience === "broadcast" || !message.audienceRef) {
    return null;
  }
  if (message.audience === "role") {
    return { audience: "role", name: message.audienceRef };
  }
  const member = memberById.get(message.audienceRef);
  return {
    audience: "participant",
    name: member?.name ?? message.audienceRef.slice(0, 8),
  };
}

/**
 * 把一条需求的 tasks 与群的 messages/members 合并成按时间正序的事件流。
 * @param tasks 该需求下的所有任务(顺序不限,函数内部按时间排序)。
 * @param messages 该群全部消息(只取归属到本需求的部分,见文件头注释)。
 * @param members 该群成员(用于解析发送者/定向对象;缺成员时回落 id 前缀)。
 */
export function mergeRequirementTimeline(
  tasks: TaskItem[],
  messages: MessageItem[],
  members: Member[],
): TimelineEvent[] {
  if (tasks.length === 0) {
    return [];
  }

  const memberById = new Map(members.map((m) => [m.participantId, m]));
  const messageById = new Map(messages.map((m) => [m.id, m]));
  const taskByMessageId = new Map(tasks.map((task) => [task.messageId, task]));
  const taskIds = new Set(tasks.map((task) => task.id));
  const specRefs = new Set(
    tasks
      .map((task) => task.specRef)
      .filter((ref): ref is string => Boolean(ref)),
  );

  // 第一档:本需求任务的触发消息 id 集合(任务书/指令消息)。
  const triggerIds = new Set(
    tasks.map((t) => t.messageId).filter((id): id is string => Boolean(id)),
  );
  // 回复子树扩散:parentId 链最终可达某条触发消息 → 属于同一会话。
  // 逐条向上走 parentId(带 visited 防环),命中触发消息即归属。
  const linkedIds = new Set<string>();
  for (const message of messages) {
    if (isSkillSystemMessage(message) || isPureTaskStatus(message)) {
      continue;
    }
    let cursor: string | null = message.parentId;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      if (triggerIds.has(cursor)) {
        linkedIds.add(message.id);
        break;
      }
      cursor = messageById.get(cursor)?.parentId ?? null;
    }
  }

  // 第二档(启发式):需求活跃窗口 [最早任务 createdAt, 最新任务
  // updatedAt ?? createdAt]。落在窗口内且未被第一档归走的消息一并并入。
  const createdTimes = tasks.map((t) => Date.parse(t.createdAt));
  const windowStart = Math.min(...createdTimes);
  const windowEnd = Math.max(
    ...tasks.map((t) => Date.parse(t.updatedAt ?? t.createdAt)),
  );

  const events: TimelineEvent[] = [];
  for (const task of tasks) {
    events.push({
      kind: "task",
      task,
      timestamp: task.updatedAt ?? task.createdAt,
    });
  }
  for (const message of messages) {
    if (isSkillSystemMessage(message) || isPureTaskStatus(message)) {
      continue;
    }
    const linked = linkedIds.has(message.id) || triggerIds.has(message.id);
    const coordination = isRequirementCoordinationMessage(
      message,
      taskIds,
      specRefs,
    );
    const inWindow =
      !linked &&
      Date.parse(message.createdAt) >= windowStart &&
      Date.parse(message.createdAt) <= windowEnd;
    if (!linked && !inWindow && !coordination) {
      continue;
    }
    events.push({
      kind: "message",
      message,
      sender: memberById.get(message.senderId) ?? null,
      target: resolveTarget(message, memberById),
      softDeleted:
        message.deleted === true || message.body === DELETED_MESSAGE_BODY,
      taskStatus: (() => {
        const task = taskByMessageId.get(message.id);
        if (!task) return null;
        const retries =
          typeof task.diffSummary?.retries === "number"
            ? task.diffSummary.retries
            : 0;
        return { status: task.status, retries };
      })(),
      timestamp: message.createdAt,
    });
  }

  // 按时间正序;同一时刻的稳定排序(保持上面的插入顺序:任务先于消息)。
  events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return events;
}
