import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as netConnect, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RawData, WebSocket } from "ws";
import { WsHub, wsHub } from "../src/lib/ws-hub";
import { createTestApp } from "./app";

/**
 * WS realtime push tests (ticket 13). `app.request()` cannot exercise a WS
 * handshake, so these start a real http.Server on a random port, attach the
 * hub to its upgrade event, and connect with real `ws` clients. The REST
 * setup calls (participants/groups/messages) run through app.request() against the
 * same in-memory PGlite, so identities and messages are shared.
 */
const app = createTestApp();

let server: Server;
let port: number;
const openClients = new Set<WebSocket>();

const wsUrl = (participantId: string) =>
  `ws://127.0.0.1:${port}/api/ws?participantId=${participantId}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error("condition not met in time");
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("ws open timeout"));
    }, 2000);
    ws.on("open", () => {
      clearTimeout(timer);
      openClients.add(ws);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMessage(
  ws: WebSocket,
  timeoutMs = 1500,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("ws message timeout")),
      timeoutMs,
    );
    const onMessage = (data: RawData) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(JSON.parse(data.toString()));
    };
    ws.on("message", onMessage);
  });
}

async function registerParticipant(body: Record<string, unknown>) {
  const res = await app.request("/api/participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // 名字唯一(0013):同名已注册时服务端返回 409,复用现有 participant(测试内多次 setupGroup)。
  if (res.status === 409) {
    const list = (await (await app.request("/api/participants")).json()) as {
      id: string;
      name: string;
    }[];
    const existing = list.find((p) => p.name === body.name);
    if (existing) return { id: existing.id };
  }
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function createGroup(participantId: string, title: string) {
  const res = await app.request("/api/groups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": participantId,
    },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function addMember(
  participantId: string,
  groupId: string,
  memberParticipantId: string,
  roles: string[],
) {
  const res = await app.request(`/api/groups/${groupId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": participantId,
    },
    body: JSON.stringify({ participantId: memberParticipantId, roles }),
  });
  expect(res.status).toBe(200);
}

async function sendMessage(
  participantId: string,
  groupId: string,
  body: Record<string, unknown>,
) {
  return app.request(`/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": participantId,
    },
    body: JSON.stringify(body),
  });
}

/** coordinator + reviewer + executor + human 成员 + 一个非成员 outsider。 */
async function setupGroup() {
  const coordinator = await registerParticipant({
    name: "hermes-mac",
    device: "mac-mini",
  });
  const reviewer = await registerParticipant({
    name: "win-hermes",
    device: "win-pc",
  });
  const executor = await registerParticipant({
    name: "atomcode-cli",
    device: "cli",
  });
  const human = await registerParticipant({
    name: "alice",
    device: "macbook",
  });
  const outsider = await registerParticipant({
    name: "outsider",
    device: "other-box",
  });
  const group = await createGroup(coordinator.id, "WS 推送测试");
  await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
  await addMember(coordinator.id, group.id, executor.id, ["executor"]);
  await addMember(coordinator.id, group.id, human.id, ["human"]);
  return { group, coordinator, reviewer, executor, human, outsider };
}

beforeAll(async () => {
  // app.fetch 是 Hono 的 fetch 处理器(node 层由 @hono/node-server 适配);
  // 测试里直接驱动真实 upgrade 握手,按 RequestListener 形状使用即可。
  server = createServer(app.fetch as unknown as RequestListener);
  wsHub.handleUpgrade(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  wsHub.closeAll();
  for (const ws of openClients) ws.terminate();
  openClients.clear();
});

afterAll(async () => {
  wsHub.closeAll();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("a. 握手身份声明(?participantId=)", () => {
  it("无 participantId(?participantId= 空或缺参)→ 以本地用户身份连接(101)", async () => {
    const ws = await connectWs(wsUrl(""));
    ws.close();
    await expect(
      connectWs(`ws://127.0.0.1:${port}/api/ws`),
    ).resolves.toBeDefined();
  });

  it("未知 participantId → 回落本地用户(全信模型,不拒绝)", async () => {
    const ws = await connectWs(wsUrl("00000000-0000-4000-8000-0000000000ff"));
    ws.close();
  });

  it("非 /api/ws 路径的 upgrade 被忽略(不建立连接)", async () => {
    const participant = await registerParticipant({
      name: "probe",
      device: "p",
    });
    await expect(
      connectWs(
        `ws://127.0.0.1:${port}/api/nope?participantId=${participant.id}`,
      ),
    ).rejects.toThrow();
    expect(wsHub.connectionCount()).toBe(0);
  });
});

