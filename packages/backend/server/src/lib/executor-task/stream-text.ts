import { type OutputEntry, observeGenericSkippedEvent } from "./output-parser";

/**
 * 摘要流文本(spec live-output-hide-thinking-and-autoscroll R1):`kind=thinking`
 * 的条目不进摘要流 —— 用户要看的是 agent 在做什么(工具/命令/汇报),思考行会把
 * 动作行稀释(实测占缓冲行数 64%-95%)。判据取解析器已解析出的 kind,不做
 * 「思考」二字文本匹配(后者会误伤汇报正文里出现该词的行)。
 *
 * ⚠️ 只截断摘要流:明细仍由调用方对**未过滤**的 entries 逐条 appendTaskDetail
 * 落盘,思考全文照常可经 ?detail=1 / 单条展开取回(R2)。
 *
 * L2:空摘要(raw(""))同样不进摘要流 —— 原子码/通用解析器对空白输入行产出
 * raw("") 条目,逐条 join 会把空行写进 task_output(实测 AtomCode 摘要流空行
 * 占比过高);共享边界过滤并计为一次 <empty> 跳过(计数 + 去重日志),与
 * 通用解析器的无语义 JSON 跳过同一观测体系。
 */
function summaryStreamText(entries: readonly OutputEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "thinking") continue;
    if (entry.summary.length === 0) {
      observeGenericSkippedEvent("<empty>");
      continue;
    }
    lines.push(entry.summary);
  }
  // 整批都是 thinking/空摘要时不产出空行:缓冲与 WS 广播都不该收到空 task_output。
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * 实时界面流文本(spec live-output-only-agent-narration R1):仅 kind=report 进界面,
 * 其余类别(tool/command/result/thinking/error/raw)不进界面但全量持久化。判据
 * 是解析器产出的 kind,代替文本前缀匹配;错误永不折叠的约束保留在持久化侧,
 * 界面侧错误不显示但明细/DB 仍逐字保留,实现时在 summaryStreamText 注释已记下。
 */
function liveStreamText(entries: readonly OutputEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "report") continue;
    // R2:纯空白正文不进界面(trim 后的空字符串,如样本里的 `\n`)。
    if (entry.summary.trim().length === 0) continue;
    lines.push(entry.summary);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** L2 可观测性导出:共享摘要过滤函数(供定向回归测试直接断言空行治理)。 */
export { liveStreamText, summaryStreamText };
