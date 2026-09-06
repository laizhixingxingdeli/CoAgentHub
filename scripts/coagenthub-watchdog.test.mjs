import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
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
 *  exitCode=0 时额外 touch 一个 rebuilt-ok 标记,供 stub 模拟「重建后陈旧清除」。
 *  markRebuild=1 时即便 exitCode 非零也 touch 标记——用于模拟
 *  「restart --build 退出码非零,但重建实际成功(陈旧已清除)」的回归场景。
 *  failOnce=1 时第一次调用退出 1(且不 touch 标记),第二次起按 exitCode 走——
 *  用于「restart 失败一轮、下一轮成功」的滚动窗回归。 */
function writeStubProd(
  dir,
  { exitCode = 0, markRebuild = false, failOnce = false } = {},
) {
  const path = join(dir, "stub-prod.sh");
  // 归一化为字面量 1/0,避免布尔 true 被 bash 当成字符串 "true" 比较失败
  const mr = markRebuild ? 1 : 0;
  const fo = failOnce ? 1 : 0;
  writeFileSync(
    path,
    `#!/bin/bash
echo "$*" >> "${dir}/prod-calls.txt"
CALLS=\$(wc -l < "${dir}/prod-calls.txt" | tr -d ' ')
FAILTHIS=0
if [ "\${fo:-0}" = 1 ] && [ "\$CALLS" = 1 ]; then FAILTHIS=1; fi
if [ "\$FAILTHIS" = 0 ]; then
  if [ "${exitCode}" = 0 ] || [ "${mr}" = 1 ]; then
    touch "${dir}/rebuilt-ok"
  fi
  exit ${exitCode}
fi
exit 1
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
  let msgFile = null; // 群消息记录文件路径(setter 提供)

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
    const msgMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/messages$/);
    if (msgMatch && req.method === "POST") {
      // 记录停滞 WARN 群消息(供 R2 断言),返回创建成功
      const lines = [];
      req.on("data", (d) => lines.push(d));
      req.on("end", () => {
        if (msgFile) {
          try {
            const body = JSON.parse(Buffer.concat(lines).toString("utf8"));
            appendFileSync(
              msgFile,
              JSON.stringify({ groupId: msgMatch[1], ...body }) + "\n",
            );
          } catch {}
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m1", depth: 0 }));
      });
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
    set msgFile(v) {
      msgFile = v;
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
// 需要断言群消息的用例先设 stub.msgFile(wrapper setter),stub 会把
// POST /api/groups/:id/messages 落到该 jsonl 文件。
function runWatchdog({ server, prod, dir, extraEnv = {} } = {}) {
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
        COAGENTHUB_STALL_STATE_FILE: join(dir, "stall-state"),
        COAGENTHUB_STALL_GROUP_ID: "g1",
        COAGENTHUB_AUTO_REBUILD_STATE: join(dir, "auto-rebuild-state"),
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

/** 失败文件(每行一个 epoch 秒):返回窗口内行数;无文件 → null。 */
function failCount(dir) {
  try {
    const lines = readFileSync(join(dir, "stale-failures"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    return String(lines.length);
  } catch {
    return null;
  }
}

/** 向失败文件追加一个 epoch 秒(模拟过去某时刻的一次失败)。 */
function pushFailAt(dir, epochSeconds) {
  appendFileSync(join(dir, "stale-failures"), `${epochSeconds}\n`);
}

/** 读状态文件(单行 JSON);无文件 → null。 */
function readState(dir, name) {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

/** 群消息 jsonl 记录(停滞 WARN);无文件 → []。 */
function groupMessages(dir, name) {
  try {
    return readFileSync(join(dir, name), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
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
    expect(logLines(dir).some((l) => l.includes("OK   restart --build 成功"))).toBe(
      true,
    );
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

  // ---------- R1(spec R1):process 陈旧 → 实际执行 restart(不带 --build) ----------
  it("staleReason=process → 执行 prod restart(不带 --build),复核 fresh 后归零", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "process" };
    stub.runtimeFlip = true;
    stub.rebuiltMarker = join(dir, "rebuilt-ok"); // restart 后 health 变 fresh
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual(["restart"]);
    expect(logLines(dir).some((l) => l.includes("OK   restart 成功"))).toBe(
      true,
    );
  });

  it("staleReason=process 且退出码非零但复核 fresh → 不计失败(以复核为准)", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 1, markRebuild: true });
    stub.runtime = { stale: true, staleReason: "process" };
    stub.runtimeFlip = true;
    stub.rebuiltMarker = join(dir, "rebuilt-ok");
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual(["restart"]);
    expect(failCount(dir)).toBe(null);
  });

  it("staleReason=process 且复核仍陈旧 → 计失败进入退避(与 build 同守卫)", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 1 });
    stub.runtime = { stale: true, staleReason: "process" };
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(1);
    expect(prodCalls(dir)).toEqual(["restart"]);
    expect(failCount(dir)).toBe("1");
    expect(logLines(dir).some((l) => l.includes("FAIL 复核 /api/health 仍陈旧"))).toBe(
      true,
    );
  });

  it("staleReason=process 且有 running 任务 → 不重启(在途保护不放松)", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "process" };
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

  it("staleReason=process 且缺 node → FAIL-CLOSED 不重启", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "process" };
    const r = await runWatchdog({
      server: stub.server,
      prod,
      dir,
      extraEnv: { COAGENTHUB_HAVE_NODE: "0" },
    });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
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
      logLines(dir).some((l) => l.includes("FAIL 复核 /api/health 仍陈旧")),
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
      logLines(dir).some((l) => l.includes("FAIL 复核 /api/health 仍陈旧")),
    ).toBe(true);
  });

  // ---------- R2 高危闭环回归:退出码非零不应误累加退避 ----------
  it("R2 restart --build 退出码非零但复核 stale=false(fresh) → 不计失败、归零、记成功", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    // prod 退出码 1(模拟「脚本退出非零」),但重建实际成功(标记 rebuilt-ok → 复核 fresh)
    const prod = writeStubProd(dir, { exitCode: 1, markRebuild: true });
    stub.runtime = { stale: true, staleReason: "build" };
    stub.runtimeFlip = true;
    stub.rebuiltMarker = join(dir, "rebuilt-ok");
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
    // 关键:退出码非零但复核 fresh → 不算失败,失败计数归零(文件被删)
    expect(failCount(dir)).toBe(null);
    expect(
      logLines(dir).some((l) => l.includes("OK   restart --build 成功")),
    ).toBe(true);
  });

  it("R2 restart --build 退出码非零且复核仍陈旧 → 计失败并进入退避", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    // 退出码 1 且未重建 → 复核仍为 build/stale,应累加退避
    const prod = writeStubProd(dir, { exitCode: 1 });
    stub.runtime = { stale: true, staleReason: "build" };
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(1);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
    expect(failCount(dir)).toBe("1");
    expect(
      logLines(dir).some((l) => l.includes("FAIL 复核 /api/health 仍陈旧")),
    ).toBe(true);
  });

  // ---------- R3 失败退避(滚动时间窗) ----------
  it("连续 3 次构建失败后停用:第 4 次不再调 prod,写停用状态文件(R4 可见)", async () => {
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
    // 第 4 次:窗口内达到阈值,不再调 prod,并写 R4 停用状态文件
    const r4 = await runWatchdog({ server: stub.server, prod, dir });
    expect(r4.status).toBe(0);
    expect(prodCalls(dir).length).toBe(3);
    expect(
      logLines(dir).some((l) => l.includes("自动重建已停用")),
    ).toBe(true);
    const state = readState(dir, "auto-rebuild-state");
    expect(state?.disabled).toBe(true);
    expect(typeof state?.disabledAt).toBe("string");
    expect(typeof state?.reason).toBe("string");
  });

  it("R3 滚动窗:25h 前的 2 次失败 + 1 次新失败 → 窗口内仅 1 次,不停用", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 1 });
    stub.runtime = { stale: true, staleReason: "build" };
    const now = Math.floor(Date.now() / 1000);
    pushFailAt(dir, now - 25 * 3600); // 25h 前
    pushFailAt(dir, now - 24.5 * 3600); // 24.5h 前(窗口外)
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(1);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
    // 窗口外失败被淘汰,窗口内只剩本次 → 未达阈值,无停用状态文件
    expect(failCount(dir)).toBe("1");
    expect(readState(dir, "auto-rebuild-state")).toBe(null);
  });

  it("R3 自动恢复:3 次失败达阈值停用,25h 前 2 条 + 1 条在窗 → 自动重新尝试(无需删文件)", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 1 });
    stub.runtime = { stale: true, staleReason: "build" };
    // 制造停用:窗口内 3 次失败
    const now = Math.floor(Date.now() / 1000);
    pushFailAt(dir, now - 10);
    pushFailAt(dir, now - 20);
    pushFailAt(dir, now - 30);
    const r0 = await runWatchdog({ server: stub.server, prod, dir });
    expect(r0.status).toBe(0); // 停用,不调 prod
    expect(prodCalls(dir)).toEqual([]);
    expect(readState(dir, "auto-rebuild-state")?.disabled).toBe(true);
    // 把其中 2 条旧化为 25h 前(模拟窗口滑动,失败文件本身仍在、无人删)
    const staleFile = join(dir, "stale-failures");
    writeFileSync(staleFile, `${now - 25 * 3600}\n${now - 25.5 * 3600}\n${now - 30}\n`);
    // 下一轮:窗口内只剩 1 条 → 自动恢复尝试。恢复轮要成功:换成成功 prod
    const okProd = writeStubProd(dir, { exitCode: 0 });
    stub.runtimeFlip = true;
    stub.rebuiltMarker = join(dir, "rebuilt-ok");
    const r1 = await runWatchdog({ server: stub.server, prod: okProd, dir });
    expect(r1.status).toBe(0);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
    // 成功后计数归零、停用状态清除
    expect(failCount(dir)).toBe(null);
    expect(readState(dir, "auto-rebuild-state")).toBe(null);
  });

  it("R3 旧格式兼容:裸计数文件 '3' → 迁移为 3 条「现在」失败,立即停用", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 1 });
    stub.runtime = { stale: true, staleReason: "build" };
    writeFileSync(join(dir, "stale-failures"), "3\n"); // 2026-09-05 前旧格式
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("自动重建已停用")),
    ).toBe(true);
    expect(readState(dir, "auto-rebuild-state")?.disabled).toBe(true);
  });

  // ---------- R2 停滞升级:在途任务连续阻塞 → WARN + 群消息,不重复 INFO ----------
  it("R2 停滞:连续 3 轮在途阻塞 → 第 3 轮 WARN+群消息,第 4 轮不重复记录", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.msgFile = join(dir, "group-messages.jsonl"); // 群消息落盘供断言
    stub.runtime = { stale: true, staleReason: "build" };
    stub.taskStatuses = ["running"];
    // 前 2 轮:INFO 未达阈值
    for (let i = 1; i <= 2; i++) {
      const r = await runWatchdog({ server: stub.server, prod, dir });
      expect(r.status).toBe(0);
      expect(readState(dir, "stall-state")?.stalledRounds).toBe(i);
    }
    // 第 3 轮:达阈值 → WARN + 群消息
    const r3 = await runWatchdog({ server: stub.server, prod, dir });
    expect(r3.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(
      logLines(dir).some((l) => l.includes("WARN staleReason=build 连续 3 轮无法处理")),
    ).toBe(true);
    const messages = groupMessages(dir, "group-messages.jsonl");
    expect(messages.length).toBe(1);
    expect(messages[0].groupId).toBe("g1");
    expect(messages[0].body).toContain("连续 3 轮");
    expect(readState(dir, "stall-state")?.notified).toBe(true);
    // 第 4 轮:不再重复 WARN/群消息(持续事实由状态文件 + 健康接口承载)
    const r4 = await runWatchdog({ server: stub.server, prod, dir });
    expect(r4.status).toBe(0);
    expect(groupMessages(dir, "group-messages.jsonl").length).toBe(1);
    expect(readState(dir, "stall-state")?.stalledRounds).toBe(4);
    expect(logLines(dir).filter((l) => l.includes("WARN staleReason=build 连续")).length).toBe(1);
  });

  it("R2 停滞:在途清空后停滞计数清零(陈旧被处理即解除)", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "build" };
    stub.taskStatuses = ["running"];
    await runWatchdog({ server: stub.server, prod, dir });
    expect(readState(dir, "stall-state")?.stalledRounds).toBe(1);
    // 任务完成 + 本轮可处理(重建成功)→ 停滞清零、计数归零
    stub.taskStatuses = ["done"];
    stub.runtimeFlip = true;
    stub.rebuiltMarker = join(dir, "rebuilt-ok");
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual(["restart --build"]);
    expect(readState(dir, "stall-state")).toBe(null);
    expect(failCount(dir)).toBe(null);
  });

  it("R2 回归:陈旧被人工处理后 runtime fresh → 停滞计数清零(下一波陈旧可重新达阈值)", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir);
    stub.runtime = { stale: true, staleReason: "process" };
    stub.taskStatuses = ["running"];
    for (let i = 1; i <= 3; i++) {
      await runWatchdog({ server: stub.server, prod, dir });
      expect(readState(dir, "stall-state")?.stalledRounds).toBe(i);
    }
    // 人工处理后 runtime 转 fresh(在途任务仍在):下一轮必须清零停滞,
    // 否则陈旧再次出现时「连续 N 轮」被人工处理间隙打碎,R2 永不升级
    stub.runtime = {
      stale: false,
      staleReason: null,
    };
    const r = await runWatchdog({ server: stub.server, prod, dir });
    expect(r.status).toBe(0);
    expect(prodCalls(dir)).toEqual([]);
    expect(readState(dir, "stall-state")).toBe(null);
  });

  it("R4 可见性:健康(fresh)时停用状态文件被清除(处理成功后健康接口回到未停用)", async () => {
    const dir = tempDir();
    const stub = stubServer();
    await stub.listen();
    const prod = writeStubProd(dir, { exitCode: 1 });
    stub.runtime = { stale: true, staleReason: "build" };
    const now = Math.floor(Date.now() / 1000);
    pushFailAt(dir, now - 10);
    pushFailAt(dir, now - 20);
    pushFailAt(dir, now - 30);
    await runWatchdog({ server: stub.server, prod, dir }); // 停用
    expect(readState(dir, "auto-rebuild-state")?.disabled).toBe(true);
    // 窗口滑动 + 本轮成功 → 停用清除(恢复轮换成成功 prod)
    writeFileSync(
      join(dir, "stale-failures"),
      `${now - 25 * 3600}\n${now - 25.5 * 3600}\n${now - 25.7 * 3600}\n`,
    );
    const okProd = writeStubProd(dir, { exitCode: 0 });
    stub.runtimeFlip = true;
    stub.rebuiltMarker = join(dir, "rebuilt-ok");
    const r = await runWatchdog({ server: stub.server, prod: okProd, dir });
    expect(r.status).toBe(0);
    expect(readState(dir, "auto-rebuild-state")).toBe(null);
    expect(failCount(dir)).toBe(null);
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