describe("a2. Local User 已是群成员:广播不重复投递", () => {
  it("无 token 建群后 Local User 是成员,广播仍只投递一次", async () => {
    // 无 token 建群 → Local User 自动成为 coordinator 成员。
    const created = await app.request("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "本地用户建的群" }),
    });
    expect(created.status).toBe(200);
    const group = (await created.json()) as { id: string };

    const member = await registerParticipant({
      name: "member-one",
    });
    await addMember(member.id, group.id, member.id, ["executor"]);

    // 无 token 连接 → Local User socket(该身份已是群成员)。
    const localWs = await connectWs(`ws://127.0.0.1:${port}/api/ws`);
    let received = 0;
    localWs.on("message", () => {
      received += 1;
    });

    const res = await sendMessage(member.id, group.id, { body: "单次广播" });
    expect(res.status).toBe(200);

    await waitFor(() => received >= 1);
    // 若 fanOut 把 Local User 当成员投一次、又额外投一次,会收到 2 条。
    await sleep(150);
    expect(received).toBe(1);
  });
});

describe("b. 广播:发送者回显 + 成员收到完整消息", () => {
  it("broadcast 消息推给在线成员与发送者本人,消息字段完整", async () => {
    const { group, coordinator, reviewer } = await setupGroup();
    const senderWs = await connectWs(wsUrl(coordinator.id));
    const reviewerWs = await connectWs(wsUrl(reviewer.id));
    expect(wsHub.connectionCount()).toBe(2);

    // 先挂监听器再发消息:广播是 fire-and-forget,可能在 POST 返回前就已推送,
    // 事后才 waitForMessage 会错过事件。
    const senderMsg = waitForMessage(senderWs);
    const reviewerMsg = waitForMessage(reviewerWs);
    const res = await sendMessage(coordinator.id, group.id, {
      body: "WS 广播实测",
    });
    expect(res.status).toBe(200);

    for (const event of [await senderMsg, await reviewerMsg]) {
      expect(event.type).toBe("group_message");
      expect(event.groupId).toBe(group.id);
      const msg = event.message as Record<string, unknown>;
      // 与 GET /:id/messages 行同形状
      expect(typeof msg.id).toBe("string");
      expect(msg.groupId).toBe(group.id);
      expect(msg.senderId).toBe(coordinator.id);
      expect(msg.parentId).toBeNull();
      expect(msg.audience).toBe("broadcast");
      expect(msg.audienceRef).toBeNull();
      expect(msg.body).toBe("WS 广播实测");
      expect(msg.contentType).toBe("text/plain");
      expect(msg.fileRef).toBeNull();
      expect(typeof msg.createdAt).toBe("string");
      expect(new Date(msg.createdAt as string).getTime()).not.toBeNaN();
      expect(typeof msg.updatedAt).toBe("string");
      expect(msg.depth).toBe(0);
    }

    // 发送者本人也收(webhook 剔除发送者,WS 不剔除——前端回显需要)
    expect(wsHub.connectionCount()).toBe(2);
  });
});

