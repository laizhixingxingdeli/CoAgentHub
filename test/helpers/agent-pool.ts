import type { AgentRole } from '../../src/application/agent-pool.ts';

/** 历史运行测试显式配置；生产环境没有默认候选。 */
export const DEFAULT_TEST_AGENT_POOL: readonly {
  readonly role: AgentRole;
  readonly profileId: string;
  readonly endpoint: string;
}[] = [
  { role: 'coordinator', profileId: 'coordinator-grok', endpoint: 'local' },
  { role: 'executor', profileId: 'exec-qwen-flash', endpoint: 'local' },
  { role: 'executor', profileId: 'exec-hy3', endpoint: 'local' },
  { role: 'executor', profileId: 'exec-mimo', endpoint: 'local' },
];

