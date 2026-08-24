import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";

// R1: GET /api/skills/:name 响应含 version(内容哈希),其余字段未变(回归)。
// R2: GET /api/skills/:name/digest 只回指纹、不下发全文,且不依赖 git
//     (哈希由文件内容算出,dist 里没有 .git 仍可用)。
const app = createTestApp();

describe("GET /api/skills/:name 版本指纹 (R1)", () => {
  it("返回 version 字段,且为内容 sha256 前 12 位", async () => {
    const res = await app.request("/api/skills/executor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      content: string;
    };
    expect(body.name).toBe("executor");
    expect(body.version).toMatch(/^[0-9a-f]{12}$/);
    // version 必须等于 SKILL.md 内容的哈希 —— 即「由文件内容算出、不依赖 git」。
    const expected = createHash("sha256")
      .update(body.content)
      .digest("hex")
      .slice(0, 12);
    expect(body.version).toBe(expected);
    // 其余字段未变(回归)
    expect(typeof body.content).toBe("string");
    expect(body.content).toContain("CoAgentHub Executor");
  });

  it("未知 skill 仍返回 404 且带 code(回归)", async () => {
    const res = await app.request("/api/skills/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GET /api/skills/:name/digest (R2)", () => {
  it("只回指纹、不下发全文", async () => {
    const res = await app.request("/api/skills/executor/digest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; version: string };
    expect(body.name).toBe("executor");
    expect(body.version).toMatch(/^[0-9a-f]{12}$/);
    expect((body as Record<string, unknown>).content).toBeUndefined();
  });

  it("digest 的 version 与完整接口一致", async () => {
    const full = await (await app.request("/api/skills/reviewer")).json();
    const digest = await (
      await app.request("/api/skills/reviewer/digest")
    ).json();
    expect((digest as { version: string }).version).toBe(
      (full as { version: string }).version,
    );
  });

  it("未知 skill 的 digest 也返回 404", async () => {
    const res = await app.request("/api/skills/nope/digest");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
