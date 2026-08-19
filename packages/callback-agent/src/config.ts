import path from "node:path";
import { z } from "zod";

/**
 * CallbackRef — opaque routing stored on a task by the dispatcher.
 * Only three short strings; no URL/command/token/secret.
 */
export const CallbackRefSchema = z
  .object({
    platform: z.string().max(200).optional(),
    endpointRef: z.string().max(200).optional(),
    sessionRef: z.string().max(200).optional(),
  })
  .strict();
export type CallbackRef = z.infer<typeof CallbackRefSchema>;

/**
 * Completion event envelope returned by the core inbox/claim API.
 * schemaVersion=1, type="coagenthub.task.completed".
 */
export const TaskSchema = z.object({
  groupId: z.string(),
  taskId: z.string(),
  status: z.string().nullable(),
  specRef: z.string().nullable(),
  specHash: z.string().nullable(),
  diffSummary: z.unknown().nullable(),
  outputTail: z.unknown().nullable(),
});

export const CompletionEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("coagenthub.task.completed"),
  eventId: z.string().uuid(),
  dispatcherParticipantId: z.string().nullable(),
  dispatcherSessionId: z.string().nullable(),
  callbackRef: CallbackRefSchema.nullable(),
  task: TaskSchema,
});

export type CompletionEvent = z.infer<typeof CompletionEventSchema>;

/** Inbox list item = standard envelope + delivery state. */
export const InboxItemSchema = CompletionEventSchema.extend({
  state: z.enum(["pending", "leased", "delivered", "dead"]),
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable().optional(),
});

export type InboxItem = z.infer<typeof InboxItemSchema>;

/** Claim response from core API. */
export const ClaimResponseSchema = z.object({
  leaseToken: z.string().uuid(),
  event: CompletionEventSchema,
});

export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

/** Known placeholders allowed in command arguments. */
const PLACEHOLDER_PATTERN = /^\{(sessionRef|message|eventFile)\}$/;

/**
 * A single command argument: either a static string or a complete placeholder.
 * Uses z.custom for proper typing.
 */
export const CommandArgSchema = z.custom<string>(
  (val): val is string => {
    if (typeof val !== "string") return false;
    // Valid if it's a complete placeholder OR contains no braces
    return (
      PLACEHOLDER_PATTERN.test(val) ||
      (!val.includes("{") && !val.includes("}"))
    );
  },
  (val) => ({
    message: `command argument must be a static string or a single complete placeholder {sessionRef}/{message}/{eventFile}; got "${val}"`,
  }),
);

/**
 * Command driver configuration — static executable + args + optional env.
 * executable MUST be an absolute path.
 */
export const CommandDriverSchema = z.object({
  driver: z.literal("command"),
  executable: z
    .string()
    .min(1)
    .refine(
      (val): val is string => path.isAbsolute(val),
      (val) => ({
        message: `executable must be an absolute path; got "${val}"`,
      }),
    ),
  args: z.array(CommandArgSchema).default([]),
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  eventFile: z.boolean().optional(),
});

export type CommandDriver = z.infer<typeof CommandDriverSchema>;

/**
 * Endpoint configuration — maps an endpointRef to a driver.
 */
export const EndpointConfigSchema = z
  .object({
    driver: CommandDriverSchema,
  })
  .strict();

export type EndpointConfig = z.infer<typeof EndpointConfigSchema>;

/**
 * Root configuration schema for the callback-agent.
 */
export const CallbackAgentConfigSchema = z.object({
  apiBase: z.string().url(),
  participantId: z.string().uuid(),
  consumerId: z.string().min(1).max(200),
  pollIntervalMs: z.number().int().positive().default(5000),
  leaseMs: z.number().int().min(1000).default(30000),
  defaultTimeoutMs: z.number().int().positive().default(60000).optional(),
  endpoints: z.record(EndpointConfigSchema),
});

export type CallbackAgentConfig = z.infer<typeof CallbackAgentConfigSchema>;

export { PLACEHOLDER_PATTERN };
