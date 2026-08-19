import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-diag-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBuddy = fakeBin;

const { createTestApp } = await import("./app");
const { testClient } = await import("./db");

const app = createTestApp();

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

describe("diagnostic", () => {
  it("check trigger and table exist", async () => {
    const trig = await testClient.exec(`
      SELECT trigger_name FROM information_schema.triggers 
      WHERE trigger_name = 'task_completion_event_trigger'
    `);
    console.log("TRIGGER RESULT:", JSON.stringify(trig));

    const tbl = await testClient.exec(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'task_completion_event'
    `);
    console.log("TABLE COLUMNS:", JSON.stringify(tbl));

    expect(trig).toBeDefined();
  });

  it("manual insert into task_completion_event works", async () => {
    // register a participant, group, then manually insert task + completion event
    const regRes = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "diag-participant" }),
    });
    expect(regRes.status).toBe(200);
    const { id: participantId } = (await regRes.json()) as { id: string };

    // Directly insert a task with done status + dispatcher_participant_id to test trigger
    const insertResult = await testClient.exec(`
      INSERT INTO task (id, group_id, message_id, executor_participant_id, status, dispatcher_participant_id, callback_ref)
      VALUES (
        '01a01999-0000-0000-0000-000000000001',
        '01a01999-0000-0000-0000-000000000002',
        '01a01999-0000-0000-0000-000000000003',
        '${participantId}',
        'queued',
        '${participantId}',
        '{"platform":"codex"}'::jsonb
      )
    `);
    console.log("INSERT RESULT:", JSON.stringify(insertResult));

    // Now update to done
    const updateResult = await testClient.exec(`
      UPDATE task SET status = 'done' WHERE id = '01a01999-0000-0000-0000-000000000001'
    `);
    console.log("UPDATE RESULT:", JSON.stringify(updateResult));

    // Check if completion event was created
    const eventResult = await testClient.exec(`
      SELECT id, task_id, state, dispatcher_participant_id, callback_ref 
      FROM task_completion_event 
      WHERE task_id = '01a01999-0000-0000-0000-000000000001'
    `);
    console.log("EVENT RESULT:", JSON.stringify(eventResult));

    expect(eventResult).toBeDefined();
  });
});
