import { zValidator } from "@hono/zod-validator";
import {
  FileRefInput,
  GROUP_ROLES,
  GroupMessageAudienceInput,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import { maybeHandleControlCommand } from "@server/lib/control";
import type { DataBase } from "@server/lib/database";
import {
  EXEC_ALLOWED_ROLES,
  maybeDispatchExecutorTask,
  refreshA2AActivity,
} from "@server/lib/executor-task";
import { findExecutorByParticipantName } from "@server/lib/executors";
import type { ParticipantType } from "@server/lib/group-visibility";
import { resolveLocalUser } from "@server/lib/local-participant";
import {
  findMissingProjectDocs,
  handleSkillInstallConfirmation,
} from "@server/lib/participant-capabilities";
import {
  DELETED_MESSAGE_PLACEHOLDER,
  insertGroupMessage,
  listVisibleMessages,
  softDeleteMessage,
  updateMessageBody,
} from "@server/lib/services/message-service";
import { wsHub } from "@server/lib/ws-hub";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { assertGroupWritable } from "./helpers";

/**
 * 群消息子路由:发送 / 编辑 / 软删 / 列表(可见性过滤 + ?after= 增量拉取 +
 * q 搜索,分页逻辑在 message-service 内)。挂在 /api/groups 下
 * (路径 /:id/messages...),与拆分前完全一致。
 */

const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app
  .post(
    "/:id/messages",
    describeRoute({
      description:
        "Post a message to a group; sender must be a member. Messages carry a target audience (broadcast | role | participant) and an optional parentId for the thread tree",
      responses: {
        200: {
          description: "Message created with tree depth",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "json",
      z
        .object({
          // body 可空:纯文件信令消息允许 body 为空但携带 fileRef。
          // 输入上限(P0):发送 body 最多 8000 字符,防止局域网内一条超大
          // 请求打爆内存(编辑接口为 4000,见 PATCH /:id/messages/:messageId)。
          body: z.string().max(8000).optional(),
          parentId: z.string().uuid().optional(),
          // 兼容旧值:接受历史 audience "agent"(术语改名前的旧值,外部执行器
          // CLI 可能仍发送),归一为 "participant" 后存储与校验。
          audience: GroupMessageAudienceInput.optional(),
          audienceRef: z.string().optional(),
          // 内容类型 (ticket 17): 仅存储不校验 —— 不白名单、不解析;仅拒绝
          // 空串以免绕过 text/plain 默认值。
          contentType: z.string().min(1).optional(),
          // 规范驱动下发 (Spec-Driven Task Dispatch):可选字段,定向到执行器的
          // 消息可携带规范文档路径与版本哈希(≤500/≤64),任务行写入并拼进任务书
          // 「关联规范」段;不传 = 指令驱动任务,行为与旧版完全一致。
          specRef: z.string().max(500).optional(),
          specHash: z.string().max(64).optional(),
          // 任务下发者信息(Part A):只读取 metadata.dispatcherSessionId(≤200),
          // 其他 metadata 字段忽略,不影响任务创建;超长拒绝(400)。是否写入
          // 任务行由 handler 按发送者角色/身份判定(见下),此处只做格式约束。
          metadata: z
            .object({
              dispatcherSessionId: z.string().max(200).optional(),
            })
            .optional(),
          // callback 路由信息(Part B):可选,仅允许 { platform?, endpointRef?,
          // sessionRef? } 三个短字符串(≤200 字符),不得存 URL/token/命令/secret。
          // 仅 coordinator/human 非执行器发送者可携带(与 dispatcherSessionId
          // 同规则)。三个字段都缺省 = 无 callback,归一为 null。
          // strict():未知字段/嵌套对象直接拒绝(400),不允许静默剥离 ——
          // 未知字段可能是试图夹带 URL/凭据的旁路。
          callback: z
            .object({
              platform: z.string().max(200).optional(),
              endpointRef: z.string().max(200).optional(),
              sessionRef: z.string().max(200).optional(),
            })
            .strict()
            .optional(),
          // fileRef.expiresAt 可选由客户端传入;服务端缺省补 now + 7d (ticket 17)。
          // 输入上限(P0):name ≤255、fetchUrl ≤2048,超限校验返回 400。
          fileRef: FileRefInput.extend({
            name: z.string().min(1).max(255),
            fetchUrl: z.string().url().max(2048),
          }).optional(),
        })
        .refine((v) => (v.body?.trim()?.length ?? 0) > 0 || !!v.fileRef, {
          message: "body or fileRef must be provided",
        }),
    ),
    async (c) => {
      const db = c.get("db");
      const senderId = c.get("participantId");
      const { id } = c.req.valid("param");
      const {
        body,
        parentId,
        audience,
        audienceRef,
        contentType,
        fileRef,
        metadata,
        specRef,
        specHash,
        callback,
      } = c.req.valid("json");

      // Archive = read-only: an archived (or soft-deleted) group rejects new
      // messages with 403 + reason; reading (GET messages / GET members /
      // GET :id) stays open so history remains browsable.
      await assertGroupWritable(db, id);
      // The sender must be a group member (any role) to post.
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, senderId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      const aud = audience ?? "broadcast";
      if (aud === "role") {
        // audienceRef is the target role name; the preset catalog is the
        // source of truth for legal roles.
        if (
          !audienceRef ||
          !(GROUP_ROLES as readonly string[]).includes(audienceRef)
        ) {
          throw new BizError(BizCodeEnum.InvalidRequest);
        }
      } else if (aud === "participant") {
        // audienceRef must name a member of THIS group.
        if (!audienceRef) {
          throw new BizError(BizCodeEnum.InvalidRequest);
        }
        const target = await db.query.groupMember.findFirst({
          where: (t, { and, eq }) =>
            and(eq(t.groupId, id), eq(t.participantId, audienceRef)),
        });
        if (!target) {
          throw new BizError(BizCodeEnum.InvalidRequest);
        }
        // 任务发布门槛:定向到执行器 participant 的消息会触发任务创建,与
        // executor-task/桥同款角色校验 —— 非 coordinator/human 直接 403,
        // 避免"消息已写入但任务被静默跳过"造成插件误以为任务已下发。
        const targetParticipant = await db.query.participant.findFirst({
          where: (t, { eq: eqFn }) => eqFn(t.id, target.participantId),
        });
        const isExecutorTarget =
          targetParticipant !== undefined &&
          (await findExecutorByParticipantName(db, targetParticipant.name));
        if (
          isExecutorTarget &&
          !membership.roles.some((r) =>
            (EXEC_ALLOWED_ROLES as readonly string[]).includes(r),
          )
        ) {
          throw new BizError(
            BizCodeEnum.Forbidden,
            "无权限发布任务，请以 coordinator/human 身份绑定参与方",
          );
        }
      } else if (audienceRef) {
        // broadcast has no reference; a stray one is a client bug.
        throw new BizError(BizCodeEnum.InvalidRequest);
      }

      // Message + closure rows are written atomically (shared helper — the
      // executor runner's status replies reuse the exact same write path so
      // the two cannot drift): self row depth 0, one row per ancestor with
      // depth+1, depth check inside the transaction. A failure rolls back the
      // insert instead of leaving a committed message the client believes
      // failed.
      const full = await insertGroupMessage(db, {
        groupId: id,
        senderId,
        parentId: parentId ?? null,
        audience: aud,
        audienceRef:
          aud === "role" || aud === "participant"
            ? (audienceRef ?? null)
            : null,
        body: body ?? "",
        contentType: contentType ?? "text/plain",
        // 服务端必填 (ticket 17): 客户端未传 expiresAt 时默认 now + 7d;
        // 历史 fileRef 元信息随消息永久可见,过期只影响取文件。
        fileRef: fileRef ?? null,
      });

      // Realtime push (ticket 13): fire-and-forget — the WS hub catches its
      // own failures, so the fan-out cannot block the response; the ?after=
      // incremental pull remains the guaranteed fallback.
      void wsHub.broadcastGroupMessage(full);

      // skill 安装确认(skill 加载强化):识别 "✅ skill 已安装" 等确认消息,幂等
      // 更新发送者 capabilities。fire-and-forget,不匹配即静默返回,不阻塞消息。
      void handleSkillInstallConfirmation(db, senderId, body ?? "").catch((err) =>
        console.warn("[messages] skill 安装确认处理失败(忽略):", err),
      );

      // 第1层(A2A 进度信号):执行器 participant 在本群发的消息 → 刷新同群 running
      // 的 A2A 任务最近活跃时间,顺延无进展超时(纯内存同步操作,不阻塞响应;
      // 消息可以是普通广播消息,无需新协议)。
      refreshA2AActivity(id, senderId);

      // 阶段2-票1:定向到执行器 participant 的消息 → server 直接建 task + spawn
      // (fire-and-forget;命中与否/幂等/双跑防重都在 executor-task 内处理,
      // 失败只记日志,绝不阻塞消息响应)。
      if (aud === "participant" && audienceRef) {
        // 任务下发者信息(Part A)+ callback 路由(Part B)共用权限判定:仅
        // coordinator/human 且**非执行器 participant** 的发送者可携带
        // (与 dispatcherSessionId 同规则);执行器/observer 伪造一律丢弃。
        const senderParticipantForDispatcher = await db.query.participant.findFirst({
          where: (t, { eq }) => eq(t.id, senderId),
        });
        const senderIsExecutorForDispatcher =
          senderParticipantForDispatcher !== undefined &&
          (await findExecutorByParticipantName(db, senderParticipantForDispatcher.name));
        const canCarryDispatcher =
          membership.roles.some((r) =>
            (EXEC_ALLOWED_ROLES as readonly string[]).includes(r),
          ) && !senderIsExecutorForDispatcher;
        // Part A:dispatcher_session_id 仅 coordinator/human 且非执行器发送者
        // 可携带(执行器伪造 metadata 一律忽略),否则为 null。
        const rawSessionId = metadata?.dispatcherSessionId;
        const dispatcherSessionId =
          rawSessionId && canCarryDispatcher ? rawSessionId : null;
        // Part B:callback 路由信息 —— 三个字段均为可选、不超过 200 字符的非空
        // 字符串;拒绝未知字段、URL、命令、凭据、赋值形态或嵌套对象(400)。
        // 只提供 callback.sessionRef 时同步写入兼容字段 dispatcherSessionId;
        // 同时提供两者且不等 → 400。伪造(无权携带)时整个 callback 丢弃。
        const rawCallback = callback;
        let callbackRef: { platform?: string; endpointRef?: string; sessionRef?: string } | null = null;
        let callbackSessionId: string | null = null;
        if (rawCallback && canCarryDispatcher) {
          // 拒绝嵌套对象 / 非 string 字段:此处 zod 已约束为 string | undefined,
          // 只需过滤空串 + 拒绝非法内容。
          const strip = (s?: string) => (s && s.trim().length > 0 ? s.trim() : undefined);
          const platform = strip(rawCallback.platform);
          const endpointRef = strip(rawCallback.endpointRef);
          const sessionRef = strip(rawCallback.sessionRef);
          // 拒绝 URL、命令、凭据等非法内容(simple heuristic: 不能含空白或换行,
          // 不能以 http(s):// / ssh:// / ftp:// 等协议开头,不能含 $() 等 shell
          // 注入,不能是 key=value 赋值形态,不能含 token/secret/password/api key
          // /bearer/authorization/credential 等凭据关键词)。
          const FORBIDDEN_RE =
            /^https?:\/\/|^ssh:\/\/|^ftp:\/\/|\s|\$\(|`|&&|\|\||=|(?:token|secret|password|apikey|api[_-]?key|bearer|authorization|credential)/i;
          for (const [k, v] of Object.entries({ platform, endpointRef, sessionRef })) {
            if (!v) continue;
            if (FORBIDDEN_RE.test(v)) {
              throw new BizError(
                BizCodeEnum.InvalidRequest,
                `callback.${k} 含非法内容:不允许 URL、命令、凭据、赋值形态或空白`,
              );
            }
          }
          if (platform || endpointRef || sessionRef) {
            callbackRef = { platform, endpointRef, sessionRef };
            callbackSessionId = sessionRef ?? null;
          }
          // 冲突:同时提供 dispatcherSessionId 与 callback.sessionRef 且不等 → 400。
          if (callbackSessionId !== null && rawSessionId && callbackSessionId !== rawSessionId) {
            throw new BizError(
              BizCodeEnum.InvalidRequest,
              "callback.sessionRef 与 dispatcherSessionId 冲突:两者必须相等",
            );
          }
        }
        // 兼容字段:只提供 callback.sessionRef 时同步写入 dispatcherSessionId;
        // 否则沿用 metadata.dispatcherSessionId(未携带/伪造时为 null)。
        const finalDispatcherSessionId = callbackSessionId ?? dispatcherSessionId;
        // 首次任务初始化检查(项目脚手架):当消息触发任务(即即将调用
        // maybeDispatchExecutorTask)且群绑定了 projectPath 时,检查 Matt 文档
        // 脚手架;缺失则响应 header 返回 warning(不阻塞消息发送/任务下发)。
        const group = await assertGroupWritable(db, id);
        if (group.projectPath) {
          const missing = await findMissingProjectDocs(group.projectPath);
          if (missing.length > 0) {
            c.header(
              "X-Project-Init-Warning",
              `PROJECT_NOT_INITIALIZED:${missing.join(",")}`,
            );
          }
        }
        void maybeDispatchExecutorTask(db, {
          groupId: id,
          messageId: full.id,
          senderRoles: membership.roles,
          audienceRef,
          body: body ?? "",
          dispatcherParticipantId: senderId,
          dispatcherSessionId: finalDispatcherSessionId,
          specRef: specRef ?? null,
          specHash: specHash ?? null,
          callbackRef,
        }).catch((err) => console.warn("[executor] 后台调度失败(忽略):", err));
      }
      // 阶段2-票2:控制指令(「停止/stop」「回滚 [taskId]」)识别放 server;
      // fire-and-forget,命中与否/权限/防回环在 control.ts 内处理。定向到
      // 执行器 participant 的消息是任务,控制入口内部会跳过,不重复动作。
      void maybeHandleControlCommand(db, {
        groupId: id,
        senderId,
        senderRoles: membership.roles,
        audience: aud,
        audienceRef: aud === "participant" ? (audienceRef ?? null) : null,
        body: body ?? "",
      }).catch((err) => console.warn("[control] 后台指令处理失败(忽略):", err));

      return c.json(full);
    },
  )
  .patch(
    "/:id/messages/:messageId",
    describeRoute({
      description:
        "Edit a message body (ticket 22): sender-only, body 1..4000 chars; parentId/audience/depth are immutable. Returns the updated full row",
      responses: {
        200: {
          description: "Message updated",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), messageId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z.object({
        // 编辑只允许改正文;parentId/audience/depth 保持创建时的值。
        body: z
          .string()
          .min(1)
          .max(4000)
          // 删除占位串是软删除标记(与 DELETE 共用),不允许被当作正文写入,
          // 否则一条真实消息会永久显示为「已删除」且无法再编辑。
          .refine((s) => s !== DELETED_MESSAGE_PLACEHOLDER, {
            message: "该正文为删除占位,不可用作消息内容",
          }),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const participantId = c.get("participantId");
      const { id, messageId } = c.req.valid("param");
      const { body } = c.req.valid("json");

      // 归档/软删群组只读(与 POST 同款守卫):历史可读,但不可再修改。
      await assertGroupWritable(db, id);
      // 发送者必须是当前群成员(与 POST 同款守卫):被移出后不能再编辑旧消息。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, participantId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const message = await db.query.groupMessage.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, messageId), eq(t.groupId, id)),
      });
      if (!message) {
        throw new BizError(BizCodeEnum.MessageNotFound);
      }
      // 仅发送者本人可编辑自己的消息。
      if (message.senderId !== participantId) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      // 已软删除的消息不可再编辑:占位 body 是删除标记,改回正文等于复活,
      // 与「删除后不可恢复」的产品契约相悖。
      if (message.body === DELETED_MESSAGE_PLACEHOLDER) {
        throw new BizError(BizCodeEnum.InvalidRequest);
      }

      // 编辑写入在 message-service 内完成(仅 UPDATE + 返回全量行);
      // 发送者/群状态/占位串等校验已在上方完成,错误码与响应结构不变。
      const updated = await updateMessageBody(db, id, messageId, body);
      // Realtime push (ticket 22): same fire-and-forget semantics as POST.
      void wsHub.broadcastGroupMessageUpdated(updated);
      return c.json(updated);
    },
  )
  .delete(
    "/:id/messages/:messageId",
    describeRoute({
      description:
        "Soft-delete a message (ticket 22): body becomes the placeholder so the closure/reply tree stays intact; idempotent — deleting an already-deleted message still succeeds",
      responses: {
        200: {
          description: "Message soft-deleted",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), messageId: z.string().uuid() }),
    ),
    async (c) => {
      const db = c.get("db");
      const participantId = c.get("participantId");
      const { id, messageId } = c.req.valid("param");

      // 归档/软删群组只读(与 POST 同款守卫):历史可读,但不可再修改。
      await assertGroupWritable(db, id);
      // 发送者必须是当前群成员(与 POST 同款守卫):被移出后不能再删除旧消息。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, participantId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const message = await db.query.groupMessage.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, messageId), eq(t.groupId, id)),
      });
      if (!message) {
        throw new BizError(BizCodeEnum.MessageNotFound);
      }
      // 仅发送者本人可删除自己的消息。
      if (message.senderId !== participantId) {
        throw new BizError(BizCodeEnum.Forbidden);
      }

      // 软删除(占位符 + 保持闭包)在 message-service 内完成,返回是否真的
      // 执行了删除:幂等场景(已删过)不再重复广播,响应结构均为 success。
      const deleted = await softDeleteMessage(db, id, messageId);
      if (deleted) {
        // Realtime push (ticket 22): the event carries only the id; visibility
        // reuses the message's own audience, so the same members that saw the
        // original get the delete.
        void wsHub.broadcastGroupMessageDeleted({
          id: message.id,
          groupId: message.groupId,
          senderId: message.senderId,
          audience: message.audience,
          audienceRef: message.audienceRef,
        });
      }
      return c.json({ success: true });
    },
  )
  .get(
    "/:id/messages",
    describeRoute({
      description:
        "List messages visibility-filtered for the caller, ordered by receive time; pass ?after=<messageId> for incremental pulls (id > after)",
      responses: {
        200: {
          description: "Visible messages with tree depth",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "query",
      z.object({
        after: z.string().uuid().optional(),
        // 消息搜索(enhancement):正文关键词,LIKE 通配符(%、_)按字面转义;
        // 空串视为无搜索。上限 200 字符防止超长模式串。
        q: z.string().max(200).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const requesterId = c.get("participantId");
      const { id } = c.req.valid("param");
      const { after, q } = c.req.valid("query");

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, requesterId)),
      });
      // LAN trust model: reading a group does not require membership. The
      // default Local User counts as human (sees everything) — even when it
      // holds a membership row (e.g. it created the group tokenless and was
      // auto-inserted as coordinator); participantType keeps that human bypass,
      // so pull matches the WS fan-out. Any other non-member sees broadcast + own.
      const localUserId = await resolveLocalUser(db);
      const participantType: ParticipantType | undefined =
        requesterId === localUserId ? "human" : undefined;
      const requesterRoles = membership?.roles ?? [];

      // 可见性 SQL(与 webhook/WS 扇出同一套规则)+ ?after= 增量游标 +
      // q 关键词 + LIMIT 整体在 message-service 内完成,翻页发生在
      // *可见* 流上;路由只做响应编排。
      const messages = await listVisibleMessages(
        db,
        id,
        requesterId,
        requesterRoles,
        {
          after,
          q,
          participantType,
        },
      );

      return c.json(messages);
    },
  );

export default app;
