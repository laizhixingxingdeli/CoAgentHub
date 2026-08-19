import { describe, expect, it } from "vitest";
import type { CompletionEvent } from "../src/config.js";
import { buildCompletionMessage, summarizeForLog } from "../src/envelope.js";

function makeEvent(): CompletionEvent {
  return {
    schemaVersion: 1,
    type: "coagenthub.task.completed",
    eventId: "00000000-0000-7000-8000-000000000001",
    dispatcherParticipantId: "00000000-0000-7000-8000-000000000099",
    dispatcherSessionId: "sess-1",
    callbackRef: {
      platform: "codex",
      endpointRef: "dev-mac",
      sessionRef: "sess-abc",
    },
    task: {
      groupId: "00000000-0000-7000-8000-000000000002",
      taskId: "00000000-0000-7000-8000-000000000003",
      status: "done",
      specRef: "specs/test.md",
      specHash: "deadbeef",
      diffSummary: { files: 3, lines: 42 },
      outputTail: "commit abc1234",
    },
  };
}

describe("Completion Message Envelope", () => {
  it("message contains eventId and task details", () => {
    const event = makeEvent();
    const msg = buildCompletionMessage(event);
    const parsed = JSON.parse(msg);

    expect(parsed.envelope).toBe("coagenthub-task-completion");
    expect(parsed.eventId).toBe(event.eventId);
    expect(parsed.task.groupId).toBe(event.task.groupId);
    expect(parsed.task.taskId).toBe(event.task.taskId);
    expect(parsed.task.status).toBe(event.task.status);
    expect(parsed.task.specRef).toBe(event.task.specRef);
    expect(parsed.task.specHash).toBe(event.task.specHash);
    expect(parsed.task.diffSummary).toEqual(event.task.diffSummary);
    expect(parsed.task.outputTail).toBe(event.task.outputTail);
  });

  it("message declares executor output as untrusted", () => {
    const event = makeEvent();
    const msg = buildCompletionMessage(event);
    const parsed = JSON.parse(msg);

    expect(parsed._untrusted).toContain("untrusted");
    expect(parsed._untrusted).toContain("Post-Flight");
  });

  it("summarizeForLog does not expose sensitive data", () => {
    const event = makeEvent();
    const summary = summarizeForLog(event);

    expect(summary).toContain(event.eventId);
    expect(summary).toContain(event.task.groupId);
    expect(summary).toContain(event.task.taskId);
    expect(summary).toContain(event.task.status);
    expect(summary).toContain(event.task.specRef ?? "");
    // Should not contain diffSummary or outputTail
    expect(summary).not.toContain("diffSummary");
    expect(summary).not.toContain("outputTail");
  });
});
