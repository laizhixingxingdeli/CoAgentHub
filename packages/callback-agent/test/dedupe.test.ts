import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DedupeStore } from "../src/dedupe.js";

describe("DedupeStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coagenthub-dedupe-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("isDelivered returns false for unknown eventId", () => {
    const store = new DedupeStore(join(tmpDir, "dedupe.jsonl"));
    expect(store.isDelivered("unknown")).toBe(false);
  });

  it("write persists eventId, isDelivered returns true", async () => {
    const store = new DedupeStore(join(tmpDir, "dedupe.jsonl"));
    await store.write("event-1");
    expect(store.isDelivered("event-1")).toBe(true);
    expect(store.isDelivered("event-2")).toBe(false);
  });

  it("idempotent write — same eventId does not duplicate", async () => {
    const store = new DedupeStore(join(tmpDir, "dedupe.jsonl"));
    await store.write("event-1");
    await store.write("event-1");
    expect(store.all()).toEqual(["event-1"]);
  });

  it("persists across store reload (file-backed)", async () => {
    const path = join(tmpDir, "dedupe.jsonl");
    const store1 = new DedupeStore(path);
    await store1.write("event-1");
    await store1.write("event-2");

    // Reload from same file
    const store2 = new DedupeStore(path);
    expect(store2.isDelivered("event-1")).toBe(true);
    expect(store2.isDelivered("event-2")).toBe(true);
  });

  it("writeSync variant works for signal handlers", () => {
    const store = new DedupeStore(join(tmpDir, "dedupe.jsonl"));
    store.writeSync("event-1");
    expect(store.isDelivered("event-1")).toBe(true);
  });
});
