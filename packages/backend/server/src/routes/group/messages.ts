import { zValidator } from "@hono/zod-validator";
import {
  type CoordinationPayload,
  FileRefInput,
  GROUP_ROLES,
  GroupMessageAudienceInput,
  parseKnownCoordinationPayload,
  REVIEW_REQUEST_EXAMPLE,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import {
  isControlCommand,
  isExecutorTaskTarget,
  maybeHandleControlCommand,
} from "@server/lib/control";
import type { DataBase } from "@server/lib/database";
import {
  DISPATCH_ALLOWED_ROLES,
  dispatchAndSettleIntent,
  inferSupersedesTaskId,
  isReviewerNotDispatchableTarget,
  payloadFromDispatchInput,
  refreshA2AActivity,
  writeDispatchIntent,
} from "@server/lib/executor-task";
import { findExecutorByParticipant } from "@server/lib/executors";
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
import { assertClaimedSenderExists } from "@server/lib/unknown-participant";
import { wsHub } from "@server/lib/ws-hub";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  assertGroupWritable,
  assertMemberCanPostMessage,
  assertMemberNotHuman,
  assertSupersededTaskInGroup,
} from "./helpers";

/**
 * 群消息子路由:发送 / 编辑 / 软删 / 列表(可见性过滤 + ?after= 增量拉取 +
 * q 搜索,分页逻辑在 message-service 内)。挂在 /api/groups 下
 * (路径 /:id/messages...),与拆分前完全一致。
 */

const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

type ReviewResultPayload = Extract<
  CoordinationPayload,
  { type: "review_result" }
>;

function renderFindingsTaskBrief(
  payload: ReviewResultPayload,
  originalBody: string,
): string {
  const findings = payload.findings
    .map(
      (finding, index) =>
        `${index + 1}. severity: ${finding.severity}\nnote: ${finding.note}`,
    )
    .join("\n");
  return [
    "L3 检视发现项：请协调者处理以下 findings",
    "",
    findings,
    "",
    "原始 review_result：",
    originalBody,
  ].join("\n");
}

