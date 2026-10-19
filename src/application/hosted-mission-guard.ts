/**
 * 同一条 Mission 的托管启动占位。
 *
 * 为什么要有这一层：托管运行的入口不止一个——HTTP `/api/control/run-mission`、
 * 队列 worker、自动恢复调度（退避到点 / 答复升级）都走 main.ts 里同一个 runMission
 * 闭包。同一个 Mission 被两条路同时启动时，两边都会去动 Mission 与工作区，最后
 * 互相把 project_busy 写来写去，谁也跑不干净。
 *
 * 因此占位必须在**第一个 await 之前**同步完成，键只取 body.spec.missionId：adapter
 * 目录记忆、Mission 视图读取、工作区准备这些副作用都排在它后面。占位是进程内的
 * 一份 Map，不跨进程、不写状态文件——它不是租约，也不该被当成租约。
 *
 * 重复请求不是错误：它安全地回 0 并说明「已在运行」，既不调用底层，也不去动
 * 原有运行记下的等待原因 / tracker。释放只由持有者自己做（finally），别人的
 * 占位不能被后来的重复请求删掉。
 *
 * 非法 body（缺 spec / 缺 missionId）不占位，原样交给底层原有的参数校验，
 * 免得守卫变成第二套校验口径。
 */

import type { HostedMissionEmit } from './mission-runner.ts';

/** 与 HostedMissionEmit 同一形状；单独命名便于调用方只依赖守卫时也能标注。 */
export type HostedMissionEmitLine = HostedMissionEmit;

/** 宿主运行处理器：拿到 body 与进度通道，返回进程式 exitCode。 */
export type HostedMissionHandler = (
  body: Record<string, unknown>,
  emit: HostedMissionEmitLine,
) => Promise<number>;

export interface HostedMissionGuard {
  /** 包住真正的运行体；同一 missionId 同时只放一个进去。 */
  wrap(handler: HostedMissionHandler): HostedMissionHandler;
  /** 现在有哪些 Mission 被本进程的托管运行占着（观测 / 诊断用）。 */
  active(): readonly string[];
}

function missionIdOf(body: Record<string, unknown>): string | undefined {
  const spec = body.spec;
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return undefined;
  const missionId = (spec as Record<string, unknown>).missionId;
  return typeof missionId === 'string' && missionId.length > 0 ? missionId : undefined;
}

export function createHostedMissionGuard(): HostedMissionGuard {
  const active = new Map<string, true>();

  return {
    wrap(handler) {
      return async (body, emit) => {
        const missionId = missionIdOf(body);
        // 非法 body 不占位：底层 parseHostedMissionBody 的报错口径保持不变。
        if (missionId === undefined) return await handler(body, emit);

        if (active.has(missionId)) {
          emit(
            'stdout',
            `Mission ${missionId} 已在运行，忽略这次重复启动（不会另起一次运行，也不动原有运行的等待原因）`,
          );
          return 0;
        }
        // 占位与检查之间没有 await：同 ID 的第二条请求在这里就出局。
        active.set(missionId, true);
        try {
          return await handler(body, emit);
        } finally {
          // 只删自己那一个：别的 ID 的占位与后来的重复请求都不受影响。
          active.delete(missionId);
        }
      };
    },
    active: () => [...active.keys()],
  };
}