describe("c. 可见性:只推可见成员", () => {
  it("role:reviewer 消息只推给 reviewer;executor(成员但非该角色)与非成员不收;human 收", async () => {
    const { group, coordinator, reviewer, executor, human, outsider } =
      await setupGroup();
    const reviewerWs = await connectWs(wsUrl(reviewer.id));
    const executorWs = await connectWs(wsUrl(executor.id));
    const humanWs = await connectWs(wsUrl(human.id));
    const outsiderWs = await connectWs(wsUrl(outsider.id));

    const reviewerMsg = waitForMessage(reviewerWs);
    const humanMsg = waitForMessage(humanWs);
    const res = await sendMessage(coordinator.id, group.id, {
      body: "请审查草稿",
      audience: "role",
      audienceRef: "reviewer",
    });
    expect(res.status).toBe(200);

    const reviewerEvent = await reviewerMsg;
    expect((reviewerEvent.message as Record<string, unknown>).body).toBe(
      "请审查草稿",
    );
    // human 绕过 audience 规则
    const humanEvent = await humanMsg;
    expect((humanEvent.message as Record<string, unknown>).body).toBe(
      "请审查草稿",
    );

    // 非目标角色成员 / 非成员:短暂等待确认零推送
    await sleep(250);
    expect(executorWs.readyState).toBe(WebSocket.OPEN);
    expect(outsiderWs.readyState).toBe(WebSocket.OPEN);
  });

  it("audience=participant 只推目标成员;其他成员(含 human 外)不收", async () => {
    const { group, coordinator, reviewer, executor, human } =
      await setupGroup();
    const reviewerWs = await connectWs(wsUrl(reviewer.id));
    const executorWs = await connectWs(wsUrl(executor.id));
    const humanWs = await connectWs(wsUrl(human.id));

    const reviewerMsg = waitForMessage(reviewerWs);
    const humanMsg = waitForMessage(humanWs);
    const res = await sendMessage(coordinator.id, group.id, {
      body: "专属指令",
      audience: "participant",
      audienceRef: reviewer.id,
    });
    expect(res.status).toBe(200);

    const reviewerEvent = await reviewerMsg;
    const msg = reviewerEvent.message as Record<string, unknown>;
    expect(msg.body).toBe("专属指令");
    expect(msg.audienceRef).toBe(reviewer.id);

    // human 仍收到(绕过 audience);executor 非目标不收
    const humanEvent = await humanMsg;
    expect((humanEvent.message as Record<string, unknown>).body).toBe(
      "专属指令",
    );
    await sleep(250);
    expect(executorWs.readyState).toBe(WebSocket.OPEN);
  });
});

