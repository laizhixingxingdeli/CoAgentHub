import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGroupWs } from "@/hooks/use-group-ws";
import { useIsDesktop } from "@/hooks/use-mobile";
import { t } from "@/lib/i18n";
import { appendOutputTail } from "@/lib/output-buffer";
import TaskPanel, {
  type TaskItem,
  type TaskObservability,
  taskStatusLabel,
} from "@/pages/app/groups/messages/TaskPanel";
import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import { deriveBriefTitle, groupTasksBySpec } from "./group-tasks-by-spec";
import { mergeTaskStatusChanged } from "./merge-task-status";
import RequirementDetailPanel from "./RequirementDetailPanel";
import RequirementList from "./RequirementList";
import {
  countRequirementsByKind,
  filterRequirementsByKind,
  type RequirementKind,
  requirementKindOf,
} from "./requirement-kind";
import type { RequirementLayerState } from "./requirement-layer-state";
import { deriveRequirementLayerState } from "./requirement-layer-state";

/**
 * 需求工作区(共享组件,UI-04b-2):从原 TasksTab 抽取,供「群内页主区」与右栏
 * 「任务」Tab 两处复用 —— 现有任务面板(TaskPanel)逻辑整体保留:挂载时拉取
 * 一次 GET /groups/:id/tasks(不轮询);「停止」/「回滚」通过发一条 broadcast
 * 命令消息触发服务端 control.ts,发送后刷新列表。停止/回滚按钮与 TaskPanel
 * 展示完全不变。
 *
 * 实时进度(批次增强):订阅同组 WS task_output 事件,把执行器输出块追加进
 * 内存缓冲(liveOutputs);任务行展开时若缓冲为空(刷新/断线后)用
 * includeOutput=1 拉取当前 outputTail 兜底。回滚按钮:点击 → 轮询任务状态,
 * 直到 server 回传的 rollback 落库(diffSummary.error === "rollback")→ 提示
 * 「已恢复」。
 *
 * 权限(只读放开 enhancement):GET /tasks 不再要求成员身份(Local User 未
 * 绑定身份也能看列表);「停止/回滚」需要 coordinator/human 身份 —— 以
 * 是否已绑定身份判断,未绑定时按钮禁用并提示。
 *
 * 主从两栏:有需求时渲染「左需求列表 + 右详情」;左列宽度由
 * listClassName 控制(右栏任务 Tab 空间小取窄列,主区按设计稿取宽列),
 * 右列自适应占剩余空间。无需求时回退 TaskPanel 扁平任务列表。
 */
/** 后端陈旧提示文案:按 staleReason 给出具体动作(R3)。 */
function runtimeStaleMessage(
  reason: "process" | "build" | "both" | null,
): string {
  switch (reason) {
    case "build":
      return "后端构建落后于源码 —— 需重新 build 再重启,改动才会生效";
    case "both":
      return "源码已改且未重建,运行的也不是当前构建 —— 需 build 后重启";
    default:
      // process(或旧后端未上报 reason):重启后端即可,经典情形。
      return "后端运行的不是最新构建 —— 重启后端即可让改动生效";
  }
}

/** 停止确认文案的任务标识:任务名(deriveBriefTitle,与需求列表标题同源)
 *  存在时用「任务名(taskId 短号)」,否则退回「执行器名(taskId 短号)」——
 *  短号兜底保证同屏两条同需求任务仍可区分(ADR-0009 判据指名事实)。 */
export function stopTaskIdentifier(
  task: Pick<
    TaskItem,
    "id" | "brief" | "executorParticipantId" | "executorKey"
  >,
  members: ReadonlyArray<Pick<Member, "participantId" | "name">>,
): string {
  const shortId = task.id.length > 8 ? task.id.slice(0, 8) : task.id;
  const name = deriveBriefTitle(task.brief);
  const executor =
    members.find((m) => m.participantId === task.executorParticipantId)?.name ??
    task.executorKey ??
    "—";
  return name ? `${name}(${shortId})` : `${executor}(${shortId})`;
}