function assertFindingsReviewResultDispatch(
  payload: CoordinationPayload | undefined,
  options: {
    audience: "broadcast" | "role" | "participant";
    audienceRef?: string;
    targetRoles?: string[];
    specRef?: string;
    specHash?: string;
  },
): void {
  if (payload?.type !== "review_result" || payload.verdict !== "findings") {
    return;
  }

  const targetedToCoordinator =
    (options.audience === "role" && options.audienceRef === "coordinator") ||
    (options.audience === "participant" &&
      options.targetRoles?.includes("coordinator"));
  if (
    !targetedToCoordinator ||
    !options.specRef?.trim() ||
    !options.specHash?.trim()
  ) {
    throw new BizError(
      BizCodeEnum.InvalidRequest,
      "review_result verdict=findings 必须定向到 coordinator(role:coordinator 或 coordinator participant)，并携带 specRef + specHash",
    );
  }
}

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
          dispatchKind: z.enum(["requirement", "fix"]).optional(),
          // 替代关系(executor-switch-task-identity R2):本任务替代
          // supersedesTaskId 所指的那次尝试;指向的任务必须属于同一群组(否则
          // 400,见 assertSupersededTaskInGroup),不校验其是否已终态。不传 =
          // null。
          supersedesTaskId: z.string().uuid().optional(),
          // 任务下发者信息(Part A):只读取 metadata.dispatcherSessionId(≤200),
          // 其他 metadata 字段忽略,不影响任务创建;超长拒绝(400)。是否写入
          // 任务行由 handler 按发送者角色/身份判定(见下),此处只做格式约束。
          metadata: z
            .object({
              dispatcherSessionId: z.string().max(200).optional(),
              // 调用方可主动说明为什么选中该目标;平台只审计原文,绝不从
              // task body 推断或补写理由。
              selectionReason: z.string().min(1).max(500).optional(),
            })
            .optional(),
          // callback 路由信息(Part B):可选,仅允许 { platform?, endpointRef?,
          // sessionRef? } 三个短字符串(≤200 字符),不得存 URL/token/命令/secret。
          // 仅群内角色命中 DISPATCH_ALLOWED_ROLES 的发送者可携带
          // (与 dispatcherSessionId 同规则)。三个字段都缺省 = 无 callback,
          // 归一为 null。
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
        dispatchKind,
        supersedesTaskId,
        callback,
      } = c.req.valid("json");
      const aud = audience ?? "broadcast";

      // 协作载荷校验(R1/R2,specs/l3-verdict-observability.md):所有消息正文
      // 都经过共享解析器,因此人读的 markdown 标题 + fenced JSON 也能触发
      // 已知载荷校验;自由文本 / 未知 type 的 JSON → undefined,原样放行。
      let parsed: CoordinationPayload | undefined;
      if (body !== undefined) {
        try {
          parsed = parseKnownCoordinationPayload(body ?? "");
        } catch (error) {
          const detail =
            error instanceof z.ZodError ? error.message : String(error);
          throw new BizError(
            BizCodeEnum.InvalidRequest,
            `协作载荷形状无效: ${detail}。review_request 期望示例: ${JSON.stringify(REVIEW_REQUEST_EXAMPLE)}`,
          );
        }
        // R2:review_result 引用的 taskId 必须指向本群一条真实任务。拼错 taskId
        // 是静默失败的头号来源(需求永远显示「L3 进行中」),此校验把静默失败变成
        // 即时失败。不校验该任务是否带 review_request(检视者主动治理合法)。
        // taskId 非 UUID 时不可能指向本群任何任务(uuid 主键),先按不存在处理,
        // 避免 uuid 列与非法字符串比较触发 DB 错误(500)。
        if (parsed?.type === "review_result") {
          const reviewResult = parsed;
          const taskIdIsUuid = z
            .string()
            .uuid()
            .safeParse(reviewResult.taskId).success;
          const referenced = taskIdIsUuid
            ? await db.query.task.findFirst({
                where: (t, { and: andFn, eq: eqFn }) =>
                  andFn(eqFn(t.groupId, id), eqFn(t.id, reviewResult.taskId)),
                columns: { id: true },
              })
            : undefined;
          if (!referenced) {
            throw new BizError(
              BizCodeEnum.InvalidRequest,
              "review_result 引用的 taskId 在本群不存在",
            );
          }
        }
      }

      // Archive = read-only: an archived (or soft-deleted) group rejects new
      // messages with 403 + reason; reading (GET messages / GET members /
      // GET :id) stays open so history remains browsable. 群行在此取一次并
      // 贯穿整个处理器(插入后的派发分支复用,不再二次查询)。
      const group = await assertGroupWritable(db, id);
      // sender 身份不存在 → 404 点明身份问题(而不是回落 Local User 后误报
      // 403);存在但非本群成员 → 403 点明「不是本群成员」。缺失/非法 header
      // 回落 Local User 的宽容行为保持(不改中间件)。
      await assertClaimedSenderExists(
        db,
        c.req.header("X-Participant-Id")?.trim(),
      );
      // The sender must be a group member (any role) to post.
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, senderId)),
      });
      if (!membership) {
        throw new BizError(
          BizCodeEnum.Forbidden,
          `参与方 ${senderId} 不是本群成员`,
        );
      }
      // human 角色只读(§3.8)仍然生效,但规范驱动的定向任务是外部触发入口:
      // 必须同时带 specRef + specHash,且 audience 只能是 role/participant。
      // 自由文本、广播与缺少任一规范字段仍返回原有 403。
      assertMemberCanPostMessage(membership, {
        audience: aud,
        specRef,
        specHash,
      });
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
          (await findExecutorByParticipant(db, targetParticipant));
        if (
          isExecutorTarget &&
          !membership.roles.some((r) =>
            (DISPATCH_ALLOWED_ROLES as readonly string[]).includes(r),
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

      // L3 findings are actionable only when they enter the existing task
      // dispatch path. Broadcast cannot wake the coordinator, so reject it;
      // direct participant dispatch additionally must target a coordinator
      // member rather than merely any participant.
      let findingsTargetRoles: string[] | undefined;
      if (
        parsed?.type === "review_result" &&
        parsed.verdict === "findings" &&
        aud === "participant" &&
        audienceRef
      ) {
        const targetMembership = await db.query.groupMember.findFirst({
          where: (t, { and, eq }) =>
            and(eq(t.groupId, id), eq(t.participantId, audienceRef)),
          columns: { roles: true },
        });
        findingsTargetRoles = targetMembership?.roles;
      }
      assertFindingsReviewResultDispatch(parsed, {
        audience: aud,
        audienceRef,
        targetRoles: findingsTargetRoles,
        specRef,
        specHash,
      });

      // 替代关系(executor-switch-task-identity R2):被替代的任务必须属于同一
      // 群组,否则 400;不校验其终态(协调者可能在原任务仍 running 时就决定
      // 替代)。只在派发路径(定向执行器消息)校验;放在消息插入前,400 不会
      // 留下已提交的消息行。
      // L2 重发路径安全网:调用方未显式传 supersedesTaskId 时,平台根据当前
      // 续跑上下文自动指向刚结束/被替代的子任务(首次派发不补、跨父任务不串链)。
      let finalSupersedesTaskId: string | null | undefined = supersedesTaskId;
      if (
        aud === "participant" &&
        audienceRef &&
        finalSupersedesTaskId == null
      ) {
        finalSupersedesTaskId = await inferSupersedesTaskId(
          db,
          id,
          senderId,
          audienceRef,
        );
      }
      if (
        aud === "participant" &&
        audienceRef &&
        finalSupersedesTaskId != null
      ) {
        await assertSupersededTaskInGroup(db, id, finalSupersedesTaskId);
      }

      // callback 归一化与两处 400 校验整体放在消息插入之前(spec
      // callback-validation-before-message-commit.md R1):校验失败即 400,
      // 不留已提交/已广播的消息。
      // 适用面与派发分支判定逐字一致(R2 不得扩大):只在定向
      // (participant/role 且有 audienceRef)且发送者群内角色命中
      // DISPATCH_ALLOWED_ROLES(canCarryDispatcher)时 400;broadcast 与
      // 无权携带者的非法 callback 仍是丢弃 + 警告(在下方派发分支内),
      // 不是 400。
      // 单一判定出处(ADR-0009):派发分支只消费这里的计算结果,不重算、
      // 不再次校验。
      const canCarryDispatcher = membership.roles.some((r) =>
        (DISPATCH_ALLOWED_ROLES as readonly string[]).includes(r),
      );
      // Part A:dispatcher_session_id 仅 coordinator/human/reviewer 发送者可携带
      // (执行器伪造 metadata 一律忽略),否则为 null。
      const rawSessionId = metadata?.dispatcherSessionId;
      const selectionReason = metadata?.selectionReason ?? null;
      const dispatcherSessionId =
        rawSessionId && canCarryDispatcher ? rawSessionId : null;
      // Part B:callback 路由信息 —— 三个字段均为可选、不超过 200 字符的非空
      // 字符串;拒绝未知字段、URL、命令、凭据、赋值形态或嵌套对象(400)。
      // 只提供 callback.sessionRef 时同步写入兼容字段 dispatcherSessionId;
      // 同时提供两者且不等 → 400。伪造(无权携带)时整个 callback 丢弃。
      const rawCallback = callback;
      let callbackRef: {
        platform?: string;
        endpointRef?: string;
        sessionRef?: string;
      } | null = null;
      let callbackSessionId: string | null = null;
      // 与派发分支逐字同一适用条件(单一判定出处,ADR-0009):定向
      // (participant/role + audienceRef)消息才进 callback 400 判定。
      // broadcast 的 audienceRef 在上方已被 400 拦截,此处不会命中。
      const inDispatchScope =
        (aud === "participant" || aud === "role") && audienceRef;
      if (inDispatchScope && rawCallback && canCarryDispatcher) {
        // 拒绝嵌套对象 / 非 string 字段:此处 zod 已约束为 string | undefined,
        // 只需过滤空串 + 拒绝非法内容。
        const strip = (s?: string) =>
          s && s.trim().length > 0 ? s.trim() : undefined;
        const platform = strip(rawCallback.platform);
        const endpointRef = strip(rawCallback.endpointRef);
        const sessionRef = strip(rawCallback.sessionRef);
        // 拒绝 URL、命令、凭据等非法内容(simple heuristic: 不能含空白或换行,
        // 不能以 http(s):// / ssh:// / ftp:// 等协议开头,不能含 $() 等 shell
        // 注入,不能是 key=value 赋值形态,不能含 token/secret/password/api key
        // /bearer/authorization/credential 等凭据关键词)。
        const FORBIDDEN_RE =
          /^https?:\/\/|^ssh:\/\/|^ftp:\/\/|\s|\$\(|`|&&|\|\||=|(?:token|secret|password|apikey|api[_-]?key|bearer|authorization|credential)/i;
        for (const [k, v] of Object.entries({
          platform,
          endpointRef,
          sessionRef,
        })) {
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
        if (
          callbackSessionId !== null &&
          rawSessionId &&
          callbackSessionId !== rawSessionId
        ) {
          throw new BizError(
            BizCodeEnum.InvalidRequest,
            "callback.sessionRef 与 dispatcherSessionId 冲突:两者必须相等",
          );
        }
      }
      // 兼容字段:只提供 callback.sessionRef 时同步写入 dispatcherSessionId;
      // 否则沿用 metadata.dispatcherSessionId(未携带/伪造时为 null)。
      const finalDispatcherSessionId = callbackSessionId ?? dispatcherSessionId;

      // 阶段2-票1 派发预判定(在消息事务之前算完):控制指令跳过 / 检视者守卫
      // / 角色定向等待结果。意图与消息同事务落库(persist-dispatch-intent R1),
      // 所以跳过原因也要在插入前算好,写入 rejected 终态,意图不悬着。
      const warnings: string[] = [];
      const isDirectedDispatch =
        (aud === "participant" || aud === "role") && !!audienceRef;
      const isRoleDispatch = aud === "role";
      let skipDispatchForControlCommand = false;
      let skipDispatchForReviewerTarget = false;
      let isExecutorTarget = false;
      if (isDirectedDispatch && audienceRef) {
        const targetParticipantForDispatch = isRoleDispatch
          ? undefined
          : await db.query.participant.findFirst({
              where: (t, { eq }) => eq(t.id, audienceRef),
              columns: { name: true, executorKey: true },
            });
        isExecutorTarget =
          !isRoleDispatch &&
          targetParticipantForDispatch !== undefined &&
          (await findExecutorByParticipant(
            db,
            targetParticipantForDispatch,
          )) !== undefined;
        // 控制通道与派发通道并行时不重复动作:正文命中停止/回滚指令(control
        // 唯一判定 isControlCommand,同一正则)且控制通道会执行它(即目标不
        // 是执行器任务目标)→ 跳过任务创建并留警告。目标分类用 control 唯一
        // 判定 isExecutorTaskTarget(本群角色 = executor),与控制通道同一事
        // 实:coordinator participant 即使绑定执行器 key,participant 定向它
        // 的控制指令仍归控制通道执行 → 这里跳过派发;执行器任务目标(既有语
        // 义视为任务,控制通道跳过)→ 派发照常,不受影响;role 定向必由控制
        // 通道执行 → 跳过;broadcast 不走派发入口,行为不变。
        skipDispatchForControlCommand =
          isControlCommand(body ?? "") &&
          (isRoleDispatch ||
            !(await isExecutorTaskTarget(db, audienceRef, id)));
        // 检视者不可被派发(dispatch-must-not-spawn-the-reviewer R1–R3):
        // 群内角色含 reviewer → 不建任务、不 spawn;消息已写入,响应头给
        // 可见 warning(不得静默跳过)。判据在 isReviewerNotDispatchableTarget
        // (group_members.roles),与派发层共用同一出处(ADR-0009)。
        skipDispatchForReviewerTarget = await isReviewerNotDispatchableTarget(
          db,
          id,
          isRoleDispatch ? "role" : "participant",
          audienceRef,
        );
        if (skipDispatchForReviewerTarget) {
          warnings.push("REVIEWER_TARGET_NOT_DISPATCHABLE");
        }
        if (callback && !canCarryDispatcher) {
          warnings.push("CALLBACK_STRIPPED_NOT_AUTHORIZED");
        }
        if (
          isExecutorTarget &&
          !specHash?.trim() &&
          !skipDispatchForControlCommand &&
          !skipDispatchForReviewerTarget
        ) {
          warnings.push("SPEC_HASH_MISSING");
        }
        if (group.projectPath) {
          const missing = await findMissingProjectDocs(group.projectPath);
          if (missing.length > 0) {
            c.header(
              "X-Project-Init-Warning",
              `PROJECT_NOT_INITIALIZED:${missing.join(",")}`,
            );
          }
        }
      }

      const findingsReviewResult =
        parsed?.type === "review_result" && parsed.verdict === "findings"
          ? parsed
          : undefined;
      const finalDispatchKind =
        dispatchKind ?? (findingsReviewResult ? "fix" : null);
      const initialDiffSummary =
        findingsReviewResult && !dispatchKind
          ? {
              dispatchKindNote:
                "dispatchKind 由 findings 缺省推定为 fix,未由检视者显式指定",
            }
          : null;

      // Message + closure (+ optional dispatch intent) are written atomically.
      // Intent in the same transaction = crash after commit can rebuild the
      // task (persist-dispatch-intent-with-the-message R1). Historical
      // messages are not backfilled.
      const full = await insertGroupMessage(
        db,
        {
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
        },
        isDirectedDispatch && audienceRef
          ? async (tx, created) => {
              const dispatchInput = {
                groupId: id,
                messageId: created.id,
                senderRoles: membership.roles,
                audience: isRoleDispatch
                  ? ("role" as const)
                  : ("participant" as const),
                audienceRef,
                body: findingsReviewResult
                  ? renderFindingsTaskBrief(
                      findingsReviewResult,
                      body ?? "",
                    )
                  : (body ?? ""),
                dispatcherParticipantId: senderId,
                dispatcherSessionId: finalDispatcherSessionId,
                selectionReason,
                specRef: specRef ?? null,
                specHash: specHash ?? null,
                dispatchKind: finalDispatchKind,
                supersedesTaskId: finalSupersedesTaskId ?? null,
                callbackRef,
                initialDiffSummary,
              };
              await writeDispatchIntent(tx, {
                groupId: id,
                messageId: created.id,
                audience: dispatchInput.audience,
                audienceRef,
                payload: payloadFromDispatchInput(dispatchInput),
                rejectReason: skipDispatchForControlCommand
                  ? "control-command-skipped"
                  : skipDispatchForReviewerTarget
                    ? "reviewer-not-dispatchable"
                    : undefined,
              });
            }
          : undefined,
      );

      // Realtime push (ticket 13): fire-and-forget — the WS hub catches its
      // own failures, so the fan-out cannot block the response; the ?after=
      // incremental pull remains the guaranteed fallback.
      void wsHub.broadcastGroupMessage(full);

      // skill 安装确认(skill 加载强化):识别 "✅ skill 已安装" 等确认消息,幂等
      // 更新发送者 capabilities。fire-and-forget,不匹配即静默返回,不阻塞消息。
      void handleSkillInstallConfirmation(db, senderId, body ?? "").catch(
        (err) => console.warn("[messages] skill 安装确认处理失败(忽略):", err),
      );

      // 第1层(A2A 进度信号):执行器 participant 在本群发的消息 → 刷新同群 running
      // 的 A2A 任务最近活跃时间,顺延无进展超时(纯内存同步操作,不阻塞响应;
      // 消息可以是普通广播消息,无需新协议)。
      refreshA2AActivity(id, senderId);

      // 阶段2-票1:定向到执行器 participant 的消息 → server 直接建 task + spawn
      // (fire-and-forget;命中与否/幂等/双跑防重都在 executor-task 内处理,
      // 失败只记日志,绝不阻塞消息响应)。audience=role(角色定向)由派发层按
      // 角色解析目标成员(specs/dispatch-to-role.md R1),此处等待其解析结果
      // 以便把「角色无匹配」作为可见信号(响应头)返回,不静默跳过(R3)。
      // 意图已在消息事务中落库;此处只做 live 派发 + 结算意图状态。
      if (isDirectedDispatch && audienceRef) {
        const dispatchInput = {
          groupId: id,
          messageId: full.id,
          senderRoles: membership.roles,
          audience: isRoleDispatch
            ? ("role" as const)
            : ("participant" as const),
          audienceRef,
          body: findingsReviewResult
            ? renderFindingsTaskBrief(findingsReviewResult, body ?? "")
            : (body ?? ""),
          dispatcherParticipantId: senderId,
          dispatcherSessionId: finalDispatcherSessionId,
          selectionReason,
          specRef: specRef ?? null,
          specHash: specHash ?? null,
          dispatchKind: finalDispatchKind,
          supersedesTaskId: finalSupersedesTaskId ?? null,
          callbackRef,
          initialDiffSummary,
        };
        // 控制通道已执行的控制指令跳过派发(判定见 skipDispatchForControlCommand
        // 注释);检视者目标跳过派发(判定见 skipDispatchForReviewerTarget);
        // participant 定向执行器与 broadcast 的行为均不受影响。
        // 意图已在事务内记为 rejected,这里只补响应头 warning。
        if (skipDispatchForControlCommand) {
          warnings.push("CONTROL_COMMAND_SKIPPED_DISPATCH");
        } else if (skipDispatchForReviewerTarget) {
          // warning 已入列;消息正常写入,不建任务、不 spawn。
        } else {
          // participant 定向保持 fire-and-forget(行为不变);角色定向等待派发
          // 结果,把「角色无匹配/非法」变成响应头里的可见信号(不静默跳过,
          // spec R3)。意外错误一律只记日志,绝不阻塞消息响应。
          // dispatchAndSettleIntent = maybeDispatch + 意图状态结算(同一判定口径)。
          if (aud === "role") {
            const outcome = await dispatchAndSettleIntent(
              db,
              dispatchInput,
            ).catch((err) => {
              console.warn("[executor] 后台调度失败(忽略):", err);
              return undefined;
            });
            if (outcome?.status === "role-unresolved") {
              warnings.push(
                `ROLE_UNRESOLVED:${outcome.role}:${outcome.reason}`,
              );
            } else if (outcome?.status === "redispatch-stopped") {
              warnings.push(`REDISPATCH_STOPPED:${outcome.parentTaskId}`);
            } else if (outcome?.status === "reviewer-not-dispatchable") {
              // 派发层第二道闸(消息层已拦,正常不会到这里);补 warning 防漏。
              if (!warnings.includes("REVIEWER_TARGET_NOT_DISPATCHABLE")) {
                warnings.push("REVIEWER_TARGET_NOT_DISPATCHABLE");
              }
            }
          } else {
            void dispatchAndSettleIntent(db, dispatchInput).catch((err) =>
              console.warn("[executor] 后台调度失败(忽略):", err),
            );
          }
        }
        if (warnings.length > 0) {
          c.header("X-CoAgentHub-Warning", warnings.join(","));
        }
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
      // human 角色只读(§3.8):与 POST 同款守卫,human 成员不可编辑消息。
      assertMemberNotHuman(membership);
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
      // human 角色只读(§3.8):与 POST 同款守卫,human 成员不可删除消息。
      assertMemberNotHuman(membership);
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
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const requesterId = c.get("participantId");
      const { id } = c.req.valid("param");
      const { after, q, limit } = c.req.valid("query");

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
          limit,
          participantType,
        },
      );

      return c.json(messages);
    },
  );

export default app;
