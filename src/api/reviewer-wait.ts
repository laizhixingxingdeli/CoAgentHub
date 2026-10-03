import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Platform } from '../application/platform.ts';

export async function waitForReviewerTodos(input: {
  platform: Platform; projectId: string; owner: string; generation: number;
  cursor?: string; waitMs: number; disconnected: () => boolean;
  list: () => Promise<readonly { id: string; notify: boolean }[]>;
}) {
  const until = Date.now() + input.waitMs;
  for (;;) {
    await input.platform.requireReviewerDuty(input.projectId, input.owner, input.generation);
    const todos = (await input.list()).filter((row) => row.notify);
    const cursor = createHash('sha256').update(JSON.stringify(todos)).digest('hex');
    if (cursor !== input.cursor || Date.now() >= until || input.disconnected()) {
      return { changed: cursor !== input.cursor, cursor, todos };
    }
    await sleep(Math.min(250, Math.max(1, until - Date.now())));
  }
}
