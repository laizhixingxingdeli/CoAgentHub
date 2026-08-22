/**
 * ANSI 转义序列剥离(executor-task 拆分,ANSI 剥离票):流式输出在唯一源头
 * (queue.onOutput)剥离后再进环形缓冲与 WS 广播;report.ts 汇报解析共用
 * 同一份正则。跨 chunk 的半截转义序列由 createAnsiStripper 扣尾处理。
 */

/** ANSI 颜色码清理(解析前剥掉控制序列)。全仓只有这一份,report.ts 与输出路径共用。 */
export const ANSI_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** 转义序列中出现在终结字节之前的「可续字节」(前导符号/参数)。 */
const ANSI_CONTINUE_RE = /[[()#;?0-9]/;

/** 剥掉整段文本中的全部 ANSI 转义序列(单块文本,无跨 chunk 问题)。 */
export function stripAnsi(text: string): string {
  return (text ?? "").replace(ANSI_RE, "");
}

/**
 * 流式 ANSI 剥离器:chunk 是流式片段,一个转义序列可能被切成两半
 * (`\x1b[3` 落前块、`2m` 落后块),逐 chunk 套正则两边都不匹配。做法:chunk
 * 结尾若疑似半截转义序列(尾部是 ESC + 一串可续字节),扣住不发、拼上下一个
 * chunk 一起剥;否则按原 chunk 直接剥。返回按序喂入 chunk、吐出剥离文本的函数。
 */
export function createAnsiStripper(): (chunk: string) => string {
  let pending = "";
  return (chunk: string): string => {
    const text = pending + chunk;
    pending = "";
    // 从尾部反向扫:先连续跳过可续字节,遇到 ESC 说明结尾可能是半截转义。
    let tailStart = -1;
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === "\u001b" || ch === "\u009b") {
        tailStart = i;
        break;
      }
      if (!ANSI_CONTINUE_RE.test(ch)) break;
    }
    if (tailStart >= 0) {
      pending = text.slice(tailStart);
      return stripAnsi(text.slice(0, tailStart));
    }
    return stripAnsi(text);
  };
}
