import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureRuntimeEntry,
  getRuntimeStatus,
} from "@server/lib/runtime-status";
import { afterEach, describe, expect, it } from "vitest";

const sourceEntry = new URL("../src/lib/runtime-status.ts", import.meta.url)
  .href;

afterEach(() => {
  configureRuntimeEntry(sourceEntry);
});

describe("runtime freshness", () => {
  it("treats an entry updated after boot as stale", () => {
    const directory = mkdtempSync(join(tmpdir(), "coagenthub-runtime-"));
    const entry = join(directory, "server.mjs");
    writeFileSync(entry, "entry");
    const future = new Date(Date.now() + 60_000);
    utimesSync(entry, future, future);
    configureRuntimeEntry(new URL(`file://${entry}`).href);

    try {
      expect(getRuntimeStatus()).toMatchObject({
        entryMtime: future.toISOString(),
        stale: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats an unavailable entry as not stale", () => {
    configureRuntimeEntry(
      new URL("file:///definitely/missing/coagenthub-entry.mjs").href,
    );

    expect(getRuntimeStatus()).toMatchObject({
      entryMtime: null,
      stale: false,
    });
  });
});
