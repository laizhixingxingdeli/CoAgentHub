/**
 * E2E API helpers — 用 Playwright 的 request fixture 直接调 server(经 web 反代
 * 同源 /api),为浏览器用例准备数据:注册 participant、建群、发消息、注入任务。
 *
 * 隔离原则:每个用例用唯一名称(uniqueName),run 间数据由 globalSetup 清场,
 * 用例间互不依赖、互不污染。
 */
import type { APIRequestContext } from "@playwright/test";

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

export async function listParticipants(
  request: APIRequestContext,
): Promise<ApiParticipant[]> {
  const res = await request.get("/api/participants");
  if (!res.ok()) {
    throw new Error(
      `list participants failed: ${res.status()} ${await res.text()}`,
    );
  }
  return (await res.json()) as ApiParticipant[];
}

/** 服务端预建的默认观察者身份名(server/lib/local-participant.ts 同值)。 */
const LOCAL_USER_NAME = "Local User";

/**
 * 浏览器侧的身份 = 服务端预建的「Local User」。2026-08-24(f6dc7b22)起前端
 * 不再本地持久化身份,一律经 GET /api/participants 找这个名字的 participant
 * (web/src/lib/local-user.ts),浏览器无法再扮演任意 participant —— 取代了
 * 原先往 localStorage 写 "coagenthub.agentId" 的 bindIdentity(那个键前端已
 * 无读写方,是空操作,已随本批删除)。
 *
 * 用它的 id 建群,浏览器打开该群时自己就是 coordinator 成员(建群者同事务
 * 自动入群,routes/group/groups.ts:67)。**需要从 UI 写入的用例必须这样建群**:
 * 否则 Local User 不是成员 → POST 消息 403「不是本群成员」;即使入了群但角色
 * 是 human,自由文本/广播也会被 §3.8 只读守卫挡掉。
 */
export async function localUserParticipantId(
  request: APIRequestContext,
): Promise<string> {
  const localUser = (await listParticipants(request)).find(
    (participant) => participant.name === LOCAL_USER_NAME,
  );
  if (!localUser) {
    throw new Error(
      `participant 名册里没有「${LOCAL_USER_NAME}」— server 开机预建(ensureExecutorParticipants)没跑成功?`,
    );
  }
  return localUser.id;
}
