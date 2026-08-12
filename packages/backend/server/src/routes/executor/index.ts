import { zValidator } from "@hono/zod-validator";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import db, { type DataBase } from "@server/lib/database";
import {
  addExecutorConfig,
  effectiveExecutors,
  isBuiltinExecutorKey,
  registerExecutorAgent,
  removeExecutorConfig,
} from "@server/lib/executors";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

/**
 * 执行器配置管理(接入 Agent 界面):GET/POST/DELETE /api/executors。
 *
 * 无鉴权(局域网信任模型,与 agent 注册/reset-token 一致):LAN 内任何客户端
 * 都能读取/新增/删除执行器配置。新增时自动注册对应 agent(名字=agentName,
 * token 后端生成写 scripts/.executor-agents.json,绝不返回前端)。
 *
 * 内置执行器(DEFAULT_EXECUTORS)不落 DB:GET 合并展示,DELETE 对内置 key
 * 直接拒绝(409),避免误删默认执行器。
 */
const app = new Hono<{ Variables: { db: DataBase } }>();

app.use(async (c, next) => {
  c.set("db", db);
  await next();
});

/** POST 入参:与前端「接入 Agent」表单一致,前端不感知 token。 */
const CreateExecutorSchema = z
  .object({
    /** agent 展示名(唯一;同时是注册进 agent 表的 name)。 */
    agentName: z.string().min(1).max(100),
    /** 类型:hermes | atomcode | openclaw | human | custom */
    type: z.string().min(1),
    /** 调用方式:cli=本地 spawn / a2a=经 A2A gateway 远程调用。 */
    kind: z.enum(["cli", "a2a"]),
    /** cli 的执行命令(a2a 时可为空,仅占位标识)。 */
    bin: z.string().min(1).optional(),
    /** a2a 的 gateway 基地址。 */
    url: z.string().url().optional(),
    /** cli 的参数模板,如 ["-y","-p","{ticket}"];可空。 */
    args: z.array(z.string()).max(64).optional(),
    /** 展示标签,缺省用 agentName。 */
    label: z.string().max(100).optional(),
    /** 设备(可选):注册 agent 时写入 agent.device。 */
    device: z.string().max(100).optional(),
  })
  .refine(
    (v) => (v.kind === "a2a" ? !!v.url : !!v.bin),
    { message: "kind=a2a 需要 url,kind=cli 需要 bin" },
  );

const app2 = app
  .post(
    "/",
    describeRoute({
      description:
        "Create an executor config and auto-register its agent (no token in response; the token is written once to scripts/.executor-agents.json)",
      responses: {
        200: {
          description: "Executor config created (token never exposed)",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("json", CreateExecutorSchema),
    async (c) => {
      const db = c.get("db");
      const input = c.req.valid("json");
      const { agentName, type, kind, bin, url, args, label, device } = input;

      // 名字唯一:内置 + DB 里已有同名 agent 都算重复(按 agentName 判重)。
      const all = await effectiveExecutors(db);
      if (all.some((ex) => ex.agentName === agentName)) {
        throw new BizError(
          BizCodeEnum.Conflict,
          `agent 名字已存在: ${agentName}`,
        );
      }

      // 生成唯一 key:agentName 的 slug,冲突时追加序号(内置 key 也参与判重)。
      const slug =
        agentName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "executor";
      const taken = new Set(all.map((ex) => ex.key));
      let key = slug;
      let n = 2;
      while (taken.has(key)) key = `${slug}-${n++}`;

      const config = {
        key,
        agentName,
        type,
        kind,
        bin: bin ?? (kind === "a2a" ? agentName : ""),
        url: url ?? undefined,
        args: args ?? [],
        label: label ?? agentName,
        device,
      };

      await addExecutorConfig(db, config);

      // 自动注册对应 agent(token 后端生成写 state 文件,不返回前端)。
      await registerExecutorAgent(
        db,
        {
          key,
          agentName,
          type,
          kind,
          bin: config.bin,
          url: config.url,
          args: config.args,
          label: config.label,
        },
        undefined,
        device,
      );

      return c.json({
        key,
        agentName,
        type,
        kind,
        bin: config.bin,
        url: url ?? null,
        args: config.args,
        label: config.label,
        device: device ?? null,
      });
    },
  )
  .get(
    "/",
    describeRoute({
      description:
        "List all executors (built-in defaults merged with DB configs; tokenHash/token never exposed)",
      responses: {
        200: {
          description: "Successful response",
          content: { "application/json": {} },
        },
      },
    }),
    async (c) => {
      const db = c.get("db");
      const all = await effectiveExecutors(db);
      return c.json(
        all.map((ex) => ({
          key: ex.key,
          agentName: ex.agentName,
          type: ex.type,
          kind: ex.kind ?? "cli",
          bin: ex.bin,
          url: ex.url ?? ex.a2a?.url ?? null,
          args: ex.args,
          label: ex.label,
          builtin: isBuiltinExecutorKey(ex.key),
        })),
      );
    },
  )
  .delete(
    "/:key",
    describeRoute({
      description:
        "Delete an executor config by key; built-in executors are refused (409)",
      responses: {
        200: {
          description: "Config deleted",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ key: z.string().min(1) })),
    async (c) => {
      const db = c.get("db");
      const { key } = c.req.valid("param");

      // 内置执行器不可删除(不在 DB,删了也只是空操作,直接拒绝)。
      if (isBuiltinExecutorKey(key)) {
        throw new BizError(BizCodeEnum.Conflict, `内置执行器不可删除: ${key}`);
      }

      const removed = await removeExecutorConfig(db, key);
      if (!removed) {
        throw new BizError(BizCodeEnum.ExecutorNotFound);
      }
      return c.json({ success: true, key });
    },
  );

export default app2;
