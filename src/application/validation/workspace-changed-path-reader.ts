/**
 * 生产 ChangedPathReader：只信 WorkspaceManager.diff 的 .files。
 *
 * 禁止把执行者自报的文件清单或证据记录当作 pass 输入。
 */

import type { WorkspaceManager } from '../workspace.ts';
import type { ChangedPathReader } from './ports.ts';

export class WorkspaceChangedPathReader implements ChangedPathReader {
  #workspace: WorkspaceManager;

  constructor(workspace: WorkspaceManager) {
    this.#workspace = workspace;
  }

  async listChanged(input: {
    readonly missionId: string;
    readonly baseRevision: string;
    readonly projectRoot: string;
  }): Promise<readonly string[]> {
    const diff = await this.#workspace.diff(
      input.missionId,
      input.baseRevision,
      input.projectRoot,
    );
    return [...diff.files];
  }
}
