// scripts/coagent.mjs 的纯函数守卫：环境/参数计算、Node 版本门槛、watch 签名比较。
// 恰好三个 test()；launcher 的真实进程行为由 CLI 自检覆盖，不在这里拉起子进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeVersionError, planLaunch, watchChanges, watchSignature } from '../scripts/coagent.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultStatePath = resolve(repoRoot, '.coagent-state.json');

test('planLaunch：run 需 --cwd 并补状态文件；start/run 的缺省、环境变量与命令行优先级', () => {
  // run 缺 --cwd：直接报错，且措辞点明必须是集成 worktree。
  const missingCwd = planLaunch({ command: 'run', argv: ['m.json'], env: {}, repoRoot });
  assert.match(missingCwd.error, /集成 worktree/);

  // run 给全 --cwd：可 spawn，并补上与 start 相同的状态文件。
  const runOk = planLaunch({ command: 'run', argv: ['m.json', '--cwd', '/wt'], env: {}, repoRoot });
  assert.equal(runOk.error, '');
  assert.deepEqual(runOk.args, [
    resolve(repoRoot, 'src/run-mission.ts'),
    'm.json',
    '--cwd',
    '/wt',
    '--state',
    defaultStatePath,
  ]);

  // 调用方自己给了 --state：不重复补，statePath 用调用方的值。
  const runState = planLaunch({
    command: 'run',
    argv: ['m.json', '--cwd', '/wt', '--state', '/tmp/custom.json'],
    env: {},
    repoRoot,
  });
  assert.equal(runState.error, '');
  assert.equal(runState.statePath, '/tmp/custom.json');
  assert.equal(runState.args.filter((arg) => arg === '--state').length, 1);

  // start 空 env：三项缺省，args 只指向 main.ts。
  const startDefault = planLaunch({ command: 'start', argv: [], env: {}, repoRoot });
  assert.equal(startDefault.error, '');
  assert.deepEqual(startDefault.args, [resolve(repoRoot, 'src/main.ts')]);
  assert.equal(startDefault.env.PORT, '3101');
  assert.equal(startDefault.env.COAGENT_STATE, defaultStatePath);
  assert.equal(startDefault.env.COAGENT_AGENT_ENV_PASSTHROUGH, '-');
  assert.equal(startDefault.statePath, defaultStatePath);
  assert.equal(startDefault.url, 'http://127.0.0.1:3101');

  // 调用方已设的环境变量优先于缺省；env 只含三个键，不展开整份环境。
  const callerEnv = {
    PATH: '/somewhere',
    PORT: '4100',
    COAGENT_STATE: '/tmp/from-env.json',
    COAGENT_AGENT_ENV_PASSTHROUGH: 'FOO,BAR',
  };
  const fromEnv = planLaunch({ command: 'start', argv: [], env: callerEnv, repoRoot });
  assert.equal(fromEnv.env.PORT, '4100');
  assert.equal(fromEnv.env.COAGENT_STATE, '/tmp/from-env.json');
  assert.equal(fromEnv.env.COAGENT_AGENT_ENV_PASSTHROUGH, 'FOO,BAR');
  assert.equal(fromEnv.statePath, '/tmp/from-env.json');
  assert.deepEqual(Object.keys(fromEnv.env).sort(), [
    'COAGENT_AGENT_ENV_PASSTHROUGH',
    'COAGENT_STATE',
    'PORT',
  ]);

  // 空串 / 纯空白视为未设置，仍走缺省。
  const blankEnv = { PORT: '  ', COAGENT_STATE: '', COAGENT_AGENT_ENV_PASSTHROUGH: '\t' };
  const fromBlank = planLaunch({ command: 'start', argv: [], env: blankEnv, repoRoot });
  assert.equal(fromBlank.env.PORT, '3101');
  assert.equal(fromBlank.env.COAGENT_STATE, defaultStatePath);
  assert.equal(fromBlank.env.COAGENT_AGENT_ENV_PASSTHROUGH, '-');

  // 命令行选项压过环境变量。
  const fromCli = planLaunch({
    command: 'start',
    argv: ['--port', '4200', '--state', '/tmp/from-cli.json', '--passthrough', 'BAZ'],
    env: { PORT: '4100', COAGENT_STATE: '/tmp/from-env.json', COAGENT_AGENT_ENV_PASSTHROUGH: 'FOO' },
    repoRoot,
  });
  assert.equal(fromCli.env.PORT, '4200');
  assert.equal(fromCli.env.COAGENT_STATE, '/tmp/from-cli.json');
  assert.equal(fromCli.env.COAGENT_AGENT_ENV_PASSTHROUGH, 'BAZ');
  assert.equal(fromCli.url, 'http://127.0.0.1:4200');
});

test('nodeVersionError：低于 24 报错且点明 24，24 及以上通过', () => {
  const low = nodeVersionError('23.11.0');
  assert.equal(typeof low, 'string');
  assert.match(low, /24/);

  const lowV = nodeVersionError('v23.0.0');
  assert.equal(typeof lowV, 'string');
  assert.match(lowV, /24/);

  assert.equal(nodeVersionError('24.0.0'), undefined);
  assert.equal(nodeVersionError('v24.13.0'), undefined);

  // 主版本解析不出来同样是错误，而不是放行。
  const garbage = nodeVersionError('not-a-version');
  assert.equal(typeof garbage, 'string');
  assert.match(garbage, /24/);
});

test('watchSignature / watchChanges：收口与升级算变化，中间态不算', () => {
  const dispatched = watchSignature({
    workItems: [{ id: 'W-1', status: 'dispatched' }],
    openEscalations: [],
  });

  // dispatched → in_progress：还在跑，不算实质变化。
  const inProgress = watchSignature({
    workItems: [{ id: 'W-1', status: 'in_progress' }],
    openEscalations: [],
  });
  assert.deepEqual(watchChanges(dispatched, inProgress), []);

  // dispatched → accepted：工作项收口，算变化。
  const accepted = watchSignature({
    workItems: [{ id: 'W-1', status: 'accepted' }],
    openEscalations: [],
  });
  const acceptedChanges = watchChanges(dispatched, accepted);
  assert.ok(acceptedChanges.length > 0);
  assert.ok(acceptedChanges.some((line) => line.includes('W-1') && line.includes('accepted')));

  // 出现新升级（视图带 id），算变化。
  const escalated = watchSignature({
    workItems: [{ id: 'W-1', status: 'dispatched' }],
    openEscalations: [{ id: 'E-1', question: 'need a decision' }],
  });
  assert.ok(watchChanges(dispatched, escalated).length > 0);

  // 真实 Mission 视图的升级没有 id，只有 attemptId：必须回退到 attemptId，否则检测不到。
  const escalatedByAttempt = watchSignature({
    workItems: [{ id: 'W-1', status: 'dispatched' }],
    openEscalations: [{ attemptId: 'A-9', question: 'need a decision' }],
  });
  assert.ok(watchChanges(dispatched, escalatedByAttempt).length > 0);
});