export function RequirementWorkspace({
  groupId,
  listClassName = "w-28 shrink-0",
}: {
  groupId: string;
  /** 左列需求列表的宽度 class(含是否可收缩);默认窄列(右栏任务 Tab)。 */
  listClassName?: string;
}) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandSending, setCommandSending] = useState<string | null>(null);
  // 展开的任务行(实时输出区 + attempt 时间线展示)。
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // 默认展开(运行中/已完成)但被用户手动折叠的任务行 id 集合。
  const [foldedTaskIds, setFoldedTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // 无进展提醒(WS task_stall_alert)的任务行 id 集合(黄色警示样式)。
  const [stallAlertedIds, setStallAlertedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // 实时输出缓冲:taskId → 已接收的 WS chunk 拼接;展开时优先用实时缓冲。
  const [liveOutputs, setLiveOutputs] = useState<Record<string, string>>({});
  // 回滚状态:taskId → "rolling"(已发送,等待恢复完成)| "done"(已恢复)。
  const [rollbackStates, setRollbackStates] = useState<
    Record<string, "rolling" | "done">
  >({});
  // 归档/软删群只读:群状态决定停止/回滚是否可用(即使有控制身份)。
  const [groupStatus, setGroupStatus] = useState<
    "active" | "archived" | "deleted" | null
  >(null);
  // 任务行内正文预览(前 40 字)与执行者名需要消息流与成员数据。
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  // Detail-only observability fields are loaded for the selected requirement;
  // the task list remains the lightweight source for the rest of the panel.
  const [taskObservability, setTaskObservability] = useState<
    Record<string, TaskObservability>
  >({});
  const loadedTaskDetailsRef = useRef(new Set<string>());
  const [runtimeStale, setRuntimeStale] = useState(false);
  const [runtimeStaleReason, setRuntimeStaleReason] = useState<
    "process" | "build" | "both" | null
  >(null);
  const [runtimeDismissed, setRuntimeDismissed] = useState(false);
  const runtimeWasStaleRef = useRef(false);

  // UI-04a:把扁平任务列表按 specRef 聚合成需求(Requirement)。分组结果随
  // tasks 变化重算;顺序由分组函数保证(最新需求在数组最后)。
  const { requirements, layerStates } = useMemo(() => {
    const states = new Map<string, RequirementLayerState>();
    const observedTasks = tasks.map((task) => ({
      ...task,
      ...(taskObservability[task.id] ?? {}),
    }));
    const grouped = groupTasksBySpec(observedTasks, members).map(
      (requirement) => {
        const layerState = deriveRequirementLayerState(
          requirement,
          messages,
          members,
        );
        states.set(requirement.id, layerState);
        return { ...requirement, steps: layerState.steps };
      },
    );
    return { requirements: grouped, layerStates: states };
  }, [tasks, taskObservability, messages, members]);
  // 「需求 / 修复」二态切换(requirement-list-kind-tabs R1):null dispatchKind
  // 按「需求」处理(R2);过滤只影响列表展示,不改分组数据本身。
  const [requirementKind, setRequirementKind] =
    useState<RequirementKind>("requirement");
  const visibleRequirements = useMemo(
    () => filterRequirementsByKind(requirements, requirementKind),
    [requirements, requirementKind],
  );
  // 两个标签的计数:与当前选中标签无关,空标签也保持可见可点(R3)。
  const kindCounts = useMemo(
    () => countRequirementsByKind(requirements),
    [requirements],
  );
  // 当前选中的需求 id:默认选中数组最后一个(最新需求);任务刷新导致当前选中项
  // 失效时回落到最新,仍保持「默认选中最新」的约定。
  const [selectedRequirementId, setSelectedRequirementId] = useState<
    string | null
  >(null);
  const selectionInitializedRef = useRef(false);
  useEffect(() => {
    // An initially empty list may receive its first task over WS, so only mark
    // the default selection as initialized once there is a requirement.
    if (requirements.length === 0) {
      if (selectionInitializedRef.current) {
        setSelectedRequirementId(null);
      }
      return;
    }
    setSelectedRequirementId((prev) => {
      if (prev !== null && requirements.some((r) => r.id === prev)) {
        return prev;
      }
      if (!selectionInitializedRef.current) {
        selectionInitializedRef.current = true;
        // 初始默认选中当前标签下最新的一条(初始标签为「需求」):避免初始选中
        // 落在另一标签(隐藏)的项上,造成「列表无高亮、详情却是另一条」。
        for (let i = requirements.length - 1; i >= 0; i--) {
          if (requirementKindOf(requirements[i]) === requirementKind) {
            return requirements[i].id;
          }
        }
        return null;
      }
      // A selected requirement disappearing must not move the user to another
      // row while the task collection is being refreshed.
      return null;
    });
    // requirementKind 也参与:切标签后该 effect 重跑,但 selectionInitializedRef
    // 一旦置位就不再自动跳选,「回落未选中」由 handleKindChange 决定。
  }, [requirements, requirementKind]);

  // 响应式断点:复用项目既有 useIsDesktop(lg ≥1024px)约定。窄视口(<1024px)
  // 放不下「需求列表 | 详情」两栏 → 单栏:列表 / 详情二选一,点击行进详情,
  // 返回键回列表(requirement-pane-responsive R1)。
  const isDesktop = useIsDesktop();
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");

  const loadGroupStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}`);
      if (res.ok) {
        const group = (await res.json()) as { status: string };
        setGroupStatus(
          group.status === "active" || group.status === "archived"
            ? group.status
            : "deleted",
        );
      }
    } catch {
      // 群状态加载失败按 active 处理,不误伤任务列表只读展示。
    }
  }, [groupId]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/tasks`);
      if (!res.ok) {
        // 只读放开后 403 不再是预期状态(仅群不存在 404);统一按失败处理,
        // 不再把 403 当整面板「无权限」错误态。
        setError(`加载任务失败: HTTP ${res.status}`);
        return;
      }
      setTasks((await res.json()) as TaskItem[]);
    } catch (e) {
      setError(`加载任务失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}/messages`);
      if (res.ok) {
        setMessages(await res.json());
      }
    } catch {
      // 预览数据缺失不影响任务行渲染。
    }
  }, [groupId]);

  const loadMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}/members`);
      if (res.ok) {
        setMembers(await res.json());
      }
    } catch {
      // 执行者名缺失时 TaskPanel 回退到 executorKey。
    }
  }, [groupId]);

  const loadRuntimeStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) return;
      const status = (await res.json()) as {
        stale?: unknown;
        staleReason?: unknown;
      };
      if (typeof status.stale !== "boolean") return;
      if (status.stale && !runtimeWasStaleRef.current) {
        setRuntimeDismissed(false);
      }
      runtimeWasStaleRef.current = status.stale;
      setRuntimeStale(status.stale);
      setRuntimeStaleReason(
        status.staleReason === "process" ||
          status.staleReason === "build" ||
          status.staleReason === "both"
          ? status.staleReason
          : null,
      );
    } catch {
      // Health is advisory; a failed probe must not add a persistent error row.
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    void loadMessages();
    void loadMembers();
    void loadGroupStatus();
  }, [loadTasks, loadMessages, loadMembers, loadGroupStatus]);

  useEffect(() => {
    void loadRuntimeStatus();
    const timer = setInterval(() => void loadRuntimeStatus(), 30_000);
    return () => clearInterval(timer);
  }, [loadRuntimeStatus]);

  // 实时进度:同组 WS task_output 事件 → 追加进 liveOutputs(有界缓冲,
  // 与后端 output-buffer.ts 同款上限:1000 行 / 256KB,超限保留尾部);
  // 无进展提醒:task_stall_alert 事件 → 该任务行标记黄色警示(非失败)。
  useGroupWs(groupId, (event) => {
    if (event.type === "task_status_changed") {
      setTasks((prev) => mergeTaskStatusChanged(prev, event));
      return;
    }
    if (event.type === "task_output") {
      setLiveOutputs((prev) => ({
        ...prev,
        [event.taskId]: appendOutputTail(prev[event.taskId] ?? "", event.chunk),
      }));
      return;
    }
    if (event.type === "task_stall_alert") {
      setStallAlertedIds((prev) => {
        if (prev.has(event.taskId)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(event.taskId);
        return next;
      });
    }
  });

  /** 展开/折叠任务行:running/done/failed 默认展开(可折叠),点击切换折叠态;
   *  queued/cancelled 仅显式展开时可见。展开时实时缓冲为空(刷新/断线后)
   *  用 includeOutput=1 拉当前缓冲兜底。 */
  const toggleExpand = useCallback(
    async (task: TaskItem) => {
      if (
        task.status === "running" ||
        task.status === "done" ||
        task.status === "failed"
      ) {
        // 默认展开行:点击只切换折叠态;从折叠恢复展开且缓冲为空 → includeOutput 兜底。
        const wasFolded = foldedTaskIds.has(task.id);
        setFoldedTaskIds((prev) => {
          const next = new Set(prev);
          if (next.has(task.id)) {
            next.delete(task.id);
          } else {
            next.add(task.id);
          }
          return next;
        });
        if (wasFolded && liveOutputs[task.id] === undefined) {
          try {
            const res = await fetch(
              `/api/groups/${groupId}/tasks?includeOutput=1`,
            );
            if (!res.ok) {
              return;
            }
            const rows = (await res.json()) as TaskItem[];
            const seeded = rows.find((r) => r.id === task.id)?.outputTail;
            if (seeded) {
              setLiveOutputs((prev) =>
                prev[task.id] !== undefined
                  ? prev
                  : { ...prev, [task.id]: seeded },
              );
            }
          } catch {
            // 拉取失败不阻塞展开(WS 恢复后仍会流式追加)。
          }
        }
        return;
      }
      const next = expandedTaskId === task.id ? null : task.id;
      setExpandedTaskId(next);
      if (next === null) {
        return;
      }
      if (liveOutputs[next] !== undefined) {
        return;
      }
      try {
        const res = await fetch(`/api/groups/${groupId}/tasks?includeOutput=1`);
        if (!res.ok) {
          return;
        }
        const rows = (await res.json()) as TaskItem[];
        const seeded = rows.find((r) => r.id === next)?.outputTail;
        if (seeded) {
          setLiveOutputs((prev) =>
            prev[next] !== undefined ? prev : { ...prev, [next]: seeded },
          );
        }
      } catch {
        // 拉取失败不阻塞展开(WS 恢复后仍会流式追加)。
      }
    },
    [expandedTaskId, foldedTaskIds, groupId, liveOutputs],
  );

  // Local User is the browser's server-side human identity. The backend remains
  // the authority for group membership and control permissions.
  const canControl = true;
  // 归档/软删群只读:群状态非 active 时,控制按钮仍禁用。
  const readOnly = groupStatus !== null && groupStatus !== "active";

  /** 停止/回滚 = 发一条 broadcast 命令消息(与手动输入等效,服务端 control.ts
   * 识别);发送后刷新任务列表。403 → 无权限提示。 */
  const sendCommand = async (task: TaskItem, commandBody: string) => {
    if (commandSending) {
      return;
    }
    setCommandSending(task.id);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: commandBody, audience: "broadcast" }),
      });
      if (!res.ok) {
        setError(
          res.status === 403
            ? "无权限,请确认当前 Local User 是群成员"
            : `命令发送失败: HTTP ${res.status}`,
        );
        return;
      }
      await loadTasks();
    } catch (e) {
      setError(`命令发送失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCommandSending(null);
    }
  };

  /** 停止(二次确认,stop-button-needs-confirmation R1/R2):与仓内其余 6 处
   * 破坏性操作同形态 —— window.confirm(t(...)),不引入自定义弹窗。取消则
   * 不发消息、不刷新、不置 commandSending(直接 return)。文案指名任务标识
   * (任务名 + id 短号)、当前状态与后果(R3;ADR-0009 判据指名事实):
   * 排队中 → 取消不再执行;运行中 → 终止进程,已产出改动不会自动回滚。
   * 确认判断收在这一处,回滚下一票直接复用同款(见 spec §4 实现提示)。 */
  const handleStop = (task: TaskItem) => {
    const consequence =
      task.status === "queued"
        ? t("tasks.confirm.stopQueued")
        : t("tasks.confirm.stopRunning");
    if (
      !window.confirm(
        t("tasks.confirm.stop", {
          task: stopTaskIdentifier(task, members),
          status: taskStatusLabel(task.status),
          consequence,
        }),
      )
    ) {
      return;
    }
    void sendCommand(task, `停止 ${task.id}`);
  };

  /** 回滚:发送「回滚 <taskId>」后轮询任务状态,直到 server 落库
   * diffSummary.error === "rollback"(恢复完成)→ 置 done(「已恢复」)。
   * 超时(30s)未确认 → 仍提示「已恢复」(指令已发送,checkpoint 恢复完成),
   * 由控制消息回传兜底,不无限轮询。 */
  const handleRollback = async (task: TaskItem) => {
    if (commandSending || rollbackStates[task.id] === "rolling") {
      return;
    }
    setRollbackStates((prev) => ({ ...prev, [task.id]: "rolling" }));
    await sendCommand(task, `回滚 ${task.id}`);
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      try {
        const res = await fetch(`/api/groups/${groupId}/tasks`);
        if (res.ok) {
          const rows = (await res.json()) as TaskItem[];
          const updated = rows.find((r) => r.id === task.id);
          if (
            updated?.diffSummary &&
            typeof updated.diffSummary === "object" &&
            (updated.diffSummary as Record<string, unknown>).error ===
              "rollback"
          ) {
            setRollbackStates((prev) => ({ ...prev, [task.id]: "done" }));
            setTasks(rows);
            return;
          }
        }
      } catch {
        // 轮询失败继续重试,直到超时。
      }
      if (Date.now() < deadline) {
        pollTimer.current = setTimeout(poll, 1000);
      } else {
        // 超时兜底:指令已发送,checkpoint 恢复完成(回传消息可见)。
        setRollbackStates((prev) => ({ ...prev, [task.id]: "done" }));
      }
    };
    poll();
  };
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
      }
    };
  }, []);

  // 当前选中的需求(用于右栏详情);选中项失效时回落到 null → 详情空态。
  const selectedRequirement =
    requirements.find((r) => r.id === selectedRequirementId) ?? null;

  const selectedTaskIds =
    selectedRequirement?.tasks.map((task) => task.id).join(",") ?? "";
  useEffect(() => {
    if (!selectedRequirement || !selectedTaskIds) return;
    const taskRows = selectedRequirement.tasks.filter(
      (task) => !loadedTaskDetailsRef.current.has(task.id),
    );
    if (taskRows.length === 0) return;
    let cancelled = false;
    const loadDetails = async () => {
      const results = await Promise.all(
        taskRows.map(async (task) => {
          try {
            const res = await fetch(`/api/groups/${groupId}/tasks/${task.id}`);
            loadedTaskDetailsRef.current.add(task.id);
            if (!res.ok) return null;
            const detail = (await res.json()) as TaskItem;
            const observability: TaskObservability = {};
            if (detail.l1) observability.l1 = detail.l1;
            if (detail.l3) observability.l3 = detail.l3;
            if (detail.liveness) observability.liveness = detail.liveness;
            if (detail.runtime) observability.runtime = detail.runtime;
            return { id: task.id, observability };
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const next = results.reduce<Record<string, TaskObservability>>(
        (accumulator, result) => {
          if (result) accumulator[result.id] = result.observability;
          return accumulator;
        },
        {},
      );
      if (Object.keys(next).length > 0) {
        setTaskObservability((previous) => ({ ...previous, ...next }));
      }
    };
    void loadDetails();
    return () => {
      cancelled = true;
    };
  }, [groupId, selectedRequirement, selectedTaskIds]);

  /** 切换「需求 / 修复」标签:原选中若不在新标签列表,回落为未选中,
   *  不自动挑一条(requirement-list-kind-tabs R5,同 live-refresh R3 原则)。 */
  const handleKindChange = (kind: RequirementKind) => {
    setRequirementKind(kind);
    setSelectedRequirementId((prev) => {
      if (prev === null) {
        return null;
      }
      const stillVisible = requirements.some(
        (r) => r.id === prev && requirementKindOf(r) === kind,
      );
      return stillVisible ? prev : null;
    });
  };

  /** 选择需求:桌面两栏仅切换选中;窄视口单栏同时切到详情页(R1 切换行为)。 */
  const handleSelectRequirement = (id: string | null) => {
    setSelectedRequirementId(id);
    if (id !== null && !isDesktop) {
      setMobilePane("detail");
    }
  };

  // 详情区块:桌面两栏右列与窄视口详情页共用,避免重复。
  const detailPane = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RequirementDetailPanel
          requirement={selectedRequirement}
          layerState={
            selectedRequirement
              ? (layerStates.get(selectedRequirement.id) ?? null)
              : null
          }
          messages={messages}
          members={members}
          liveOutputs={liveOutputs}
          canControl={canControl}
          readOnly={readOnly}
          commandSending={commandSending}
          rollbackStates={rollbackStates}
          onStop={handleStop}
          onRollback={(task) => void handleRollback(task)}
        />
      </div>
    </>
  );

  return (
    <div
      data-testid="requirement-workspace"
      className="flex min-h-0 flex-1 flex-col"
    >
      {runtimeStale && !runtimeDismissed && (
        <div
          data-testid="runtime-stale-banner"
          role="status"
          className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-md border border-status-unconfirmed/50 bg-status-unconfirmed/10 px-3 py-2 text-sm text-status-unconfirmed"
        >
          <span className="min-w-0 flex-1">
            {runtimeStaleMessage(runtimeStaleReason)}
          </span>
          <button
            type="button"
            aria-label="关闭后端状态提示"
            onClick={() => setRuntimeDismissed(true)}
            className="shrink-0 rounded px-1.5 py-0.5 text-base leading-none hover:bg-status-unconfirmed/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ×
          </button>
        </div>
      )}
      {requirements.length === 0 ? (
        // 没有任何按 specRef 分组的需求:回退到原始任务列表(TaskPanel),
        // 保留完整能力(停止/回滚/实时输出/执行历史 + 无进展提醒)。
        <TaskPanel
          tasks={tasks}
          loading={loading}
          error={error}
          commandSending={commandSending}
          canControl={canControl}
          readOnly={readOnly}
          messages={messages}
          members={members}
          expandedTaskId={expandedTaskId}
          foldedTaskIds={foldedTaskIds}
          stallAlertedIds={stallAlertedIds}
          liveOutputs={liveOutputs}
          rollbackStates={rollbackStates}
          onToggleExpand={(task) => void toggleExpand(task)}
          onStop={handleStop}
          onRollback={(task) => void handleRollback(task)}
        />
      ) : isDesktop ? (
        // 桌面(lg ≥1024px)两栏:左列表(master) + 右详情(detail)。
        // 左列宽度由 listClassName 控制(右栏任务 Tab 取窄列,主区取宽列),
        // 右列自适应占剩余空间(R2:左栏设 min/max,详情区有最小宽度)。
        <div className="flex min-h-0 flex-1 gap-2">
          {/* 左栏:需求列表。多需求时可独立滚动。 */}
          <div className={`${listClassName} overflow-y-auto border-r`}>
            <RequirementList
              visibleRequirements={visibleRequirements}
              kindCounts={kindCounts}
              kind={requirementKind}
              onKindChange={handleKindChange}
              selectedId={selectedRequirementId}
              onSelect={handleSelectRequirement}
            />
          </div>
          {/* 右栏:详情(阶梯 + 时间线)。R2:详情区有最小宽度,
              窄到低于该值时按断点退化为单栏(见上方 isDesktop)。 */}
          <div className="flex min-w-64 flex-1 flex-col">{detailPane}</div>
        </div>
      ) : mobilePane === "list" ? (
        // 窄视口(<1024px)单栏:只显示需求列表,点击行进详情。
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RequirementList
            visibleRequirements={visibleRequirements}
            kindCounts={kindCounts}
            kind={requirementKind}
            onKindChange={handleKindChange}
            selectedId={selectedRequirementId}
            onSelect={handleSelectRequirement}
          />
        </div>
      ) : (
        // 窄视口(<1024px)单栏:只显示选中需求详情(控制条 + 详情),返回键回列表。
        <div className="flex min-h-0 flex-1 flex-col">
          <button
            type="button"
            data-testid="requirement-mobile-back"
            onClick={() => setMobilePane("list")}
            className="flex shrink-0 items-center gap-1 border-b px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {t("messages.backToList")}
          </button>
          {detailPane}
        </div>
      )}
    </div>
  );
}
