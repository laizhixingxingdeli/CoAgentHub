#!/usr/bin/env node
// CoAgentHub 零依赖启动器：setup / start / doctor / run / watch。
//
// 只 import node: 内置模块，纯 ESM（.mjs），同一份代码跑 Windows / macOS / Linux。
// 纯逻辑（版本判断、start/run 的环境与参数计算、watch 签名）抽成导出函数，
// 测试 import 本模块时不会执行 main。
//
// 设计底线：只替新人做「显式声明」这一步——把状态文件、透传名单、端口写清楚，
// 不放宽 spawn 的环境过滤（COAGENT_AGENT_ENV_PASSTHROUGH 缺省 '-'，不是 '*'），
// 也不碰 ~/.pi 与任何凭据。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WINDOWS = process.platform === 'win32';
const DEFAULT_PORT = '3101';
const DEFAULT_PASSTHROUGH = '-';
const STATE_FILE_NAME = '.coagent-state.json';
/** Mission 到这几个状态就没有等待的意义了（首次读到也直接退出）。 */
const TERMINAL_MISSION_STATUSES = new Set(['awaiting_review', 'completed', 'blocked']);
/** 工作项只有收口状态才算「签名变化」，dispatched/in_progress/submitted 都是中间态。 */
const TERMINAL_WORK_ITEM_STATUSES = new Set(['accepted', 'rejected', 'blocked', 'retired']);
const SIGNATURE_FIELDS = [
  ['status', '状态'],
  ['waitReason', '等待原因'],
  ['paused', '暂停'],
  ['parked', '停泊'],
  ['contractRevision', '契约版本'],
  ['escalations', '未答复升级'],
  ['terminalWorkItems', '已收口工作项'],
  ['finalReviewVerdict', '最终检视结论'],
];

const HELP_TEXT = [
  'CoAgentHub 启动器（零依赖，Node 主版本 >= 24）',
  '',
  '用法：',
  '  node scripts/coagent.mjs setup [--force] [--skip-mcp]',
  '      检查 Node / git，npm ci 安装工作区依赖，并构建 MCP server。',
  '      --force 全部重来；--skip-mcp 跳过 MCP 构建。',
  '  node scripts/coagent.mjs start [--port <n>] [--state <路径>] [--passthrough <逗号名单>]',
  '      启动平台（缺省 http://127.0.0.1:3101）。',
  '  node scripts/coagent.mjs doctor [--port <n>] [--state <路径>]',
  '      只读自检：环境、依赖、状态文件、平台健康。',
  '  node scripts/coagent.mjs run <mission.json> --cwd <集成 worktree> [其余 run-mission 参数…]',
  '      命令行派发入口（L3）：必须显式给出 --cwd。',
  '  node scripts/coagent.mjs watch <missionId> [--minutes N] [--interval S] [--port P]',
  '      等 Mission 出现实质变化或结束；缺省 45 分钟、每 30 秒查一次。',
  '  node scripts/coagent.mjs help',
  '      显示本页。',
  '',
  '环境缺省：COAGENT_STATE=<仓库根>/.coagent-state.json，COAGENT_AGENT_ENV_PASSTHROUGH=-，PORT=3101。',
  '优先级：命令行选项 > 调用方已设的环境变量 > 缺省。',
].join('\n');

/**
 * Node 主版本门槛。接受 '24.13.0' 或 'v24.13.0'；>= 24 返回 undefined。
 * 低于 24、或压根解析不出主版本，都返回一句含「24」的报错。
 */
export function nodeVersionError(version) {
  const raw = typeof version === 'string' ? version.trim() : '';
  const majorText = raw.replace(/^v/i, '').split('.')[0];
  const major = /^\d+$/.test(majorText) ? Number.parseInt(majorText, 10) : Number.NaN;
  if (Number.isNaN(major)) {
    return `无法识别 Node.js 版本「${raw}」：需要主版本 >= 24（例如 v24.13.0）。`;
  }
  if (major < 24) {
    return `Node.js 版本过低：当前 ${raw}，需要主版本 >= 24，请升级 Node.js 后重试。`;
  }
  return undefined;
}

