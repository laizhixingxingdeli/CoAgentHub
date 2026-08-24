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

/** Returns the known JSON coordination payload, or undefined for free text. */
export function parseKnownCoordinationPayload(
  body: string,
): CoordinationPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { type?: unknown }).type !== "string"
  ) {
    return undefined;
  }
  const type = (value as { type: string }).type;
  if (
    ![
      "spec_published",
      "spec_amended",
      "review_request",
      "review_result",
    ].includes(type)
  ) {
    return undefined;
  }
  return coordinationPayload.parse(value);
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
