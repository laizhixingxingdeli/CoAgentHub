/**
 * 控制面 Principal：给 L3 / Web / CLI 写路径用的可选身份。
 *
 * 这里只做认证（从请求解出身份）。授权在 PolicyEngine：入口先解析
 * 可信身份再求策略。混在一起的话，拒绝理由会随调用点分叉。
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
 * resolver 已识别凭据、但凭据本身已经失效。
 *
 * 过期判定属于凭据提供方；Hub 不拥有 TTL，也不在这里发明任何时长策略。
 */
export interface ExpiredControlCredential {
  readonly status: 'expired';
}

export type ControlPrincipalResolution =
  | ControlPrincipal
  | ExpiredControlCredential
  | undefined;

/**
 * 从请求解出控制面身份。
 * - undefined = 缺失或未知凭据；
 * - { status: 'expired' } = 已识别但已过期；
 * - ControlPrincipal = 已认证身份。
 *
 * 不得把原始 token 写进日志、错误体或 activity。
 */
export type ControlPrincipalResolver = (
  req: IncomingMessage,
) => ControlPrincipalResolution | Promise<ControlPrincipalResolution>;
