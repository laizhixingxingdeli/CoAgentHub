/**
 * 消息正文的 Markdown 渲染(spec live-output-hide-thinking-and-autoscroll R7):
 * 任务书/汇报都是 markdown(`#` 标题、`**` 强调、列表、代码块),此前前端
 * 把 `message.body` 当纯文本显示,层级与重点全丢。
 *
 * ⚠️ 防注入:渲染走 react-markdown —— 它把 markdown 解析成 React 元素树,
 * **不经过 innerHTML**,且这里没有启用 rehype-raw,正文里的原始 HTML 只会被
 * 当作普通文本转义显示。链接地址经 react-markdown 默认 urlTransform 过滤
 * (`javascript:` 等非安全协议被移除)。因此本组件(及整个前端源码)不出现
 * dangerouslySetInnerHTML。
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * 元素级样式:项目未装 typography 插件,故用 Tailwind 子元素选择器直接给
 * 标题/列表/代码/引用上样式(与卡片内 text-sm 的排版口径一致)。
 */
const MARKDOWN_CLASSES = [
  "space-y-1 break-words text-sm",
  "[&_h1]:mt-2 [&_h1]:text-base [&_h1]:font-semibold",
  "[&_h2]:mt-2 [&_h2]:text-[0.95rem] [&_h2]:font-semibold",
  "[&_h3]:mt-1.5 [&_h3]:font-semibold",
  "[&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5",
  "[&_a]:underline",
  "[&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-slate-950 [&_pre]:p-2 [&_pre]:text-slate-100",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_hr]:my-2 [&_hr]:border-t",
  "[&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-1 [&_th]:border [&_th]:px-1",
].join(" ");

export function MarkdownBody({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  return (
    <div className={cn(MARKDOWN_CLASSES, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}
