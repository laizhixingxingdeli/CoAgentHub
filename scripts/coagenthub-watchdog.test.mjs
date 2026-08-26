import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// coagenthub-watchdog.sh 分支测试:用本地 stub HTTP server 模拟
// /api/system/health、/api/health、/api/groups、/api/groups/:id/tasks,
// 用可执行 stub prod 脚本记录被调用的参数,断言:
//   - build/both → restart --build;process 不触发重建
//   - 不健康路径仍只走 restart(不带 --build)
//   - 在途任务(running/queued)跳过重建
//   - 连续 3 次构建失败后退避(不再调 prod);成功后计数归零
// 不依赖外部 server / 数据库,与 scripts/ 下其它 .test.mjs 同构。

const WATCHDOG = new URL("./coagenthub-watchdog.sh", import.meta.url).pathname;

let tempDirs = [];
let servers = [];
afterEach(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  servers = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-test-"));
  tempDirs.push(dir);
  return dir;
}

/** 记录每次调用的参数行;prod 脚本退出码由 failNext 控制。 */
function writeStubProd(dir, { exitCode = 0 } = {}) {
  const path = join(dir, "stub-prod.sh");
  writeFileSync(
    path,
    `#!/bin/bash
echo "$*" >> "${dir}/prod-calls.txt"
exit ${exitCode}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function stubServer() {
  let healthStatus = 200; // /api/system/health
  let runtimeBody = {
    startedAt: "2026-01-01T00:00:00Z",
    entryMtime: "2026-01-01T00:00:00Z",
    stale: false,
    staleReason: null,
  };
  let groups = [{ id: "g1", title: "g1" }];
  let tasks = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/system/health") {
      res.writeHead(healthStatus, { "content-type": "text/plain" });
      res.end(healthStatus === 200 ? "ok" : "down");
      return;
    }
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(runtimeBody));
      return;
    }
    if (url.pathname === "/api/groups") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: groups, total: groups.length }));
      return;
    }
    const taskMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/tasks$/);
    if (taskMatch) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(tasks));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("web-ok");
  });
  servers.push(server);
  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    set healthDown(v) {
      healthStatus = v ? 503 : 200;
    },
    set runtime(body) {
      runtimeBody = body;
    },
    set groupIds(ids) {
      groups = ids.map((id) => ({ id, title: id }));
    },
    set taskStatuses(statuses) {
      tasks = statuses.map((status, i) => ({ id: `task-${i}`, status }));
    },
  };
}

// 异步 spawn:spawnSync 会阻塞事件循环,导致 stub server 在 watchdog 运行期间
// 无法处理任何请求(每个 curl 等满 -m 5 超时)。异步版让 server 正常响应。
function runWatchdog({ server, prod, dir, extraEnv = {} }) {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;
  return new Promise((resolve) => {
    const child = spawn("bash", [WATCHDOG, "--once"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        COAGENTHUB_HEALTH_URL: `${base}/system/health`,
        COAGENTHUB_RUNTIME_HEALTH_URL: `${base}/health`,
        COAGENTHUB_TASKS_API_URL: base,
        COAGENTHUB_WEB_URL: `http://127.0.0.1:${port}/`,
        COAGENTHUB_WATCHDOG_LOG: join(dir, "watchdog.log"),
        COAGENTHUB_STALE_FAILURE_FILE: join(dir, "stale-failures"),
        COAGENTHUB_PROD_SCRIPT: prod,
        COAGENTHUB_RESTART_SLEEP: "0",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: err });
    });
  });
}

function prodCalls(dir) {
  try {
    return readFileSync(join(dir, "prod-calls.txt"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function logLines(dir) {
  return readFileSync(join(dir, "watchdog.log"), "utf8").trim().split("\n");
}

describe("coagenthub-watchdog stale 分支", () => {
  it("健康且无陈旧:不调用 prod,退出 0", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
  });

  it("不健康路径仍只走 restart(不带 --build),与陈旧路径分离", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.healthDown = true;
    const r = await runWatchdog({ server: stub.server, prod, dir });
    // 重启后仍不健康 → FAIL → 退出 1;重点是调用参数只有 restart
    expect(r.status).toBe(1);
    expect(prodCalls(dir)).toEqual(["restart"]);
  });

  it("staleReason=build → restart --build,失败计数归零", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
    expect(logLines(dir).some((l) => l.includes("OK   重建成功"))).toBe(true);
  });

  it("staleReason=both → restart --build", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "both" };
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
  });

  it("staleReason=process → 不触发重建(不调 prod),记日志", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "process" };
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("staleReason=process,不触发重建")),
    ).toBe(true);
  });

  it("存在 running 任务 → 跳过重建并记日志", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    stub.taskStatuses = ["running"];
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) =>
        l.includes("有 running/queued 任务,本轮跳过重建"),
      ),
    ).toBe(true);
  });

  it("存在 queued 任务 → 跳过重建", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "both" };
    stub.taskStatuses = ["queued"];
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
  });

  it("连续 3 次构建失败后退避:第 4 次不再调 prod,只记日志", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 1 });
    stub.runtime = { stale: true, staleReason: "build" };
    for (let i = 1; i <= 3; i++) {
      const r = await runWatchdog({ server: stub.server, prod, dir });
      expect(r.status).toBe(1);
      expect(prodCalls(dir).length).toBe(i);
      expect(readFileSync(join(dir, "stale-failures"), "utf8").trim()).toBe(
        String(i),
      );
    }
    // 第 4 次:达到阈值,只记日志,不再调 prod
    const r4 = await runWatchdog({ server: stub.server, prod, dir });
    expect(r4.status).toBe(0);
    expect(prodCalls(dir).length).toBe(3);
    expect(
      logLines(dir).some((l) => l.includes("停止自动重建,等待人工介入")),
    ).toBe(true);
  });

  it("一次成功的重建后失败计数归零", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 1 });
    stub.runtime = { stale: true, staleReason: "build" };
    await runWatchdog({ server: stub.server, prod, dir });
    expect(readFileSync(join(dir, "stale-failures"), "utf8").trim()).toBe("1");

    // 换成成功退出的 prod,重建成功后计数文件应被删除(归零)
    const okProd = writeStubProd(dir, { exitCode: 0 });
    const r = await runWatchdog({ server: stub.server, prod: okProd, dir });
    expect(r.status).toBe(0);
    expect(() => readFileSync(join(dir, "stale-failures"), "utf8")).toThrow();
  });
});
