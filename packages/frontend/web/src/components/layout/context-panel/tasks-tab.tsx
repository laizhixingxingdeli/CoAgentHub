import { useCallback, useEffect, useState } from "react";
import {
  type Member,
  type MessageItem,
} from "@/pages/app/groups/messages/types";
import TaskPanel, { type TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import { agentAuthHeaders } from "@/lib/api-client";

/**
 * 右栏「任务」Tab:现有任务面板(TaskPanel)逻辑整体移入 — 挂载时拉取一次
 * GET /groups/:id/tasks(不轮询);「停止」/「回滚」通过发一条 broadcast
 * 命令消息触发服务端 control.ts,发送后刷新列表。停止/回滚按钮与 TaskPanel
 * 展示完全不变。
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
        headers: agentAuthHeaders(),
      });
      if (!res.ok) {
        setError(
          res.status === 403
            ? "无权限,请以 coordinator/human 身份绑定 token"
            : `加载任务失败: HTTP ${res.status}`,
        );
        return;
      }
      setTasks((await res.json()) as TaskItem[]);
    } catch (e) {
      setError(
        `加载任务失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void loadTasks();
    void loadMessages();
    void loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTasks, groupId]);

  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}/messages`, {
        headers: agentAuthHeaders(),
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
        headers: agentAuthHeaders(),
      });
      if (res.ok) {
        setMembers(await res.json());
      }
    } catch {
      // 执行者名缺失时 TaskPanel 回退到 executorKey。
    }
  }, [groupId]);

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
        headers: { "Content-Type": "application/json", ...agentAuthHeaders() },
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
      setError(
        `命令发送失败: ${e instanceof Error ? e.message : String(e)}`,
      );
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
        messages={messages}
        members={members}
        onStop={(task) => void sendCommand(task, `停止 ${task.id}`)}
        onRollback={(task) => void sendCommand(task, `回滚 ${task.id}`)}
      />
    </div>
  );
}
