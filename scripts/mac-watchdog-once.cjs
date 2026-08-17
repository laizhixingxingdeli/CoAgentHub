#!/usr/bin/env node
// CoAgentHub 看门狗单次执行(launchd 载体)。
// 由 TCC 白名单内二进制(如 ~/.hermes/node/bin/node)启动:launchd 加载时以该
// 二进制为 responsible process,spawn 的 /bin/bash 与脚本继承其 ~/Desktop 访问权限,
// 从而绕过 cron/launchd 默认无 Desktop 权限(TCC "Operation not permitted")的问题。
// launchd 每 5 分钟(StartInterval)+ 登录时(RunAtLoad)各跑一次;健康时静默退出。
const { spawnSync } = require("node:child_process");
const REPO = "/Users/apple/Desktop/Projects/CoAgentHub";
const r = spawnSync("/bin/bash", [REPO + "/scripts/coagenthub-watchdog.sh", "--once"], {
  stdio: "inherit",
  env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:" + process.env.HOME + "/.local/bin:/usr/bin:/bin:" + (process.env.PATH || "") },
});
process.exit(r.status ?? 1);
