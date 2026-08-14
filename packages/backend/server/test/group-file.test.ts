import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * P2P 文件信令 (ticket 05): 发送方在群组内发「文件就绪」消息 — 消息携带
 * fileRef(名称/大小/SHA256/fetchUrl/expiresAt),fetchUrl 指向发送方设备
 * 自己的 LAN HTTP 端点;接收方通过 API 拉到消息后直连 fetchUrl 拉取字节,
 * CoAgentHub 只做信令,绝不读写/代理文件字节本身。
 */
describe("群组文件信令 (P2P)", () => {
  const app = createTestApp();

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    return { id };
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
    actorId: string,
    groupId: string,
    participantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": actorId,
      },
      body: JSON.stringify({ participantId, roles }),
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

  async function fetchMessages(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      body: string;
      fileRef: {
        name: string;
        size: number;
        sha256: string;
        fetchUrl: string;
        expiresAt?: string;
      } | null;
    }>;
  }

  async function setupGroup() {
    const sender = await registerParticipant({
      name: "hermes-mac",
      device: "mac-mini",
    });
    const receiver = await registerParticipant({
      name: "win-hermes",
      device: "win-pc",
    });
    const group = await createGroup(sender.id, "模型训练任务");
    await addMember(sender.id, group.id, receiver.id, ["executor"]);
    return { group, sender, receiver };
  }

  /** 临时本地 http server 模拟发送方设备上的 LAN 文件端点。 */
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
          url: `http://127.0.0.1:${address.port}/f/trained-model.bin`,
          server,
        });
      });
    });
  }

  describe("POST /api/groups/:id/messages 携带 fileRef", () => {
    it("发送合法 fileRef 信令消息 → 落库,响应透出 fileRef", async () => {
      const { group, sender } = await setupGroup();
      const fileRef = {
        name: "trained-model.bin",
        size: 2048,
        sha256: "a".repeat(64),
        fetchUrl: "http://192.168.1.10:8080/f/trained-model.bin",
      };

      const res = await sendMessage(sender.id, group.id, { fileRef });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as {
        body: string;
        fileRef: typeof fileRef & { expiresAt: string };
      };
      expect(msg.body).toBe("");
      expect(msg.fileRef).toMatchObject(fileRef);
      // T17: expiresAt 服务端必填 —— 未传时默认 now + 7d。
      expect(new Date(msg.fileRef.expiresAt).getTime()).toBeGreaterThan(
        Date.now() + 7 * 24 * 60 * 60 * 1000 - 60_000,
      );

      // 落库持久化,GET 同样透出
      const messages = await fetchMessages(sender.id, group.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].fileRef).toMatchObject(fileRef);
    });

    it("fileRef 缺字段 / 类型错误 → 400", async () => {
      const { group, sender } = await setupGroup();

      const missingName = await sendMessage(sender.id, group.id, {
        fileRef: {
          size: 1,
          sha256: "a".repeat(64),
          fetchUrl: "http://192.168.1.10:8080/f/x",
        },
      });
      expect(missingName.status).toBe(400);

      const wrongSizeType = await sendMessage(sender.id, group.id, {
        fileRef: {
          name: "x.bin",
          size: "1024", // 字符串不是 number
          sha256: "a".repeat(64),
          fetchUrl: "http://192.168.1.10:8080/f/x",
        },
      });
      expect(wrongSizeType.status).toBe(400);

      const badSha256 = await sendMessage(sender.id, group.id, {
        fileRef: {
          name: "x.bin",
          size: 1,
          sha256: "not-a-hex-digest",
          fetchUrl: "http://192.168.1.10:8080/f/x",
        },
      });
      expect(badSha256.status).toBe(400);

      const badFetchUrl = await sendMessage(sender.id, group.id, {
        fileRef: {
          name: "x.bin",
          size: 1,
          sha256: "a".repeat(64),
          fetchUrl: "not-a-url",
        },
      });
      expect(badFetchUrl.status).toBe(400);

      // 非法 fileRef 不应落库
      const messages = await fetchMessages(sender.id, group.id);
      expect(messages).toHaveLength(0);
    });

    it("body 与 fileRef 可同时携带,也可任选其一(纯文件信令允许空 body)", async () => {
      const { group, sender } = await setupGroup();
      const fileRef = {
        name: "model.bin",
        size: 1024,
        sha256: "b".repeat(64),
        fetchUrl: "http://192.168.1.10:8080/f/model.bin",
      };

      // 只带 fileRef(纯文件信令)
      const signalingOnly = await sendMessage(sender.id, group.id, {
        fileRef,
      });
      expect(signalingOnly.status).toBe(200);
      expect(((await signalingOnly.json()) as { body: string }).body).toBe("");

      // 只带 body(普通消息)
      const bodyOnly = await sendMessage(sender.id, group.id, {
        body: "模型训练完成",
      });
      expect(bodyOnly.status).toBe(200);
      expect(
        ((await bodyOnly.json()) as { fileRef: unknown }).fileRef,
      ).toBeNull();

      // body 与 fileRef 同时携带
      const both = await sendMessage(sender.id, group.id, {
        body: "训练完成,文件如下",
        fileRef,
      });
      expect(both.status).toBe(200);
      const bothMsg = (await both.json()) as {
        body: string;
        fileRef: typeof fileRef & { expiresAt: string };
      };
      expect(bothMsg.body).toBe("训练完成,文件如下");
      expect(bothMsg.fileRef).toMatchObject(fileRef);
      expect(bothMsg.fileRef.expiresAt).toBeTruthy();

      // 两者皆空 → 400
      const neither = await sendMessage(sender.id, group.id, {});
      expect(neither.status).toBe(400);
    });
  });

  describe("P2P 验收:接收方直连发送方设备端点拉取", () => {
    it("通过 API 拿到含 fetchUrl 的信令消息后,直连 fetchUrl 拉取字节并校验 SHA256", async () => {
      const { group, sender, receiver } = await setupGroup();

      // 发送方设备上的真实文件字节 + 其 SHA256
      const fileBytes = Buffer.from(
        "trained-model-weights-" + "x".repeat(4096),
        "utf-8",
      );
      const sha256 = createHash("sha256").update(fileBytes).digest("hex");

      // 本地临时 http server 模拟发送方设备的 LAN 端点(固定字节)
      const { url: fetchUrl, server } = await startSenderServer(fileBytes);
      try {
        const fileRef = {
          name: "trained-model.bin",
          size: fileBytes.length,
          sha256,
          fetchUrl,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };

        // 发送方广播文件就绪信令
        const post = await sendMessage(sender.id, group.id, { fileRef });
        expect(post.status).toBe(200);

        // 接收方通过 CoAgentHub API 增量拉到信令消息(含 fetchUrl)
        const messages = await fetchMessages(receiver.id, group.id);
        const signal = messages.find(
          (m) => m.fileRef?.name === "trained-model.bin",
        );
        expect(signal).toBeDefined();
        expect(signal!.fileRef).toEqual(fileRef);

        // 接收方直连发送方设备端点拉取字节 —— 不走 CoAgentHub
        const response = await fetch(signal!.fileRef!.fetchUrl);
        expect(response.status).toBe(200);
        const received = Buffer.from(await response.arrayBuffer());

        // 校验大小与 SHA256 一致
        expect(received.length).toBe(fileBytes.length);
        expect(received.equals(fileBytes)).toBe(true);
        expect(createHash("sha256").update(received).digest("hex")).toBe(
          sha256,
        );
      } finally {
        server.close();
      }
    });
  });
});
