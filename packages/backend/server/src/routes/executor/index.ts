import { zValidator } from "@hono/zod-validator";
import { participant as participantTable } from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import db, { type DataBase } from "@server/lib/database";
import { resolveBin } from "@server/lib/exec-bin";
import { executorAvailability } from "@server/lib/executor-availability";
import {
  EXECUTOR_CONFIG_FIELD_CAPABILITIES,
  inputModeWriteError,
} from "@server/lib/executor-config-fields";
import {
  addExecutorConfig,
  effectiveExecutors,
  findExecutorByKey,
  registerExecutorParticipant,
  removeExecutorConfig,
  updateExecutorConfig,
} from "@server/lib/executors";
import { clearExecutorCooldown } from "@server/lib/executor-task/queue";
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
 * 全部配置都落 DB(executor_config 唯一真相源;无代码内置、无迁移播种,
 * specs/no-builtin-executor-seeding.md):GET 直接返回 DB 行(零配置时为 []),
 * 不再有内置 key,因此 DELETE/PATCH 对所有 key 一律放行。
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
    /** 默认分工说明(接入时填一次):可空,最长 1000(与 group_members.prompt 一致)。 */
    prompt: z.string().max(1000).optional(),
    /** 同一执行器最大并发 running 任务数;null = 不限制(缺省行为不变)。 */
    maxConcurrency: z.number().int().positive().nullable().optional(),
    /** 任务书传递方式;能力表见 EXECUTOR_CONFIG_FIELD_CAPABILITIES.inputMode。 */
    inputMode: z
      .enum(["path", "inline", "at-file", "stdin"])
      .nullable()
      .optional(),
    /** spawn 叠加 env;能力表见 EXECUTOR_CONFIG_FIELD_CAPABILITIES.env。 */
    env: z.record(z.string(), z.string()).nullable().optional(),
    /** 输出画像(reserved,只存不读);见 EXECUTOR_CONFIG_FIELD_CAPABILITIES.outputProfile。 */
    outputProfile: z.unknown().nullable().optional(),
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
      const {
        agentName,
        kind,
        bin,
        url,
        args,
        label,
        device,
        model,
        memory,
        prompt,
        maxConcurrency,
        inputMode,
        env,
        outputProfile,
      } = input;
      // participant.type 已移除;type 仅作 executor_config 展示元数据,缺省 custom。
      const type = input.type ?? "custom";

      // 未实现的 inputMode 取值拒绝写入(R2);存量不追溯,只拦新写入。
      const modeErr = inputModeWriteError(inputMode ?? null);
      if (modeErr) {
        throw new BizError(BizCodeEnum.InvalidRequest, modeErr);
      }

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
        prompt,
        maxConcurrency,
        inputMode,
        env,
        outputProfile,
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
        prompt: prompt ?? null,
        maxConcurrency: maxConcurrency ?? null,
        inputMode: inputMode ?? null,
        env: env ?? null,
        outputProfile: outputProfile ?? null,
      });
    },
  )
  .get(
    "/",
    describeRoute({
      description:
        "List all executors (DB configs; tokenHash/token never exposed)",
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
      const recentTasks = await db.query.task.findMany({
        columns: { executorKey: true, status: true, diffSummary: true },
        orderBy: (t, { desc: descFn }) => [descFn(t.createdAt)],
      });
      const zeroOutputCounts = new Map<string, number>();
      const streaks = new Map<string, number>();
      const streakClosed = new Set<string>();
      for (const task of recentTasks) {
        if (!task.executorKey) continue;
        if (streakClosed.has(task.executorKey)) continue;
        const summary =
          task.diffSummary &&
          typeof task.diffSummary === "object" &&
          !Array.isArray(task.diffSummary)
            ? (task.diffSummary as Record<string, unknown>)
            : null;
        const next =
          task.status === "failed" && summary?.zeroOutput === true
            ? (streaks.get(task.executorKey) ?? 0) + 1
            : 0;
        streaks.set(task.executorKey, next);
        if (next === 0) {
          zeroOutputCounts.set(task.executorKey, 0);
          streakClosed.add(task.executorKey);
        } else {
          zeroOutputCounts.set(task.executorKey, next);
        }
      }
      return c.json(
        all.map((ex) => {
          // R1:每条恒含可用性字段(available/unavailableReason/cooldownEndMs +
          // R3 cooldownSource),追加在既有字段之后,既有字段与顺序逐字不变;
          // 判定与文案全部来自 executor-availability.ts 的权威导出,路由不写第二套。
          const availability = executorAvailability({
            ...ex,
            zeroOutputCount: zeroOutputCounts.get(ex.key) ?? 0,
          });
          return {
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
            prompt: ex.prompt ?? null,
            maxConcurrency: ex.maxConcurrency ?? null,
            inputMode: ex.inputMode ?? null,
            env: ex.env ?? null,
            outputProfile: ex.outputProfile ?? null,
            available: availability.available,
            unavailableReason: availability.unavailableReason,
            cooldownEndMs: availability.cooldownEndMs,
            cooldownSource: availability.cooldownSource,
          };
        }),
      );
    },
  )
  .get(
    "/check-bin",
    describeRoute({
      description:
        "Probe whether a command name (resolved via the server's PATH) or an absolute path points at an executable file on the server; read-only, never executes the input",
      responses: {
        200: {
          description: "Probe result { found, resolvedPath }",
          content: { "application/json": {} },
        },
      },
    }),
    // 只读探测:GET + query 参数,不落库、不执行任何命令。
    zValidator(
      "query",
      z.object({
        bin: z
          .string()
          .min(1, "bin 不能为空")
          .max(200, "bin 长度不能超过 200")
          .refine((v) => !v.includes("\0"), "bin 不能包含 null 字节"),
      }),
    ),
    async (c) => {
      const { bin } = c.req.valid("query");
      const resolvedPath = resolveBin(bin);
      return c.json({ found: resolvedPath !== null, resolvedPath });
    },
  )
  // R1:字段能力表唯一 HTTP 出口 —— 与 executor-config-fields.ts 同源,不复制取值。
  .get(
    "/field-capabilities",
    describeRoute({
      description:
        "Executor config field capability table (supported/reserved/unimplemented); single source mirrored from EXECUTOR_CONFIG_FIELD_CAPABILITIES",
      responses: {
        200: {
          description: "Capability table",
          content: { "application/json": {} },
        },
      },
    }),
    async (c) => c.json(EXECUTOR_CONFIG_FIELD_CAPABILITIES),
  )
  // R4(specs/quota-misclassified-from-coordinator-narration.md):手动清除执行器
  // 额度冷却 —— 内存登记/到期定时器与持久化标记(task.diffSummary)同清并泵队列;
  // 无冷却时 404,与 DELETE 配置同款(BizError ExecutorNotFound)。注册在 "/:key"
  // 之前,路径段数不同不会互抢,但读序上先具体后参数更直观。
  .delete(
    "/:key/cooldown",
    describeRoute({
      description:
        "R4: clear an executor's quota cooldown (in-memory entry, expiry timer and persisted task marker); 404 when no active cooldown",
      responses: {
        200: { description: "Cooldown cleared", content: { "application/json": {} } },
        404: { description: "No active cooldown", content: { "application/json": {} } },
      },
    }),
    zValidator("param", z.object({ key: z.string().min(1) })),
    async (c) => {
      const db = c.get("db");
      const { key } = c.req.valid("param");
      const result = await clearExecutorCooldown(db, key);
      if (!result.cleared) {
        // 与 DELETE /:key 同语义:目标不存在。执行器配置本身可能仍在,
        // 但「没有可清除的冷却」对调用方而言等价于目标缺失。
        throw new BizError(BizCodeEnum.ExecutorNotFound);
      }
      return c.json({ success: true, key, taskIds: result.taskIds });
    },
  )
  .delete(
    "/:key",
    describeRoute({
      description:
        "Delete an executor config by key (all keys deletable — no built-ins)",
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
        "Partially update an executor config by key (bin/args/model/device/agentName); key is immutable (400); unknown key 404. device changes sync to the registered participant (name changes do NOT rename the participant — recorded only)",
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
          // 默认分工说明:空字符串表示清空(与 members.ts 的 PATCH 语义一致)。
          prompt: z.string().max(1000).optional(),
          maxConcurrency: z.number().int().positive().nullable().optional(),
          inputMode: z
            .enum(["path", "inline", "at-file", "stdin"])
            .nullable()
            .optional(),
          env: z.record(z.string(), z.string()).nullable().optional(),
          outputProfile: z.unknown().nullable().optional(),
        })
        .refine(
          (v) =>
            v.agentName !== undefined ||
            v.bin !== undefined ||
            v.args !== undefined ||
            v.label !== undefined ||
            v.model !== undefined ||
            v.memory !== undefined ||
            v.device !== undefined ||
            v.prompt !== undefined ||
            v.maxConcurrency !== undefined ||
            v.inputMode !== undefined ||
            v.env !== undefined ||
            v.outputProfile !== undefined,
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

      // 未实现的 inputMode 取值拒绝写入(R2);存量不追溯,只拦新写入。
      if (input.inputMode !== undefined) {
        const modeErr = inputModeWriteError(input.inputMode);
        if (modeErr) {
          throw new BizError(BizCodeEnum.InvalidRequest, modeErr);
        }
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
        prompt: input.prompt,
        maxConcurrency: input.maxConcurrency,
        inputMode: input.inputMode,
        env: input.env,
        outputProfile: input.outputProfile,
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
        prompt: updated.prompt ?? null,
        maxConcurrency: updated.maxConcurrency ?? null,
        inputMode: updated.inputMode ?? null,
        env: updated.env ?? null,
        outputProfile: updated.outputProfile ?? null,
      });
    },
  );

export default app2;