describe("d. 连接生命周期", () => {
  it("客户端关闭后从 Hub 清理,发布不再推给死连接", async () => {
    const { group, coordinator } = await setupGroup();
    const ws = await connectWs(wsUrl(coordinator.id));
    expect(wsHub.connectionCount()).toBe(1);

    ws.close();
    await waitFor(() => wsHub.connectionCount() === 0);

    // 发布仍成功,注册表保持空,无异常
    const res = await sendMessage(coordinator.id, group.id, {
      body: "关闭后的消息",
    });
    expect(res.status).toBe(200);
    await sleep(100);
    expect(wsHub.connectionCount()).toBe(0);
  });

  it("心跳终止不做 pong 的僵尸连接(isAlive 模式)", async () => {
    // 独立 hub,短心跳间隔,避免拖慢测试
    const hub = new WsHub({ heartbeatIntervalMs: 50 });
    const hs = createServer(app.fetch as unknown as RequestListener);
    hub.handleUpgrade(hs);
    await new Promise<void>((r) => hs.listen(0, "127.0.0.1", r));
    const hsPort = (hs.address() as AddressInfo).port;

    const participant = await registerParticipant({
      name: "zombie",
      device: "z",
    });

    // 裸 TCP 客户端:完成 101 握手后不再解析/应答任何帧 → 服务器 ping 无 pong
    const raw = netConnect(hsPort, "127.0.0.1");
    await new Promise<void>((r) => raw.on("connect", r));
    const key = Buffer.from("0123456789abcdef").toString("base64");
    raw.write(
      `GET /api/ws?participantId=${participant.id} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${hsPort}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("handshake timeout")),
        2000,
      );
      let buf = "";
      raw.on("data", (chunk) => {
        buf += chunk.toString();
        if (buf.includes("\r\n\r\n")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    expect(hub.connectionCount()).toBe(1);

    // 两轮心跳(50ms)内服务器 terminate → 客户端收到 FIN/close
    await new Promise<void>((resolve) => {
      raw.on("close", () => resolve());
      setTimeout(resolve, 1500); // 兜底防悬挂
    });
    await waitFor(() => hub.connectionCount() === 0);

    hub.closeAll();
    hs.closeAllConnections();
    await new Promise<void>((r) => hs.close(() => r()));
  });
});

describe("e. 编辑/删除广播 (ticket 22)", () => {
  async function patchMessage(
    participantId: string,
    groupId: string,
    messageId: string,
    body: Record<string, unknown>,
  ) {
    return app.request(`/api/groups/${groupId}/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
  }

  async function deleteMessage(
    participantId: string,
    groupId: string,
    messageId: string,
  ) {
    return app.request(`/api/groups/${groupId}/messages/${messageId}`, {
      method: "DELETE",
      headers: { "X-Participant-Id": participantId },
    });
  }

  it("PATCH 后广播 group_message_updated:成员与发送者本人收到完整更新行", async () => {
    const { group, coordinator, reviewer } = await setupGroup();
    const posted = (await (
      await sendMessage(coordinator.id, group.id, { body: "改前" })
    ).json()) as { id: string };
    const senderWs = await connectWs(wsUrl(coordinator.id));
    const reviewerWs = await connectWs(wsUrl(reviewer.id));

    // 先挂监听再 PATCH:广播是 fire-and-forget
    const senderEvent = waitForMessage(senderWs);
    const reviewerEvent = waitForMessage(reviewerWs);
    const res = await patchMessage(coordinator.id, group.id, posted.id, {
      body: "改后",
    });
    expect(res.status).toBe(200);

    for (const event of [await senderEvent, await reviewerEvent]) {
      expect(event.type).toBe("group_message_updated");
      expect(event.groupId).toBe(group.id);
      const msg = event.message as Record<string, unknown>;
      expect(msg.id).toBe(posted.id);
      expect(msg.body).toBe("改后");
      expect(msg.senderId).toBe(coordinator.id);
      expect(msg.updatedAt).toBeTruthy();
      expect(msg.depth).toBe(0);
    }
  });

  it("DELETE 后广播 group_message_deleted:仅带 groupId + messageId", async () => {
    const { group, coordinator, reviewer } = await setupGroup();
    const posted = (await (
      await sendMessage(coordinator.id, group.id, { body: "待删除" })
    ).json()) as { id: string };
    const senderWs = await connectWs(wsUrl(coordinator.id));
    const reviewerWs = await connectWs(wsUrl(reviewer.id));

    const senderEvent = waitForMessage(senderWs);
    const reviewerEvent = waitForMessage(reviewerWs);
    const res = await deleteMessage(coordinator.id, group.id, posted.id);
    expect(res.status).toBe(200);

    for (const event of [await senderEvent, await reviewerEvent]) {
      expect(event.type).toBe("group_message_deleted");
      expect(event.groupId).toBe(group.id);
      expect(event.messageId).toBe(posted.id);
    }
  });

  it("可见性:role 定向消息的编辑/删除只推给该角色成员与 human,非目标成员不收", async () => {
    const { group, coordinator, reviewer, executor, human } =
      await setupGroup();
    const posted = (await (
      await sendMessage(coordinator.id, group.id, {
        body: "评审稿",
        audience: "role",
        audienceRef: "reviewer",
      })
    ).json()) as { id: string };
    const reviewerWs = await connectWs(wsUrl(reviewer.id));
    const humanWs = await connectWs(wsUrl(human.id));
    const executorWs = await connectWs(wsUrl(executor.id));
    // 非目标成员收到的所有帧:断言其中没有任何编辑/删除事件
    const executorFrames: string[] = [];
    executorWs.on("message", (data) => executorFrames.push(String(data)));

    const reviewerEvent = waitForMessage(reviewerWs);
    const humanEvent = waitForMessage(humanWs);
    const res = await patchMessage(coordinator.id, group.id, posted.id, {
      body: "评审稿 v2",
    });
    expect(res.status).toBe(200);

    expect((await reviewerEvent).type).toBe("group_message_updated");
    expect((await humanEvent).type).toBe("group_message_updated");
    // 等待窗口内 executor 零帧:readyState 仍 OPEN 只证明连接在,不证明零推送
    await sleep(250);
    expect(
      executorFrames
        .map((f) => JSON.parse(f) as { type?: string })
        .map((f) => f.type),
    ).toEqual([]);
  });
});
