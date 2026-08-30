import { PGlite } from "@electric-sql/pglite";
import { executorConfig as executorConfigTable } from "@laizhixingxingdeli/database/schema";
import * as schema from "@laizhixingxingdeli/database/schema";
import { drizzle } from "drizzle-orm/pglite";

/**
 * In-memory Postgres (PGlite) used as the test database. The real
 * `@server/lib/database` module is replaced by a mock that re-exports these
 * instances (see test/setup.ts), so routes run against a real SQL engine with
 * the real schema — but no external DATABASE_URL is ever contacted.
 */
export const testClient = new PGlite();
export const testDb = drizzle(testClient, { schema });

/**
 * 测试内显式插入一条执行器配置 fixture(幂等,与 0028 seed 迁移同语义:
 * ON CONFLICT DO NOTHING)。测试不得依赖「系统自带某个 key」——自己声明并确保
 * 需要的配置行存在(即使 0028 seed 行已提供,显式声明也让用例自包含)。
 */
export async function ensureExecutorConfig(
  key: string,
  values: {
    agentName: string;
    type: string;
    bin: string;
    label: string;
    kind?: "cli" | "a2a";
    url?: string | null;
    args?: string[];
    model?: string | null;
    memory?: string | null;
    maxConcurrency?: number | null;
  },
): Promise<void> {
  await testDb
    .insert(executorConfigTable)
    .values({
      key,
      agentName: values.agentName,
      type: values.type,
      kind: values.kind ?? "cli",
      bin: values.bin,
      url: values.url ?? null,
      args: values.args ?? [],
      label: values.label,
      model: values.model ?? null,
      memory: values.memory ?? null,
      maxConcurrency: values.maxConcurrency ?? null,
    })
    .onConflictDoNothing({ target: executorConfigTable.key });
}

/**
 * 一次性 seed 6 条旧内置执行器配置(fixture 化入口)。
 * 测试文件在 beforeAll 中调用,确保用例自包含(不依赖 0028 迁移 seed)。
 */
export async function seedBuiltinExecutorConfigs(): Promise<void> {
  await ensureExecutorConfig("executor", {
    agentName: "AtomCode",
    type: "participant",
    bin: "atomcode",
    label: "atomcode",
    args: ["-y", "-v", "-p", "{ticket}"],
    maxConcurrency: 1,
  });
  await ensureExecutorConfig("reasonix", {
    agentName: "Reasoning",
    type: "participant",
    bin: "reasonix",
    label: "reasonix",
    args: ["run", "-y", "--model", "{model}", "{ticket}"],
    model: "deepseek-v4-flash",
  });
  await ensureExecutorConfig("codebuddy", {
    agentName: "CodeBuddy",
    type: "participant",
    bin: "codebuddy",
    label: "codebuddy",
    args: ["-y", "-p", "{ticket}", "--output-format", "stream-json"],
  });
  await ensureExecutorConfig("codex", {
    agentName: "Codex",
    type: "participant",
    bin: "codex",
    label: "codex",
    args: [
      "exec",
      "--approve-for-me",
      "--ephemeral",
      "--json",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "{ticket}",
    ],
    maxConcurrency: 1,
  });
  await ensureExecutorConfig("hermes", {
    agentName: "Hermes",
    type: "hermes",
    bin: "hermes",
    label: "hermes",
    args: ["-z", "{ticketContent}"],
  });
  await ensureExecutorConfig("win-hermes", {
    agentName: "Win Hermes",
    type: "hermes",
    kind: "a2a",
    bin: "win-hermes",
    label: "win-hermes",
    url: "http://192.168.31.180:9900/",
    args: [],
    memory: "per-group",
  });
}
