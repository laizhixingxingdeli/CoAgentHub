#!/usr/bin/env node
// CoAgentHub 每日备份单次执行(launchd 载体)。原理同 mac-watchdog-once.cjs。
const { spawnSync } = require("node:child_process");
const REPO = "/Users/apple/Desktop/Projects/CoAgentHub";
const r = spawnSync("/bin/bash", [REPO + "/scripts/coagenthub-backup.sh"], {
  stdio: "inherit",
  env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:" + process.env.HOME + "/.local/bin:/usr/bin:/bin:" + (process.env.PATH || "") },
});
process.exit(r.status ?? 1);
