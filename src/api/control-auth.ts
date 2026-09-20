/**
 * 控制面 Principal：给 L3 / Web / CLI 写路径用的可选身份。
 *
 * 与 run token（/api/agent/*）正交——控制头不能代替 run token，
 * run token 也不能代替控制面身份。resolver 由调用方注入；不注入时
 * createApi 保持现状（本地/测试零摩擦）。
 */

import type { IncomingMessage } from 'node:http';

export type ControlRole = 'operator' | 'viewer';

export interface ControlPrincipal {
  readonly id: string;
  readonly role: ControlRole;
}

/**
 * 从请求解出控制面身份。返回 undefined = 缺失或未知凭据 → 401。
 * 不得把原始 token 写进日志、错误体或 activity。
 */
export type ControlPrincipalResolver = (
  req: IncomingMessage,
) => ControlPrincipal | undefined | Promise<ControlPrincipal | undefined>;
