/**
 * 在本机回环地址上监听，并避开 fetch 屏蔽的端口。
 *
 * 为什么要它：这台机器的 TCP 动态端口从 1024 起（`netsh int ipv4 show dynamicport tcp`），
 * 而 Fetch 标准屏蔽了一批端口（1719、2049、5060、6000、6665–6669、10080 等），
 * 两者有 19 个重叠。`listen(0)` 大约千分之一点四的概率分到其中之一；之后任何
 * `fetch` 都直接以 `bad port` 失败——run-mission / run-plan 派出的 agent 连不上
 * 平台自己（platform_unreachable），测试整轮假红。分到了就关掉重绑，比事后重试
 * 整个 Mission 便宜得多。
 */

import type { AddressInfo, Server } from 'node:net';

/**
 * Fetch 标准的屏蔽端口，82 个。来源：在本机 Node v24.13.0（自带 undici 7.18.2）上对 1–15000
 * 每个端口实测 fetch 127.0.0.1，被以 bad port 拒绝的正好是这 82 个；与 undici 8.10.2 源码里的
 * badPorts 表逐项相同。
 *
 * test/loopback-listen.test.ts 逐项核对表内端口确实被 fetch 拒绝——Node 把某个端口移出屏蔽表时
 * 测试会红；表外只抽查几个端口，Node 新增的屏蔽端口不一定查得出来。
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export interface ListenLoopbackOptions {
  /** 缺省 127.0.0.1：观测面 / API 只对本机开放。 */
  readonly host?: string;
  /** port 为 0 时最多重绑几次。缺省 20：连续 20 次都撞上屏蔽端口，说明环境本身有问题，该报错而不是一直试。 */
  readonly maxAttempts?: number;
  /** 判定端口是否不可用。只给测试注入用；缺省查 FETCH_BLOCKED_PORTS。 */
  readonly isBlocked?: (port: number) => boolean;
}

/**
 * 监听并返回实际端口。
 *
 * - port 为 0：分到被屏蔽的端口就关掉重绑，最多 maxAttempts 次；超出就报错，且 server 不处于监听状态。
 * - port 非 0：照原样监听一次，不重试也不换端口——调用方点名要的端口，换掉就不是它要的服务了。
 * - 监听出错（例如 EADDRINUSE）以拒绝返回。原来 `listen(port, host, done)` 的写法遇到错误
 *   只会触发 'error' 事件，等待它的 Promise 永远不结束。
 */
export async function listenLoopback(
  server: Server,
  port: number,
  options: ListenLoopbackOptions = {},
): Promise<number> {
  const host = options.host ?? '127.0.0.1';
  const maxAttempts = options.maxAttempts ?? 20;
  const isBlocked = options.isBlocked ?? ((candidate: number) => FETCH_BLOCKED_PORTS.has(candidate));
  const tried: number[] = [];
  for (let attempt = 1; ; attempt += 1) {
    await listenOnce(server, port, host);
    const actual = (server.address() as AddressInfo).port;
    if (port !== 0 || !isBlocked(actual)) return actual;
    tried.push(actual);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (attempt >= maxAttempts) {
      throw new Error(
        `连续 ${maxAttempts} 次分到 fetch 屏蔽的端口（${tried.join('、')}），放弃监听。` +
          '检查本机 TCP 动态端口范围：netsh int ipv4 show dynamicport tcp。',
      );
    }
  }
}

function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
