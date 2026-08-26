import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// coagenthub-watchdog.sh 分支测试:用本地 stub HTTP server 模拟
// /api/system/health、/api/health、/api/groups、/api/groups/:id/tasks,
// 用可执行 stub prod 脚本记录被调用的参数,断言:
//   - build/both → restart --build;process 不触发重建
//   - 不健康路径仍只走 restart(不带 --build)
//   - 在途任务(running/queued)跳过重建(R4)
//   - R4 FAIL-CLOSED:缺 node / 群或任务 curl 失败 / JSON 解析失败 / 分页无法确认完整
//     → 跳过重建并记录明确日志(宁可不动,不可误杀在途任务)
//   - R2 重建后复核:restart --build 返回 0 后重新读 /api/health,
//     仅 stale===false 才算成功并清零;仍陈旧或不可验证 → 计失败进退避
//   - R3 连续 3 次构建失败后退避(不再调 prod);成功后计数归零
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

/** 记录每次调用的参数行;prod 脚本退出码由 exitCode 控制。
 *  exitCode=0 时额外 touch 一个 rebuilt-ok 标记,供 stub 模拟「重建后陈旧清除」。 */
function writeStubProd(dir, { exitCode = 0 } = {}) {
  const path = join(dir, "stub-prod.sh");
  writeFileSync(
    path,
    `#!/bin/bash
echo "$*" >> "${dir}/prod-calls.txt"
[ "${exitCode}" = 0 ] && touch "${dir}/rebuilt-ok"
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
  let healthReads = 0;
  // 测试控制位
  let rebuiltMarker = null; // 重建成功标记文件路径(runtimeFlip 据此返回 fresh)
  let runtimeFlip = false; // 重建成功后 health 变 fresh(模拟重建清除陈旧)
  let healthFail = false; // /api/health 恒 500
  let healthFailAfterFirst = false; // 首次读正常,后续 500(重建后复核不可验证)
  let groupsDown = false; // /api/groups 恒 500(curl 失败)
  let groupsBadJson = false; // /api/groups 返回非法 JSON
  let tasksDown = false; // /api/groups/:id/tasks 恒 500(curl 失败)
  let tasksBadJson = false; // /api/groups/:id/tasks 返回非法 JSON
  let failOffset = false; // offset>0 的翻页请求返回 503(分页无法确认完整)
  let groupTotal = null; // 覆盖群列表 total(用于制造「未满 total」)
  let taskPageSize = 0; // >0 时任务列表返回该数量的 done 任务(用于制造满页)

  const body = (req, res) => {
    const url = new URL(req.url, "http://x");
    const offset = Number(url.searchParams.get("offset") || "0");

    if (url.pathname === "/api/system/health") {
      res.writeHead(healthStatus, { "content-type": "text/plain" });
      res.end(healthStatus === 200 ? "ok" : "down");
      return;
    }
    if (url.pathname === "/api/health") {
      healthReads++;
      if (healthFail || (healthFailAfterFirst && healthReads > 1)) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("err");
        return;
      }
      const b = runtimeFlip && rebuiltMarker && existsSync(rebuiltMarker)
        ? { startedAt: runtimeBody.startedAt, entryMtime: runtimeBody.entryMtime, stale: false, staleReason: null }
        : runtimeBody;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
      return;
    }
    if (url.pathname === "/api/groups") {
      if (groupsDown) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("err");
        return;
      }
      if (groupsBadJson) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("not-json");
        return;
      }
      if (failOffset && offset > 0) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("err");
        return;
      }
      const total = groupTotal == null ? groups.length : groupTotal;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: groups, total }));
      return;
    }
    const taskMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/tasks$/);
    if (taskMatch) {
      if (tasksDown || (failOffset && offset > 0)) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("err");
        return;
      }
      if (tasksBadJson) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("not-json");
        return;
      }
      const page = taskPageSize > 0
        ? Array.from({ length: taskPageSize }, (_, i) => ({ id: `tp-${i}`, status: "done" }))
        : tasks;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(page));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("web-ok");
  };

  const server = createServer((req, res) => body(req, res));
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
    set runtime(v) {
      runtimeBody = v;
    },
    set rebuiltMarker(v) {
      rebuiltMarker = v;
    },
    set runtimeFlip(v) {
      runtimeFlip = v;
    },
    set healthFail(v) {
      healthFail = v;
    },
    set healthFailAfterFirst(v) {
      healthFailAfterFirst = v;
    },
    set groupsDown(v) {
      groupsDown = v;
    },
    set groupsBadJson(v) {
      groupsBadJson = v;
    },
    set tasksDown(v) {
      tasksDown = v;
    },
    set tasksBadJson(v) {
      tasksBadJson = v;
    },
    set failOffset(v) {
      failOffset = v;
    },
    set groupTotal(v) {
      groupTotal = v;
    },
    set taskPageSize(v) {
      taskPageSize = v;
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
        COAGENTHUB_PAGE_LIMIT: "100",
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

function failCount(dir) {
  try {
    return readFileSync(join(dir, "stale-failures"), "utf8").trim();
  } catch {
    return null;
  }
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

  it("staleReason=build → restart --build,重建后复核 stale=false 计成功并归零", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    stub.runtimeFlip = true;
    stub.rebuiltMarker = join(dir, "rebuilt-ok"); // 重建后 health 变 fresh
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
    expect(logLines(dir).some((l) => l.includes("OK   重建成功"))).toBe(true);
  });

  it("staleReason=both → restart --build,重建后复核 stale=false 计成功", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "both" };
    stub.runtimeFlip = true;
    stub.rebuiltMarker = join(dir, "rebuilt-ok");
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

  // ---------- R4 在途保护 ----------
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
        l.includes("存在 running/queued 任务,本轮跳过重建"),
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

  // ---------- R4 FAIL-CLOSED:任一环节无法确认「无在途」→ 跳过重建 ----------
  it("FAIL-CLOSED 缺 node → 跳过重建并记录日志", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    const r = await runWatchdog({
      server: stub.server,
      prod,
      dir,
      extraEnv: { COAGENTHUB_HAVE_NODE: "0" },
    });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("FAIL-CLOSED") && l.includes("缺 node")),
    ).toBe(true);
  });

  it("FAIL-CLOSED 群列表 curl 失败 → 跳过重建并记录日志", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    stub.groupsDown = true;
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("FAIL-CLOSED") && l.includes("群列表失败")),
    ).toBe(true);
  });

  it("FAIL-CLOSED 群列表 JSON 解析失败 → 跳过重建并记录日志", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    stub.groupsBadJson = true;
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("FAIL-CLOSED") && l.includes("JSON 解析")),
    ).toBe(true);
  });

  it("FAIL-CLOSED 群列表分页无法确认完整(offset>0 翻页失败) → 跳过重建", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    stub.groupIds = ["g1"];
    stub.groupTotal = 5; // 谎报 total > 实际群数,迫使翻页
    stub.failOffset = true; // 翻页(offset>0)返回 503
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("FAIL-CLOSED")),
    ).toBe(true);
  });

  it("FAIL-CLOSED 任务列表 curl 失败 → 跳过重建并记录日志", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    stub.tasksDown = true;
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("FAIL-CLOSED") && l.includes("任务失败")),
    ).toBe(true);
  });

  it("FAIL-CLOSED 任务列表 JSON 解析失败 → 跳过重建并记录日志", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    stub.tasksBadJson = true;
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("FAIL-CLOSED") && l.includes("任务失败")),
    ).toBe(true);
  });

  it("FAIL-CLOSED 任务列表分页无法确认完整(满页后翻页失败) → 跳过重建", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    stub.taskPageSize = 100; // 满页(=limit)迫使翻页
    stub.failOffset = true; // 翻页(offset>0)返回 503
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("FAIL-CLOSED")),
    ).toBe(true);
  });

  // ---------- R2 重建后复核 ----------
  it("R2 restart --build 返回 0 但复核仍 stale → 计失败并进入退避", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 0 });
    stub.runtime = { stale: true, staleReason: "build" }; // 不翻转 → 复核仍 stale
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(1);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
    expect(failCount(dir)).toBe("1");
    expect(
      logLines(dir).some((l) => l.includes("FAIL 重建返回成功但复核")),
    ).toBe(true);
  });

  it("R2 restart --build 返回 0 但复核不可验证(健康 500) → 计失败并进入退避", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 0 });
    stub.runtime = { stale: true, staleReason: "build" };
    stub.healthFailAfterFirst = true; // 首次读 build 触发,R2 复核时 500
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(1);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
    expect(failCount(dir)).toBe("1");
    expect(
      logLines(dir).some((l) => l.includes("FAIL 重建返回成功但复核")),
    ).toBe(true);
  });

  // ---------- R3 失败退避 ----------
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
      expect(failCount(dir)).toBe(String(i));
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
    expect(failCount(dir)).toBe("1");

    // 换成成功退出 + 重建后 health 变 fresh 的 prod,重建成功后计数文件应被删除(归零)
    const okProd = writeStubProd(dir, { exitCode: 0 });
    stub.runtimeFlip = true;
    stub.rebuiltMarker = join(dir, "rebuilt-ok");
    const r = await runWatchdog({ server: stub.server, prod: okProd, dir });
    expect(r.status).toBe(0);
    expect(failCount(dir)).toBe(null);
  });
});
