import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * Webhook 通知 (ticket 06):新消息落库后,按可见性规则(与 GET 过滤同源,
 * 见 src/lib/group-visibility.ts)找出相关 agent,对其 webhookUrl 尽力而为地
 * POST 事件;发送者本人不通知;human 成员参与接收者集合(仅当其有 webhookUrl)。
 * 通知是 fire-and-forget——webhook 失败绝不阻塞消息写入主流程与响应。
 */
describe("群组消息 webhook 通知", () => {
  const app = createTestApp();

  type WebhookEvent = {
    type: string;
    groupId: string;
    message: {
      id: string;
      groupId: string;
      senderId: string;
      parentId: string | null;
      audience: string;
      audienceRef: string | null;
      body: string;
      contentType: string;
      fileRef: unknown;
      createdAt: string;
      updatedAt: string;
      depth: number;
    };
  };

  type Receiver = {
    url: string;
    received: WebhookEvent[];
    close: () => Promise<void>;
    waitFor: (count: number, timeoutMs?: number) => Promise<WebhookEvent[]>;
  };

  /** 本地临时 http server 收集 webhook POST,127.0.0.1 随机端口。 */
  function startWebhookReceiver(): Promise<Receiver> {
    return new Promise((resolve) => {
      const received: WebhookEvent[] = [];
      const server: Server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          try {
            received.push(JSON.parse(raw) as WebhookEvent);
          } catch {
            // 忽略畸形负载,不影响主流程断言
          }
          res.statusCode = 200;
          res.end("ok");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("unexpected server address");
        }
        resolve({
          url: `http://127.0.0.1:${address.port}/webhook`,
          received,
          close: () =>
            new Promise((r) => {
              server.closeAllConnections?.();
              server.close(() => r());
            }),
          waitFor: async (count, timeoutMs = 1000) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              if (received.length >= count) return [...received];
              await new Promise((r) => setTimeout(r, 25));
            }
            return [...received];
          },
        });
      });
    });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const receivers: Receiver[] = [];
  afterEach(async () => {
    await Promise.all(receivers.splice(0).map((r) => r.close()));
  });

  async function registerAgent(body: Record<string, unknown>) {
    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const { id, token } = (await res.json()) as { id: string; token: string };
    return { id, token };
  }

  async function createGroup(token: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function addMember(
    token: string,
    groupId: string,
    agentId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function sendMessage(
    token: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    return app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function fetchMessages(token: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{ id: string; body: string }>;
  }

  /** 带 webhook 接收器的完整阵容:coordinator/reviewer/specialist/human 各有
   *  接收器,executor 无 webhookUrl(验证不通知、不异常)。 */
  async function setupWebhookGroup() {
    const [coordinatorRx, reviewerRx, specialistRx, humanRx] =
      await Promise.all([
        startWebhookReceiver(),
        startWebhookReceiver(),
        startWebhookReceiver(),
        startWebhookReceiver(),
      ]);
    receivers.push(coordinatorRx, reviewerRx, specialistRx, humanRx);

    const coordinator = await registerAgent({
      name: "hermes-mac",
      type: "hermes",
      device: "mac-mini",
      webhookUrl: coordinatorRx.url,
    });
    const reviewer = await registerAgent({
      name: "win-hermes",
      type: "hermes",
      device: "win-pc",
      webhookUrl: reviewerRx.url,
    });
    const specialist = await registerAgent({
      name: "ml-specialist",
      type: "specialist",
      device: "gpu-box",
      webhookUrl: specialistRx.url,
    });
    const human = await registerAgent({
      name: "alice",
      type: "human",
      device: "macbook",
      webhookUrl: humanRx.url,
    });
    const executor = await registerAgent({
      name: "atomcode-cli",
      type: "atomcode",
      // 无 webhookUrl:纯增量拉取的 CLI agent
    });
    const group = await createGroup(coordinator.token, "模型训练任务");
    await addMember(coordinator.token, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.token, group.id, specialist.id, ["specialist"]);
    await addMember(coordinator.token, group.id, human.id, ["human"]);
    await addMember(coordinator.token, group.id, executor.id, ["executor"]);
    return {
      group,
      coordinator,
      reviewer,
      specialist,
      human,
      executor,
      rx: {
        coordinator: coordinatorRx,
        reviewer: reviewerRx,
        specialist: specialistRx,
        human: humanRx,
      },
    };
  }

  describe("a. broadcast → 所有带 webhookUrl 的成员收到(含 human)", () => {
    it("广播消息通知全部 webhook 成员,发送者与无 webhook 成员除外", async () => {
      const { group, coordinator, rx } = await setupWebhookGroup();

      const res = await sendMessage(coordinator.token, group.id, {
        body: "全体注意,任务开始",
      });
      expect(res.status).toBe(200);

      const reviewerEvents = await rx.reviewer.waitFor(1);
      const humanEvents = await rx.human.waitFor(1);
      const specialistEvents = await rx.specialist.waitFor(1);
      expect(reviewerEvents[0].message.body).toBe("全体注意,任务开始");
      expect(humanEvents[0].message.body).toBe("全体注意,任务开始");
      expect(specialistEvents[0].message.body).toBe("全体注意,任务开始");
      expect(reviewerEvents[0].message.audience).toBe("broadcast");

      // 发送者本人不通知;短暂等待确认零通知
      await sleep(250);
      expect(rx.coordinator.received.length).toBe(0);
    });
  });

  describe("b. role → 仅该角色成员(带 webhookUrl)收到", () => {
    it("role:reviewer 只命中 reviewer 角色;非目标角色的 webhook 成员不收", async () => {
      const { group, coordinator, rx } = await setupWebhookGroup();

      const res = await sendMessage(coordinator.token, group.id, {
        body: "请审查草稿",
        audience: "role",
        audienceRef: "reviewer",
      });
      expect(res.status).toBe(200);

      const reviewerEvents = await rx.reviewer.waitFor(1);
      expect(reviewerEvents[0].message.body).toBe("请审查草稿");
      expect(reviewerEvents[0].message.audience).toBe("role");
      expect(reviewerEvents[0].message.audienceRef).toBe("reviewer");

      // human 按可见性语义绕过 audience 规则,同样收到
      const humanEvents = await rx.human.waitFor(1);
      expect(humanEvents[0].message.audienceRef).toBe("reviewer");

      // specialist 有 webhookUrl 但非 reviewer 角色 → 不收
      await sleep(250);
      expect(rx.specialist.received.length).toBe(0);
      expect(rx.coordinator.received.length).toBe(0);
    });
  });

  describe("c. agent → 仅目标成员收到;发送者本人不收", () => {
    it("audience=agent 只通知目标成员;发送者(有 webhook)不通知", async () => {
      const { group, coordinator, reviewer, rx } = await setupWebhookGroup();

      const res = await sendMessage(coordinator.token, group.id, {
        body: "专属指令",
        audience: "agent",
        audienceRef: reviewer.id,
      });
      expect(res.status).toBe(200);

      const reviewerEvents = await rx.reviewer.waitFor(1);
      expect(reviewerEvents[0].message.body).toBe("专属指令");
      expect(reviewerEvents[0].message.audience).toBe("agent");
      expect(reviewerEvents[0].message.audienceRef).toBe(reviewer.id);

      // human 绕过 audience,仍收到
      await rx.human.waitFor(1);

      // 发送者本人不收(coordinator 有 webhookUrl,排除逻辑有意义);
      // specialist 非目标不收
      await sleep(250);
      expect(rx.coordinator.received.length).toBe(0);
      expect(rx.specialist.received.length).toBe(0);
    });
  });

  describe("d. webhookUrl 指向不可达端口 → 主流程不受影响", () => {
    it("目标 webhook 失败不阻塞消息写入与响应,其他目标仍收到", async () => {
      // 先占一个端口再关闭,得到必然不可达的地址
      const dead = await startWebhookReceiver();
      const deadUrl = dead.url;
      await dead.close();
      const deadRx = await startWebhookReceiver();
      receivers.push(deadRx);
      const senderRx = await startWebhookReceiver();
      receivers.push(senderRx);

      const sender = await registerAgent({
        name: "hermes-mac",
        type: "hermes",
        device: "mac-mini",
        webhookUrl: senderRx.url,
      });
      const deadAgent = await registerAgent({
        name: "offline-agent",
        type: "openclaw",
        device: "dead-box",
        webhookUrl: deadUrl,
      });
      const liveAgent = await registerAgent({
        name: "win-hermes",
        type: "hermes",
        device: "win-pc",
        webhookUrl: deadRx.url,
      });
      const group = await createGroup(sender.token, "模型训练任务");
      await addMember(sender.token, group.id, deadAgent.id, ["executor"]);
      await addMember(sender.token, group.id, liveAgent.id, ["reviewer"]);

      const res = await sendMessage(sender.token, group.id, {
        body: "广播消息,目标一端不可达",
      });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as { id: string };

      // 消息仍写入(其他成员 GET 可见)
      const messages = await fetchMessages(liveAgent.token, group.id);
      expect(messages.map((m) => m.id)).toContain(msg.id);

      // 其他可达目标仍收到通知
      const liveEvents = await deadRx.waitFor(1);
      expect(liveEvents[0].message.body).toBe("广播消息,目标一端不可达");

      // 发送者本人不收
      await sleep(250);
      expect(senderRx.received.length).toBe(0);
    });
  });

  describe("e. 通知负载字段正确", () => {
    it("POST JSON 负载携带完整 message 对象(与 GET 行同形状,含 depth/contentType)", async () => {
      const { group, coordinator, reviewer, rx } = await setupWebhookGroup();

      const res = await sendMessage(coordinator.token, group.id, {
        body: "负载字段校验",
        audience: "role",
        audienceRef: "reviewer",
      });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as {
        id: string;
        groupId: string;
        senderId: string;
        parentId: string | null;
        body: string;
        audience: string;
        audienceRef: string | null;
        contentType: string;
        fileRef: unknown;
        createdAt: string;
        updatedAt: string;
        depth: number;
      };

      const events = await rx.reviewer.waitFor(1);
      const event = events[0];
      expect(event).toEqual({
        type: "group_message",
        groupId: group.id,
        message: {
          id: msg.id,
          groupId: msg.groupId,
          senderId: msg.senderId,
          parentId: msg.parentId,
          audience: "role",
          audienceRef: "reviewer",
          body: "负载字段校验",
          contentType: msg.contentType,
          fileRef: msg.fileRef,
          createdAt: msg.createdAt,
          updatedAt: msg.updatedAt,
          depth: msg.depth,
        },
      });
      expect(event.message.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("f. 无 webhookUrl 的成员 → 不通知、无异常", () => {
    it("消息正常落库,没有 webhook 的成员被跳过,不产生任何通知", async () => {
      const senderRx = await startWebhookReceiver();
      receivers.push(senderRx);
      const sender = await registerAgent({
        name: "hermes-mac",
        type: "hermes",
        device: "mac-mini",
        webhookUrl: senderRx.url,
      });
      const pullOnly = await registerAgent({
        name: "atomcode-cli",
        type: "atomcode",
        // 无 webhookUrl:纯 ?after= 增量拉取
      });
      const group = await createGroup(sender.token, "模型训练任务");
      await addMember(sender.token, group.id, pullOnly.id, ["executor"]);

      const res = await sendMessage(sender.token, group.id, {
        body: "纯拉取成员不应收到任何 webhook",
      });
      expect(res.status).toBe(200);

      // 消息仍正常落库,GET 可见
      const messages = await fetchMessages(pullOnly.token, group.id);
      expect(messages.map((m) => m.body)).toContain(
        "纯拉取成员不应收到任何 webhook",
      );

      // 目标成员无 webhook → 整个派发为空,不通知、无异常
      await sleep(300);
      expect(senderRx.received.length).toBe(0);
    });
  });
});