function optionValue(argv, name) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== name) continue;
    const value = argv[i + 1];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    return undefined;
  }
  return undefined;
}

function nonEmpty(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const RUN_CWD_ERROR =
  'run 需要显式给出 --cwd：它必须是目标项目的集成 worktree。' +
  'run-mission 缺省的 cwd 是当前目录，在本仓里直接跑会把任务派到平台自己身上。';

/**
 * 计算 start / run 的实际环境、参数与提示用值。
 *
 * 优先级：命令行选项 > 调用方已设的环境变量（空串 / 纯空白视为未设置）> 缺省。
 * env 只含 PORT / COAGENT_STATE / COAGENT_AGENT_ENV_PASSTHROUGH 三个键，
 * 不展开整份调用方环境——把环境交给子进程是 spawn 层的显式声明，不在这里放开。
 */
export function planLaunch({ command, argv = [], env = {}, repoRoot: root }) {
  const cliPort = optionValue(argv, '--port');
  const cliState = optionValue(argv, '--state');
  const cliPassthrough = optionValue(argv, '--passthrough');

  const port = cliPort ?? nonEmpty(env.PORT) ?? DEFAULT_PORT;
  const statePath = cliState ?? nonEmpty(env.COAGENT_STATE) ?? resolve(root, STATE_FILE_NAME);
  const passthrough =
    cliPassthrough ?? nonEmpty(env.COAGENT_AGENT_ENV_PASSTHROUGH) ?? DEFAULT_PASSTHROUGH;

  const launchEnv = {
    PORT: port,
    COAGENT_STATE: statePath,
    COAGENT_AGENT_ENV_PASSTHROUGH: passthrough,
  };
  const url = `http://127.0.0.1:${port}`;

  if (command === 'run') {
    const hasCwd = argv.includes('--cwd');
    const args = [resolve(root, 'src/run-mission.ts'), ...argv];
    // run-mission 自己的 --state 缺省是相对当前目录的 .coagent-state.json，
    // 会在别处悄悄新建一份；调用方没给就补上与 start 相同的状态文件。
    if (!argv.includes('--state')) args.push('--state', statePath);
    return { error: hasCwd ? '' : RUN_CWD_ERROR, env: launchEnv, args, statePath, url };
  }

  return { error: '', env: launchEnv, args: [resolve(root, 'src/main.ts')], statePath, url };
}

/**
 * 只读签名：把 Mission 视图压成八个稳定字符串字段。
 * 升级条目在 Mission 视图里没有 id，只有 attemptId——不只看 id，否则新升级检测不到。
 */
export function watchSignature(view) {
  const source = view && typeof view === 'object' ? view : {};
  const escalations = (Array.isArray(source.openEscalations) ? source.openEscalations : [])
    .map((item, index) => {
      const identity = String(item?.id ?? item?.attemptId ?? index);
      return { identity, line: `${identity}:${String(item?.question ?? '').slice(0, 40)}` };
    })
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0))
    .map((entry) => entry.line)
    .join('\n');
  const terminalWorkItems = (Array.isArray(source.workItems) ? source.workItems : [])
    .filter((item) => TERMINAL_WORK_ITEM_STATUSES.has(item?.status))
    .map((item) => `${item.id}:${item.status}`)
    .sort()
    .join('\n');
  return {
    status: String(source.status ?? ''),
    waitReason: String(source.waitReason ?? ''),
    paused: source.paused ? 'true' : 'false',
    parked: source.parked ? 'true' : 'false',
    contractRevision: String(source.contractRevision ?? ''),
    escalations,
    terminalWorkItems,
    finalReviewVerdict: String(source.finalReview?.verdict ?? ''),
  };
}

/** 比较两份签名，逐条说明差异；全同返回空数组。 */
export function watchChanges(before, after) {
  const changes = [];
  for (const [field, label] of SIGNATURE_FIELDS) {
    const from = before?.[field] ?? '';
    const to = after?.[field] ?? '';
    if (from === to) continue;
    changes.push(`${label}：${from || '(空)'} → ${to || '(空)'}`);
  }
  return changes;
}

function printHelp() {
  console.log(HELP_TEXT);
}

