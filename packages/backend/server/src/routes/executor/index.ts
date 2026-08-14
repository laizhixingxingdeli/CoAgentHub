import { zValidator } from "@hono/zod-validator";
import { participant as participantTable } from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import db, { type DataBase } from "@server/lib/database";
import {
  addExecutorConfig,
  effectiveExecutors,
  findExecutorByKey,
  isBuiltinExecutorKey,
  registerExecutorParticipant,
  removeExecutorConfig,
  updateExecutorConfig,
} from "@server/lib/executors";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

/**
 * 执行器配置管理(接入 Participant 界面):GET/POST/DELETE/PATCH /api/executors。
 *
 * 无鉴权(局域网信任模型,与 participant 注册一致):LAN 内任何客户端
 * 都能读取/新增/删除/编辑执行器配置。新增时自动注册对应 participant(名字=agentName;
 * token 认证已移除,不再生成 token)。
 *
 * 内置执行器(DEFAULT_EXECUTORS)不落 DB:GET 合并展示,DELETE/PATCH 对内置 key
 * 直接拒绝(409/403),避免误删/误改默认执行器。
 */
const app = new Hono<{ Variables: { db: DataBase } }>();

app.use(async (c, next) => {
  c.set("db", db);
  await next();
});

/** POST 入参:与前端「接入 Participant」表单一致。 */
const CreateExecutorSchema = z
  .object({
    /** participant 展示名(唯一;同时是注册进 participant 表的 name)。 */
    agentName: z.string().min(1).max(100),
    /** 类型:executor_config 展示元数据;缺省 "custom"(participant.type 已移除)。 */
    type: z.string().min(1).optional(),
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
    /** 设备(可选):注册 participant 时写入 participant.device。 */
    device: z.string().max(100).optional(),
    /** 执行器默认模型(args 模板 {model} 占位);可空。 */
    model: z.string().max(200).nullable().optional(),
    /** 记忆模式:仅 "per-group" 启用按群 contextId 延续;缺省无记忆。 */
    memory: z.enum(["per-group"]).nullable().optional(),
  })
  .refine((v) => (v.kind === "a2a" ? !!v.url : !!v.bin), {
    message: "kind=a2a 需要 url,kind=cli 需要 bin",
  })
  .refine((v) => v.memory === undefined || v.kind === "a2a", {
    message: "memory 仅对 kind=a2a 执行器生效",
  });

const app2 = app
  .post(
    "/",
    describeRoute({
      description:
        "Create an executor config and auto-register its participant (no token involved; identity is claimed via X-Participant-Id)",
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
      const { agentName, kind, bin, url, args, label, device, model, memory } =
        input;
      // participant.type 已移除;type 仅作 executor_config 展示元数据,缺省 custom。
      const type = input.type ?? "custom";

      // 名字唯一:内置 + DB 里已有同名 participant 都算重复(按 agentName 判重)。
      const all = await effectiveExecutors(db);
      if (all.some((ex) => ex.agentName === agentName)) {
        throw new BizError(
          BizCodeEnum.Conflict,
          `participant 名字已存在: ${agentName}`,
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
        model,
        memory,
      };

      await addExecutorConfig(db, config);

      // 自动注册对应 participant(token 认证已移除,不再生成/写 state 文件)。
      await registerExecutorParticipant(
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
        model: model ?? null,
        memory: memory ?? null,
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
          model: ex.model ?? null,
          memory: ex.memory ?? null,
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
  )
  .patch(
    "/:key",
    describeRoute({
      description:
        "Partially update an executor config by key (bin/args/model/device/agentName); built-in executors are refused (403); key is immutable (400); unknown key 404. device changes sync to the registered participant (name changes do NOT rename the participant — recorded only)",
      responses: {
        200: {
          description: "Config updated",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ key: z.string().min(1) })),
    zValidator(
      "json",
      z
        .object({
          // key 不可改:请求体出现 key 即拒绝(由处理器抛 400)。
          key: z.string().optional(),
          agentName: z.string().min(1).max(100).optional(),
          bin: z.string().min(1).optional(),
          args: z.array(z.string()).max(64).optional(),
          label: z.string().max(100).optional(),
          // null = 清空(与 POST 缺省归一为 null 一致)。
          model: z.string().max(200).nullable().optional(),
          memory: z.enum(["per-group"]).nullable().optional(),
          device: z.string().max(100).nullable().optional(),
        })
        .refine(
          (v) =>
            v.agentName !== undefined ||
            v.bin !== undefined ||
            v.args !== undefined ||
            v.label !== undefined ||
            v.model !== undefined ||
            v.memory !== undefined ||
            v.device !== undefined,
          { message: "at least one field to update is required" },
        ),
    ),
    async (c) => {
      const db = c.get("db");
      const { key } = c.req.valid("param");
      const input = c.req.valid("json");

      // key 不可改:请求体带 key 字段直接拒绝(避免"换 key"语义)。
      if (input.key !== undefined) {
        throw new BizError(BizCodeEnum.InvalidRequest, "执行器 key 不可修改");
      }

      // 内置执行器不落 DB,不可编辑(与 DELETE 的 409 不同,编辑用 403)。
      if (isBuiltinExecutorKey(key)) {
        throw new BizError(BizCodeEnum.Forbidden, `内置执行器不可编辑: ${key}`);
      }

      const existing = await findExecutorByKey(db, key);
      if (!existing) {
        throw new BizError(BizCodeEnum.ExecutorNotFound);
      }

      // memory 仅对 kind=a2a 执行器生效(cli 无 contextId 延续,设了也是静默
      // 无效,直接拒绝避免误导)。
      if (input.memory !== undefined && existing.kind !== "a2a") {
        throw new BizError(
          BizCodeEnum.InvalidRequest,
          "memory 仅对 kind=a2a 执行器生效",
        );
      }

      // 改名唯一性:内置 + DB 已有同名 participant 都算重复(与 POST 同判重)。
      if (
        input.agentName !== undefined &&
        input.agentName !== existing.agentName
      ) {
        const all = await effectiveExecutors(db);
        if (
          all.some((ex) => ex.key !== key && ex.agentName === input.agentName)
        ) {
          throw new BizError(
            BizCodeEnum.Conflict,
            `participant 名字已存在: ${input.agentName}`,
          );
        }
      }

      const updated = await updateExecutorConfig(db, key, {
        agentName: input.agentName,
        bin: input.bin,
        args: input.args,
        label: input.label,
        model: input.model,
        memory: input.memory,
      });
      if (!updated) {
        throw new BizError(BizCodeEnum.ExecutorNotFound);
      }

      // device 同步到已注册 participant(按配置的 agentName 匹配——简化:改名不
      // 自动改 participant 名,仅记录,避免误伤;device 仍落到原 participant)。
      if (input.device !== undefined) {
        await db
          .update(participantTable)
          .set({ device: input.device })
          .where(eq(participantTable.name, existing.agentName));
      }

      return c.json({
        key: updated.key,
        agentName: updated.agentName,
        type: updated.type,
        kind: updated.kind,
        bin: updated.bin,
        url: updated.url ?? null,
        args: updated.args,
        label: updated.label,
        model: updated.model ?? null,
        memory: updated.memory ?? null,
        builtin: false,
      });
    },
  );

export default app2;
