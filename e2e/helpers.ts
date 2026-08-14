/**
 * E2E API helpers — 用 Playwright 的 request fixture 直接调 server(经 web 反代
 * 同源 /api),为浏览器用例准备数据:注册 participant、建群、发消息、注入任务。
 *
 * 隔离原则:每个用例用唯一名称(uniqueName),run 间数据由 globalSetup 清场,
 * 用例间互不依赖、互不污染。
 */
import type { APIRequestContext, Page } from "@playwright/test";

export function uniqueName(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export type ApiParticipant = {
  id: string;
  name: string;
  device: string | null;
};

export type ApiGroup = {
  id: string;
  title: string;
  status: "active" | "archived" | "deleted";
};

export type ApiMessage = {
  id: string;
  groupId: string;
  senderId: string;
  body: string;
  parentId: string | null;
  depth: number;
};

export type ApiTask = {
  id: string;
  groupId: string;
  messageId: string;
  executorParticipantId: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
};

export async function registerParticipant(
  request: APIRequestContext,
  name: string,
  device = "e2e",
): Promise<ApiParticipant> {
  const res = await request.post("/api/participants", {
    data: { name, device },
  });
  if (!res.ok()) {
    throw new Error(
      `register ${name} failed: ${res.status()} ${await res.text()}`,
    );
  }
  return (await res.json()) as ApiParticipant;
}

export async function createGroup(
  request: APIRequestContext,
  title: string,
  participantId: string,
): Promise<ApiGroup> {
  const res = await request.post("/api/groups", {
    headers: { "X-Participant-Id": participantId },
    data: { title },
  });
  if (!res.ok()) {
    throw new Error(
      `create group ${title} failed: ${res.status()} ${await res.text()}`,
    );
  }
  return (await res.json()) as ApiGroup;
}

export async function postMessage(
  request: APIRequestContext,
  groupId: string,
  body: string,
  participantId: string,
): Promise<ApiMessage> {
  const res = await request.post(`/api/groups/${groupId}/messages`, {
    headers: { "X-Participant-Id": participantId },
    data: { body },
  });
  if (!res.ok()) {
    throw new Error(`post message failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as ApiMessage;
}

export async function listMessages(
  request: APIRequestContext,
  groupId: string,
): Promise<ApiMessage[]> {
  const res = await request.get(`/api/groups/${groupId}/messages`);
  if (!res.ok()) {
    throw new Error(
      `list messages failed: ${res.status()} ${await res.text()}`,
    );
  }
  return (await res.json()) as ApiMessage[];
}

export async function createTask(
  request: APIRequestContext,
  groupId: string,
  messageId: string,
  executorParticipantId: string,
  callerParticipantId: string,
): Promise<ApiTask> {
  const res = await request.post(`/api/groups/${groupId}/tasks`, {
    headers: { "X-Participant-Id": callerParticipantId },
    data: { messageId, executorParticipantId },
  });
  if (!res.ok()) {
    throw new Error(`create task failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as ApiTask;
}

/** 在页面加载前把身份写入 localStorage(与 identity store 同一 key)。 */
export async function bindIdentity(
  page: Page,
  participantId: string,
): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem("coagenthub.agentId", id);
  }, participantId);
}
