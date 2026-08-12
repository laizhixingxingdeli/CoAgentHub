import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * Ticket 08 — 端到端验收脚本:一条命令(一个用例)走完整个产品故事。
 *
 * 用户故事(win 端 hermes 训练好模型 → 群组通知 → mac 端拉取交付):
 *   user(human) 发命令 → coordinator(hermes/mac) 整理成草稿 → reviewer(hermes/win)
 *   检视并附意见 → coordinator 采纳后发最终版 → executor(atomcode) 执行并回传结果 →
 *   trainer(specialist) 发文件信令 → executor 经 fetchUrl 直连 trainer 设备 P2P 拉取,
 *   校验 SHA256 → human 全程可见 → webhook 通知 → 归档后历史只读。
 *
 * 与 issue 08 验收标准一一对应:
 *   1. executor 从未见过草稿与检视意见,任务消息只见最终版及之后(含增量游标);
 *      用户命令是 broadcast,按可见性规则全员可见,executor 同样会看到
 *   2. human 全程可见全部消息(命令/草稿/检视/最终版/结果/文件信令),一条不落
 *   3. 文件经 fetchUrl 直连拉取(P2P,不经 CoAgentHub),字节与 SHA256 一致
 *   4. 广播消息后 webhook 通知到达(至少一次)
 *   5. 归档成功且历史仍可读
 */
