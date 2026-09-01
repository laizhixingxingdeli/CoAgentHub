import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PROD = new URL("./coagenthub-prod.sh", import.meta.url).pathname;
const NODE = process.execPath;
const children = [];
const tempDirs = [];
const pidFiles = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const file of pidFiles.splice(0)) {
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8"));
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may already have exited.
      }
    }
    rmSync(file, { force: true });
  }
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function serviceFixture(serverPort) {
  const dir = mkdtempSync(join(tmpdir(), "prod-test-"));
  tempDirs.push(dir);
  const scripts = join(dir, "scripts");
  const serverDir = join(dir, "packages/backend/server");
  const databaseDir = join(dir, "packages/backend/database");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(serverDir, "dist"), { recursive: true });
  mkdirSync(join(databaseDir, "dist"), { recursive: true });
  mkdirSync(join(dir, "packages/frontend/web/dist"), { recursive: true });
  writeFileSync(
    join(databaseDir, "package.json"),
    JSON.stringify({ scripts: { migrate: "true" } }),
  );
  writeFileSync(join(dir, "packages/frontend/web/dist/index.html"), "ok");
  writeFileSync(
    join(serverDir, "dist/server.mjs"),
    `import http from "node:http"; http.createServer((_, r) => r.end("ok")).listen(${serverPort});`,
  );
  writeFileSync(
    join(dir, "serve.mjs"),
    'import http from "node:http"; http.createServer((_, r) => r.end("ok")).listen(process.argv[2]);',
  );
  writeFileSync(join(scripts, "coagenthub-backup.sh"), "#!/bin/bash\nexit 0\n");
  writeFileSync(
    join(scripts, "coagenthub-watchdog.sh"),
    "#!/bin/bash\nexit 0\n",
  );
  chmodSync(join(scripts, "coagenthub-backup.sh"), 0o755);
  chmodSync(join(scripts, "coagenthub-watchdog.sh"), 0o755);
  writeFileSync(join(scripts, "coagenthub-prod.sh"), readFileSync(PROD));
  chmodSync(join(scripts, "coagenthub-prod.sh"), 0o755);

  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), "#!/bin/bash\nexit 0\n");
  chmodSync(join(bin, "pnpm"), 0o755);

  return {
    dir,
    prod: join(scripts, "coagenthub-prod.sh"),
    path: `${bin}:${process.env.PATH}`,
  };
}

function waitForListening(child, port) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
        clearInterval(timer);
        resolve();
      } catch {
        if (child.exitCode !== null) {
          clearInterval(timer);
          reject(new Error(`service exited with ${child.exitCode}`));
        }
      }
    }, 50);
  });
}

function listeningPid(port) {
  return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
}

describe("coagenthub-prod restart", () => {
  it("restart without arguments replaces both listening processes", async () => {
    const serverPort = 33101;
    const webPort = 33100;
    const fixture = serviceFixture(serverPort);
    pidFiles.push(
      `/tmp/coagenthub-prod-${serverPort}.pid`,
      `/tmp/coagenthub-prod-web-${webPort}.pid`,
    );
    const server = spawn(
      NODE,
      [join(fixture.dir, "packages/backend/server/dist/server.mjs")],
      {
        env: { ...process.env, PORT: String(serverPort) },
        stdio: "ignore",
      },
    );
    const web = spawn(NODE, [join(fixture.dir, "serve.mjs"), String(webPort)], {
      stdio: "ignore",
    });
    children.push(server, web);
    await Promise.all([
      waitForListening(server, serverPort),
      waitForListening(web, webPort),
    ]);
    const oldServer = listeningPid(serverPort);
    const oldWeb = listeningPid(webPort);

    execFileSync("bash", [fixture.prod, "restart"], {
      env: {
        ...process.env,
        PATH: fixture.path,
        COAGENTHUB_NODE_BIN: NODE,
        COAGENTHUB_SERVER_PORT: String(serverPort),
        COAGENTHUB_WEB_PORT: String(webPort),
      },
      stdio: "pipe",
    });

    const newServer = listeningPid(serverPort);
    const newWeb = listeningPid(webPort);
    expect(newServer).not.toBe(oldServer);
    expect(newWeb).not.toBe(oldWeb);
    expect(existsSync(`/tmp/coagenthub-prod-${serverPort}.pid`)).toBe(true);
    expect(existsSync(`/tmp/coagenthub-prod-web-${webPort}.pid`)).toBe(true);
  }, 20000);
});
