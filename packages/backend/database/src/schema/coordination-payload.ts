import { z } from "zod";

/** Single source of truth for the coordination payloads described by §3.10. */
export const specPublishedPayload = z
  .object({
    type: z.literal("spec_published"),
    specRef: z.string().min(1),
    specHash: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

export const specAmendedPayload = z
  .object({
    type: z.literal("spec_amended"),
    specRef: z.string().min(1),
    specHash: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const reviewRequestPayload = z
  .object({
    type: z.literal("review_request"),
    layer: z.literal(3),
    taskId: z.string().min(1),
    specRef: z.string().min(1),
    specHash: z.string().min(1),
    diffSummary: z.string().min(1),
    // v4.1(spec §3.14.6):L3 深度提示 — fix 票带 true(精简档:免 spec 对照,
    // 只检 diff 架构质量);requirement 票不带(缺省=完整档)。仅载荷字段,
    // 不入数据库 schema,不改 review_result 回流。
    lite: z.boolean().optional(),
  })
  .strict();

export const reviewResultPayload = z
  .object({
    type: z.literal("review_result"),
    layer: z.literal(3),
    taskId: z.string().min(1),
    verdict: z.enum(["pass", "findings"]),
    findings: z.array(
      z
        .object({ severity: z.string().min(1), note: z.string().min(1) })
        .strict(),
    ),
    // 可选附加字段:检视者可在 verdict 之外附上被检 spec 引用与自由文本说明。
    // 保持 .strict():仅放行这三个已知可选字段,其它未知字段仍 400。
    specRef: z.string().min(1).optional(),
    specHash: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

export const coordinationPayload = z.discriminatedUnion("type", [
  specPublishedPayload,
  specAmendedPayload,
  reviewRequestPayload,
  reviewResultPayload,
]);

export type CoordinationPayload = z.infer<typeof coordinationPayload>;

export const REVIEW_REQUEST_EXAMPLE = {
  type: "review_request",
  layer: 3,
  taskId: "<task-id>",
  specRef: "specs/x.md",
  specHash: "<git-hash>",
  diffSummary: "<summary>",
} as const;

const KNOWN_COORDINATION_PAYLOAD_TYPES = new Set([
  "spec_published",
  "spec_amended",
  "review_request",
  "review_result",
]);

function parseKnownCoordinationPayloadValue(
  value: unknown,
): CoordinationPayload | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { type?: unknown }).type !== "string"
  ) {
    return undefined;
  }
  const type = (value as { type: string }).type;
  if (!KNOWN_COORDINATION_PAYLOAD_TYPES.has(type)) return undefined;
  return coordinationPayload.parse(value);
}

/** Returns the known JSON coordination payload, or undefined for free text. */
export function parseKnownCoordinationPayload(
  body: string,
): CoordinationPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    // Markdown messages are human-readable, so accept a known coordination
    // payload from a JSON or language-less fenced code block as a fallback.
    // Each candidate is independent: malformed, unknown, or non-JSON fences
    // must not turn ordinary prose into a coordination-payload validation
    // error, and a later valid fence may still be used.
    const fencePattern = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;
    for (const match of body.matchAll(fencePattern)) {
      try {
        const payload = parseKnownCoordinationPayloadValue(
          JSON.parse(match[1].trim()),
        );
        if (payload) return payload;
      } catch {
        // Try the next fence. Only a fully valid, known payload is accepted.
      }
    }
    return undefined;
  }
  // Keep the existing whole-body path intact: a syntactically valid known
  // payload with an invalid shape still throws for the caller to reject.
  return parseKnownCoordinationPayloadValue(value);
}

/** Normalize both observed review_request locations to nested form. */
export function normalizeReviewRequestDiffSummary(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const candidate =
    raw.type === "review_request"
      ? raw
      : Object.hasOwn(raw, "review_request")
        ? raw.review_request
        : undefined;
  if (candidate === undefined) return undefined;
  const parsed = reviewRequestPayload.parse(candidate);
  if (raw.type === "review_request") {
    const {
      type: _type,
      layer: _layer,
      taskId: _taskId,
      specRef: _specRef,
      specHash: _specHash,
      diffSummary: _diffSummary,
      ...rest
    } = raw;
    return { ...rest, review_request: parsed };
  }
  return { ...raw, review_request: parsed };
}