describe("端到端验收(ticket 08):win 训练 → mac 交付全流程", () => {
  const app = createTestApp();

  type MessageItem = {
    id: string;
    groupId: string;
    senderId: string;
    parentId: string | null;
    audience: "broadcast" | "role" | "agent";
    audienceRef: string | null;
    body: string;
    depth: number;
    createdAt: string;
    fileRef: {
      name: string;
      size: number;
      sha256: string;
      fetchUrl: string;
      expiresAt?: string;
    } | null;
  };

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

  /** 临时本地 http server 模拟 trainer(win 端)设备上的 LAN 文件端点。 */
  function startSenderServer(
    bytes: Buffer,
  ): Promise<{ url: string; server: Server }> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(bytes);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("unexpected server address");
        }
        resolve({
          url: `http://127.0.0.1:${address.port}/f/model.bin`,
          server,
        });
      });
    });
  }

  const receivers: Receiver[] = [];
  afterEach(async () => {
    await Promise.all(receivers.splice(0).map((r) => r.close()));
  });

  /** 轮询等待某个 body 的 webhook 事件到达(不依赖多事件到达顺序)。 */
  async function waitForBody(
    rx: Receiver,
    body: string,
    timeoutMs = 1000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (rx.received.some((e) => e.message.body === body)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

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
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as MessageItem;
  }

  /** 增量拉取:无游标返回调用方全部可见历史;after=<messageId> 只取更新的。 */
  async function fetchMessages(token: string, groupId: string, after?: string) {
    const res = await app.request(
      `/api/groups/${groupId}/messages${after ? `?after=${after}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as MessageItem[];
  }

  it("完整用户故事:命令→草稿→检视→最终版→执行→P2P 文件→webhook→归档", async () => {
    // ── 1. 注册 5 个 agent:user(human)/coordinator(hermes mac)/reviewer(hermes win)
    //        /executor(atomcode,无 webhook)/trainer(specialist)
    const [userRx, coordinatorRx, reviewerRx, trainerRx] = await Promise.all([
      startWebhookReceiver(),
      startWebhookReceiver(),
      startWebhookReceiver(),
      startWebhookReceiver(),
    ]);
    receivers.push(userRx, coordinatorRx, reviewerRx, trainerRx);

    const user = await registerAgent({
      name: "alice",
      type: "human",
      device: "macbook",
      webhookUrl: userRx.url,
    });
    const coordinator = await registerAgent({
      name: "hermes-mac",
      type: "hermes",
      device: "mac-mini",
      webhookUrl: coordinatorRx.url,
    });
    const reviewer = await registerAgent({
      name: "hermes-win",
      type: "hermes",
      device: "win-pc",
      webhookUrl: reviewerRx.url,
    });
    const executor = await registerAgent({
      name: "atomcode",
      type: "atomcode",
      // 无 webhookUrl:纯增量拉取的 CLI agent(短生命周期,无需常驻监听)
    });
    const trainer = await registerAgent({
      name: "ml-trainer",
      type: "specialist",
      device: "win-gpu",
      webhookUrl: trainerRx.url,
    });

    // ── 2. 建群「训练 win 端 LLM 模型」;加成员并分配角色
    //        (coordinator 为创建者,自动成为 coordinator 成员)
    const group = await createGroup(coordinator.token, "训练 win 端 LLM 模型");
    await addMember(coordinator.token, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.token, group.id, executor.id, ["executor"]);
    await addMember(coordinator.token, group.id, trainer.id, ["specialist"]);
    await addMember(coordinator.token, group.id, user.id, ["human"]);

    // ── 3. 用户发命令(user → broadcast):「训练 win 端模型,并交付到 mac」
    const command = await sendMessage(user.token, group.id, {
      body: "训练 win 端模型,并交付到 mac",
      audience: "broadcast",
    });
    expect(command.audience).toBe("broadcast");

    // ── 11a. webhook 断言:广播命令后,带 webhook 的成员(coordinator)收到通知
    const coordEvents = await coordinatorRx.waitFor(1);
    expect(coordEvents[0].type).toBe("group_message");
    expect(coordEvents[0].message.body).toBe(command.body);
    expect(coordEvents[0].groupId).toBe(group.id);

    // ── 4. coordinator 拉取(应可见用户命令)→ 发草稿任务给 reviewer
    const coordFirstPull = await fetchMessages(coordinator.token, group.id);
    expect(coordFirstPull.map((m) => m.body)).toContain(command.body);

    const draft = await sendMessage(coordinator.token, group.id, {
      body: "草稿:在 win 端训练 7B 模型,请评审",
      audience: "role",
      audienceRef: "reviewer",
    });
    expect(draft.audience).toBe("role");
    expect(draft.audienceRef).toBe("reviewer");
    expect(draft.parentId).toBeNull();

    // ── 5. reviewer 收到(拉取)→ 发检视意见(子消息,parentId=草稿)
    // 用户命令是 broadcast,按可见性规则全员可见,reviewer 同样会看到
    const reviewerSeen = await fetchMessages(reviewer.token, group.id);
    expect(reviewerSeen.map((m) => m.body)).toEqual([command.body, draft.body]);

    const review = await sendMessage(reviewer.token, group.id, {
      body: "检视意见:补充数据清洗步骤,否则收敛不稳",
      parentId: draft.id,
      audience: "role",
      audienceRef: "coordinator",
    });
    expect(review.parentId).toBe(draft.id);
    expect(review.depth).toBe(1);

    // ── 6. coordinator 采纳 → 发最终版给 executor
    const coordSeen = await fetchMessages(coordinator.token, group.id);
    expect(coordSeen.map((m) => m.body)).toEqual([
      command.body,
      draft.body,
      review.body,
    ]);

    const final = await sendMessage(coordinator.token, group.id, {
      body: "最终版:在 win 端训练 7B 模型(含数据清洗),交付到 mac",
      audience: "role",
      audienceRef: "executor",
    });
    expect(final.audience).toBe("role");
    expect(final.audienceRef).toBe("executor");

    // ── 7. executor 执行,发结果 broadcast
    const result = await sendMessage(executor.token, group.id, {
      body: "训练完成,模型在 win 端",
      audience: "broadcast",
    });
    expect(result.audience).toBe("broadcast");

    // ── 8. trainer(specialist)发文件信令消息。audience 选 broadcast 并说明:
    //        文件交付是团队可见事件(human 全程观察、coordinator 需要跟进),
    //        而 executor 作为群成员同样收广播,visibility 两种选法均满足;
    //        broadcast 同时覆盖最大的 webhook 扇出面,故取之。
    //        fileRef 的 fetchUrl 指向 trainer 设备本地临时 http server(真 P2P)。
    const fileBytes = Buffer.from(
      "win-model-weights-" + "w".repeat(4096),
      "utf-8",
    );
    const fileSha256 = createHash("sha256").update(fileBytes).digest("hex");
    const { url: fetchUrl, server } = await startSenderServer(fileBytes);
    try {
      const fileRef = {
        name: "model.bin",
        size: fileBytes.length,
        sha256: fileSha256,
        fetchUrl,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      const signal = await sendMessage(trainer.token, group.id, {
        body: "模型文件已就绪,请直连拉取",
        audience: "broadcast",
        fileRef,
      });
      expect(signal.fileRef).toEqual(fileRef);

      // ── 9. executor 增量拉取:从未见过草稿与检视意见;见过最终版、结果、文件信令
      const executorFull = await fetchMessages(executor.token, group.id);
      const executorBodies = executorFull.map((m) => m.body);
      // 验收核心:草稿与检视意见不在 executor 的可见集合中
      expect(executorBodies).not.toContain(draft.body);
      expect(executorBodies).not.toContain(review.body);
      // 任务工作流消息:executor 只见最终版及之后(结果、文件信令);
      // 用户命令是 broadcast,按可见性规则全员可见,同样出现在 executor 视野中
      expect(executorBodies).toEqual([
        command.body,
        final.body,
        result.body,
        signal.body,
      ]);
      // 增量游标语义:以最终版为游标,只取结果与文件信令
      const executorIncremental = await fetchMessages(
        executor.token,
        group.id,
        final.id,
      );
      expect(executorIncremental.map((m) => m.body)).toEqual([
        result.body,
        signal.body,
      ]);

      // ── 9b. P2P 交付闭环:executor 直连 fetchUrl 拉取字节,校验 SHA256(不经 CoAgentHub)
      const fileSignal = executorFull.find(
        (m) => m.fileRef?.name === "model.bin",
      );
      expect(fileSignal).toBeDefined();
      const response = await fetch(fileSignal!.fileRef!.fetchUrl);
      expect(response.status).toBe(200);
      const received = Buffer.from(await response.arrayBuffer());
      expect(received.length).toBe(fileBytes.length);
      expect(received.equals(fileBytes)).toBe(true);
      expect(createHash("sha256").update(received).digest("hex")).toBe(
        fileSha256,
      );

      // ── 10. user(human)增量拉取:全程可见,一条不落
      const humanSeen = await fetchMessages(user.token, group.id);
      const humanBodies = humanSeen.map((m) => m.body);
      expect(humanBodies).toHaveLength(6);
      expect(humanBodies).toEqual([
        command.body,
        draft.body,
        review.body,
        final.body,
        result.body,
        signal.body,
      ]);

      // ── 11b. webhook 追加断言:执行结果 broadcast 后,coordinator 再次收到通知
      //        (轮询等待目标事件,不依赖多事件到达顺序)
      expect(await waitForBody(coordinatorRx, result.body)).toBe(true);

      // ── 12. 归档群组(audit 语义):archive → 200;归档后历史仍可拉取(只读)
      const archiveRes = await app.request(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${coordinator.token}` },
      });
      expect(archiveRes.status).toBe(200);
      const archived = (await archiveRes.json()) as { status: string };
      expect(archived.status).toBe("archived");

      const historyAfterArchive = await fetchMessages(user.token, group.id);
      expect(historyAfterArchive.map((m) => m.body)).toEqual(humanBodies);
    } finally {
      server.close();
    }
  });
});