function spawnInherited(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // 子进程已经退出。
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code) => {
    process.exitCode = typeof code === 'number' ? code : 1;
  });
  return child;
}

/**
 * 从 startDir 逐级向上查找 node_modules/<name>/package.json 所在的包目录。
 * 只认 package.json 是否存在：ESM-only 的包只导出 import 条件，
 * require.resolve 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED，不能用来判断装没装。
 * name 整段（含 @scope/）作为 path.resolve 的一个参数，不自己拆分。
 */
export function findPackageDir(startDir, name) {
  let dir = resolve(startDir);
  for (;;) {
    const pkgDir = resolve(dir, 'node_modules', name);
    if (existsSync(resolve(pkgDir, 'package.json'))) return pkgDir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * pi 模型清单的体检分级：0 项要告诉新人怎么登录 / 登记，>= 1 项才算可用。
 * 返回 { level: 'warn' | 'ok', text }，由调用方决定打 ! 还是 ✓。
 */
export function classifyModelCount(n) {
  if (n === 0) {
    return {
      level: 'warn',
      text: 'pi 模型清单 0 项。先在 npx pi 里用 /login 登录一个 provider，或在 ~/.pi/agent/models.json 登记兼容端点。见 docs/models.md',
    };
  }
  return { level: 'ok', text: `pi 模型清单可用（${n} 项）` };
}

/** Windows 上 npm 是 .cmd：整条命令字符串交给 shell；POSIX 仍走 argv、不开 shell。 */
function spawnNpm(args, options) {
  if (WINDOWS) return spawnSync(args.join(' '), { ...options, shell: true });
  return spawnSync(args[0], args.slice(1), options);
}

function runSetup(argv) {
  const force = argv.includes('--force');
  const skipMcp = argv.includes('--skip-mcp');

  const git = spawnSync('git', ['--version'], { stdio: 'ignore' });
  if (git.error || git.status !== 0) {
    console.error('✗ git 不可用：`git --version` 失败，请先安装 git。');
    process.exitCode = 1;
    return;
  }

  if (existsSync(resolve(repoRoot, 'node_modules')) && !force) {
    console.log('! 根 node_modules 已存在，跳过 npm ci（--force 可强制重来）。');
  } else {
    console.log('→ npm ci：工作区依赖一次装进根 node_modules…');
    const install = spawnNpm(['npm', 'ci'], { cwd: repoRoot, stdio: 'inherit' });
    if (install.error || install.status !== 0) {
      console.error('✗ npm ci 失败，setup 中止。');
      process.exitCode = install.status ?? 1;
      return;
    }
  }

  const mcpDist = resolve(repoRoot, 'integrations/codex/mcp-server/dist/index.js');
  if (skipMcp) {
    console.log('! 按 --skip-mcp 跳过 MCP server 构建。');
  } else if (existsSync(mcpDist) && !force) {
    console.log('! MCP server 产物已存在，跳过构建（--force 可强制重建）。');
  } else {
    console.log('→ 构建 MCP server（integrations/codex/mcp-server）…');
    const build = spawnNpm(['npm', 'run', 'build', '-w', 'integrations/codex/mcp-server'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    if (build.error || build.status !== 0) {
      console.error('✗ MCP server 构建失败。');
      process.exitCode = build.status ?? 1;
      return;
    }
  }

  console.log('');
  console.log('✓ setup 完成。下一步：');
  console.log('  node scripts/coagent.mjs start    # 启动平台（首次会显式创建状态文件）');
  console.log('  node scripts/coagent.mjs doctor   # 只读自检');
  console.log('  文档：docs/getting-started.md');
}

function runStart(argv) {
  const plan = planLaunch({ command: 'start', argv, env: process.env, repoRoot });
  if (plan.error) {
    console.error(plan.error);
    process.exitCode = 1;
    return;
  }
  console.log(
    `COAGENT_AGENT_ENV_PASSTHROUGH=${plan.env.COAGENT_AGENT_ENV_PASSTHROUGH}` +
      "（缺省 '-' 表示不额外透传，只保留基线）。",
  );
  console.log(`状态文件：${plan.statePath}`);
  console.log(`平台地址：${plan.url}`);
  spawnInherited(plan.args, plan.env);
}

function runRun(argv) {
  const plan = planLaunch({ command: 'run', argv, env: process.env, repoRoot });
  if (plan.error) {
    console.error(plan.error);
    process.exitCode = 1;
    return;
  }
  console.log(
    `COAGENT_AGENT_ENV_PASSTHROUGH=${plan.env.COAGENT_AGENT_ENV_PASSTHROUGH}` +
      "（缺省 '-' 表示不额外透传，只保留基线）。",
  );
  console.log(`状态文件：${plan.statePath}`);
  spawnInherited(plan.args, plan.env);
}

async function runDoctor(argv) {
  console.log('CoAgentHub doctor（只读自检）');
  let failed = false;
  const ok = (text) => console.log(`✓  ${text}`);
  const warn = (text) => console.log(`!  ${text}`);
  const bad = (text) => {
    failed = true;
    console.log(`✗  ${text}`);
  };

  const plan = planLaunch({ command: 'start', argv, env: process.env, repoRoot });

  const versionError = nodeVersionError(process.version);
  if (versionError) bad(`Node.js：${versionError}`);
  else ok(`Node.js ${process.version}（主版本 >= 24）`);

  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (git.error || git.status !== 0) bad('git 不可用：`git --version` 失败');
  else ok('git 可用');

  const piDir = resolve(repoRoot, 'adapters/pi');
  const missingPiDeps = [];
  for (const name of ['tsx', '@earendil-works/pi-coding-agent']) {
    if (findPackageDir(piDir, name) === undefined) missingPiDeps.push(name);
  }
  if (missingPiDeps.length > 0) {
    bad(`adapters/pi 依赖缺失：${missingPiDeps.join('、')}（先跑 node scripts/coagent.mjs setup）`);
  } else {
    ok('adapters/pi 依赖可解析（tsx、pi-coding-agent）');
  }

  if (existsSync(resolve(repoRoot, 'integrations/codex/mcp-server/dist/index.js'))) {
    ok('MCP server 产物存在');
  } else {
    bad('MCP server 产物不存在（先跑 node scripts/coagent.mjs setup）');
  }

  if (existsSync(plan.statePath)) ok(`状态文件存在：${plan.statePath}`);
  else warn(`状态文件不存在：${plan.statePath}（首次 start 会显式创建）`);

  try {
    const response = await fetch(`${plan.url}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) ok(`平台健康：${plan.url}/api/health`);
    else warn(`平台未就绪：${plan.url}/api/health 返回 HTTP ${response.status}`);
  } catch {
    warn(`平台未运行：${plan.url}/api/health 2 秒内不可达`);
  }

  const declaredPassthrough = nonEmpty(process.env.COAGENT_AGENT_ENV_PASSTHROUGH);
  if (declaredPassthrough === undefined) {
    warn(
      'COAGENT_AGENT_ENV_PASSTHROUGH 未声明（用 scripts/coagent.mjs 的 start / run 会自动设为 -；直接 node src/main.ts 或 src/run-mission.ts 则必须自己设）',
    );
  } else if (declaredPassthrough === '-') {
    ok("COAGENT_AGENT_ENV_PASSTHROUGH 已声明不额外透传（'-'）");
  } else {
    const names = declaredPassthrough
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    ok(`COAGENT_AGENT_ENV_PASSTHROUGH 已声明：${names.join('、')}`);
  }

  const models = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'models'], {
    cwd: resolve(repoRoot, 'adapters/pi'),
    timeout: 60_000,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  let modelCount;
  if (!models.error && models.status === 0) {
    try {
      const parsed = JSON.parse(models.stdout);
      if (Array.isArray(parsed)) modelCount = parsed.length;
    } catch {
      // stdout 不是 JSON。
    }
  }
  if (typeof modelCount === 'number') {
    const verdict = classifyModelCount(modelCount);
    if (verdict.level === 'warn') warn(verdict.text);
    else ok(verdict.text);
  } else {
    const reason = models.error
      ? models.error.code === 'ETIMEDOUT'
        ? '超时'
        : '无法执行'
      : models.status !== 0
        ? `退出码 ${models.status}`
        : 'stdout 不是 JSON 数组';
    warn(`pi 模型清单不可用（${reason}）；agent 可能列不出模型`);
  }

  if (failed) process.exitCode = 1;
}

async function fetchMissionView(port, missionId) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/missions/${encodeURIComponent(missionId)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { view: await response.json() };
  } catch (error) {
    return { error: error?.name === 'TimeoutError' ? '请求超时' : '请求失败' };
  }
}

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function runWatch(argv) {
  let missionId;
  let minutes = 45;
  let interval = 30;
  let port;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--minutes') minutes = Number(argv[++i]);
    else if (arg === '--interval') interval = Number(argv[++i]);
    else if (arg === '--port') port = argv[++i];
    else if (typeof arg === 'string' && !arg.startsWith('-') && missionId === undefined) missionId = arg;
    else {
      console.error(`watch：无法识别的参数「${arg}」`);
      printHelp();
      process.exitCode = 1;
      return;
    }
  }
  if (!missionId) {
    printHelp();
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(minutes) || minutes < 0 || !Number.isFinite(interval) || interval <= 0) {
    console.error('watch：--minutes 必须 >= 0，--interval 必须 > 0。');
    process.exitCode = 1;
    return;
  }
  port = nonEmpty(port) ?? nonEmpty(process.env.PORT) ?? DEFAULT_PORT;

  const first = await fetchMissionView(port, missionId);
  if (first.error) {
    console.error(`watch：读取 Mission 失败（${first.error}），退出。`);
    process.exitCode = 2;
    return;
  }
  const baseline = watchSignature(first.view);
  if (TERMINAL_MISSION_STATUSES.has(baseline.status)) {
    console.log(`watch：Mission ${missionId} 已是 ${baseline.status}，无需等待。`);
    return;
  }
  console.log(`watch：开始监视 Mission ${missionId}（每 ${interval} 秒，最多 ${minutes} 分钟）。`);

  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.log(`watch：${minutes} 分钟内无实质变化（status=${baseline.status}），退出。`);
      return;
    }
    await sleep(Math.min(interval * 1000, remaining));
    const next = await fetchMissionView(port, missionId);
    if (next.error) {
      console.error(`watch：读取 Mission 失败（${next.error}），退出。`);
      process.exitCode = 2;
      return;
    }
    const signature = watchSignature(next.view);
    if (TERMINAL_MISSION_STATUSES.has(signature.status)) {
      console.log(`watch：Mission ${missionId} 到达 ${signature.status}，退出。`);
      return;
    }
    const changes = watchChanges(baseline, signature);
    if (changes.length > 0) {
      for (const change of changes) console.log(`变更：${change}`);
      console.log(`watch：Mission ${missionId} 出现实质变化，退出。`);
      return;
    }
    if (Date.now() >= deadline) {
      console.log(`watch：${minutes} 分钟内无实质变化（status=${signature.status}），退出。`);
      return;
    }
  }
}

async function main(argv) {
  const versionError = nodeVersionError(process.version);
  if (versionError) {
    console.error(versionError);
    process.exitCode = 1;
    return;
  }
  const [subcommand, ...rest] = argv;
  if (
    subcommand === undefined ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h'
  ) {
    printHelp();
    return;
  }
  switch (subcommand) {
    case 'setup':
      runSetup(rest);
      return;
    case 'start':
      runStart(rest);
      return;
    case 'run':
      runRun(rest);
      return;
    case 'watch':
      await runWatch(rest);
      return;
    case 'doctor':
      await runDoctor(rest);
      return;
    default:
      console.error(`未知子命令「${subcommand}」。`);
      printHelp();
      process.exitCode = 1;
  }
}

function isDirectExecution() {
  if (typeof process.argv[1] !== 'string' || process.argv[1].length === 0) return false;
  try {
    const invoked = pathToFileURL(resolve(process.argv[1])).href;
    if (invoked === import.meta.url) return true;
    // Windows 上同一路径可能只差盘符大小写。
    return WINDOWS && invoked.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  await main(process.argv.slice(2));
}
