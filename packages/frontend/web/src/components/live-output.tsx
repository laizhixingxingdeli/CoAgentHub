/**
 * 实时输出区(实时进度 feature 共享组件):等宽字体 + 深色底(bg-slate-950),
 * 内容变化时自动滚到底部。TaskPanel(任务行展开)与 RequirementTimeline
 * (需求时间线展开)共用,行为一致 —— 不要在各处重写终端块。
 */

import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";

/** 实时输出区:等宽字体 + 深色底;内容变化时自动滚到底部。 */
export function LiveOutput({ text }: { text: string }): ReactElement {
  const ref = useRef<HTMLPreElement>(null);
  // 与 useAutoScroll 同款:内容变化(高度变化)时滚动到底;不用 text 作依赖
  // (text 变化不触发重渲染,hook 依赖 lint 会报多余依赖)。
  const lastContentHeight = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const height = el.scrollHeight;
    if (height !== lastContentHeight.current) {
      lastContentHeight.current = height;
      el.scrollTop = el.scrollHeight;
    }
  });
  return (
    <pre
      ref={ref}
      data-testid="task-live-output"
      className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 px-2 py-1.5 font-mono text-xs leading-relaxed text-slate-100"
    >
      {text || (
        <span className="text-slate-500">{t("tasks.output.empty")}</span>
      )}
    </pre>
  );
}
