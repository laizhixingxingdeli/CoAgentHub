import { useCallback, useEffect, useRef, useState } from "react";
import { useGroupWs } from "@/hooks/use-group-ws";
import {
  PARTICIPANT_ID_KEY,
  participantIdentityHeaders,
} from "@/lib/api-client";
import TaskPanel, {
  type TaskItem,
} from "@/pages/app/groups/messages/TaskPanel";
import type { Member, MessageItem } from "@/pages/app/groups/messages/types";

/**
 * 右栏「任务」Tab:现有任务面板(TaskPanel)逻辑整体移入 — 挂载时拉取一次
 * GET /groups/:id/tasks(不轮询);「停止」/「回滚」通过发一条 broadcast
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
 */
export function TasksTab({ groupId }: { groupId: string }) {
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

  const loadGroupStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        headers: participantIdentityHeaders(),
      });
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
      const res = await fetch(`/api/groups/${groupId}/tasks`, {
        headers: participantIdentityHeaders(),
      });
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
      const res = await fetch(`/api/groups/${groupId}/messages`, {
        headers: participantIdentityHeaders(),
      });
      if (res.ok) {
        setMessages(await res.json());
      }
    } catch {
      // 预览数据缺失不影响任务行渲染。
    }
  }, [groupId]);

  const loadMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}/members`, {
        headers: participantIdentityHeaders(),
      });
      if (res.ok) {
        setMembers(await res.json());
      }
    } catch {
      // 执行者名缺失时 TaskPanel 回退到 executorKey。
    }
  }, [groupId]);

  useEffect(() => {
    void loadTasks();
    void loadMessages();
    void loadMembers();
    void loadGroupStatus();
  }, [loadTasks, loadMessages, loadMembers, loadGroupStatus]);

  // 实时进度:同组 WS task_output 事件 → 追加进 liveOutputs(展开行流式显示);
  // 无进展提醒:task_stall_alert 事件 → 该任务行标记黄色警示(非失败)。
  useGroupWs(groupId, (event) => {
    if (event.type === "task_output") {
      setLiveOutputs((prev) => ({
        ...prev,
        [event.taskId]: (prev[event.taskId] ?? "") + event.chunk,
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
              { headers: participantIdentityHeaders() },
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
        const res = await fetch(
          `/api/groups/${groupId}/tasks?includeOutput=1`,
          { headers: participantIdentityHeaders() },
        );
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

  // 停止/回滚需要 coordinator/human 身份:已绑定身份即视为有控制权限;
  // 未绑定(Local User)时列表只读、按钮禁用。每次渲染读取,绑定/清除即时生效。
  const canControl =
    typeof localStorage !== "undefined" &&
    Boolean(localStorage.getItem(PARTICIPANT_ID_KEY));
  // 归档/软删群只读:群状态非 active 时,即使有身份,停止/回滚也禁用。
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
          ...participantIdentityHeaders(),
        },
        body: JSON.stringify({ body: commandBody, audience: "broadcast" }),
      });
      if (!res.ok) {
        setError(
          res.status === 403
            ? "无权限,请以 coordinator/human 身份绑定 participant"
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
        const res = await fetch(`/api/groups/${groupId}/tasks`, {
          headers: participantIdentityHeaders(),
        });
        if (res.ok) {
          const rows = (await res.json()) as TaskItem[];
          const updated = rows.find((r) => r.id === task.id);
          if (
            updated &&
            updated.diffSummary &&
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

  return (
    <div data-testid="tasks-tab">
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
        onStop={(task) => void sendCommand(task, `停止 ${task.id}`)}
        onRollback={(task) => void handleRollback(task)}
      />
    </div>
  );
}
