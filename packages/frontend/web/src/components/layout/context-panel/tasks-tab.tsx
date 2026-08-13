import { useCallback, useEffect, useState } from "react";
import {
  PARTICIPANT_TOKEN_KEY,
  participantAuthHeaders,
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
 * 权限(只读放开 enhancement):GET /tasks 不再要求成员身份(Local User 未
 * 绑定 token 也能看列表);「停止/回滚」需要 coordinator/human 身份 —— 以
 * 是否已绑定 token 判断,未绑定时按钮禁用并提示。
 */
export function TasksTab({ groupId }: { groupId: string }) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandSending, setCommandSending] = useState<string | null>(null);
  // 任务行内正文预览(前 40 字)与执行者名需要消息流与成员数据。
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/tasks`, {
        headers: participantAuthHeaders(),
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
        headers: participantAuthHeaders(),
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
        headers: participantAuthHeaders(),
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
  }, [loadTasks, loadMessages, loadMembers]);

  // 停止/回滚需要 coordinator/human 身份:已绑定 token 即视为有控制权限;
  // 未绑定(Local User)时列表只读、按钮禁用。每次渲染读取,绑定/清除即时生效。
  const canControl =
    typeof localStorage !== "undefined" &&
    Boolean(localStorage.getItem(PARTICIPANT_TOKEN_KEY));

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
          ...participantAuthHeaders(),
        },
        body: JSON.stringify({ body: commandBody, audience: "broadcast" }),
      });
      if (!res.ok) {
        setError(
          res.status === 403
            ? "无权限,请以 coordinator/human 身份绑定 token"
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

  return (
    <div data-testid="tasks-tab">
      <TaskPanel
        tasks={tasks}
        loading={loading}
        error={error}
        commandSending={commandSending}
        canControl={canControl}
        messages={messages}
        members={members}
        onStop={(task) => void sendCommand(task, `停止 ${task.id}`)}
        onRollback={(task) => void sendCommand(task, `回滚 ${task.id}`)}
      />
    </div>
  );
}
