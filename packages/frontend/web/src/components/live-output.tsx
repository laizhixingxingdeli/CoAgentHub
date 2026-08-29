/**
 * 实时输出区(TaskPanel 任务行展开用):等宽字体 + 深色底(bg-slate-950)。
 * RequirementTimeline 侧不直接复用本组件 —— OutputDetailBlock 复制了同样的
 * 终端样式与 testid(`task-live-output`, `bg-slate-950`),保证既有时间线渲染
 * 与测试不变;两处滚动语义按 spec R3/R4 保持一致。
 *
 * spec live-output-hide-thinking-and-autoscroll(渲染侧两条):
 *  - R3:展开即定位到最新输出(滚到底部),而不是停在顶部。
 *  - R4:追加新行时,仅当追加前已贴着底部(≤32px)才跟随;用户上滚看历史时
 *    不被拉回。判据取最近一次滚动事件后的位置 —— 追加会先抬高 scrollHeight,
 *    追加后再量反而会把「刚到底部」误判成「离底很远」。
 */

import type { ReactElement } from "react";
import { useCallback, useEffect, useRef } from "react";
import { t } from "@/lib/i18n";

/** 距底部多少像素内算「在底部」:超过就不跟随(spec R4 建议阈值 ≤ 32px)。 */
const FOLLOW_THRESHOLD_PX = 32;

/** 实时输出区:等宽字体 + 深色底;追加新行时仅当贴着底部才自动跟随。 */
export function LiveOutput({ text }: { text: string }): ReactElement {
  const ref = useRef<HTMLPreElement>(null);
  // 追加前是否贴着底部:初值 true —— 展开即定位到最新输出处(R3)。
  const followBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    followBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
  }, []);

  // R3/R4:挂载(展开)与每次追加后滚动到底部 —— 后者受「追加前是否在底部」
  // 约束,用户上滚看历史时不拉回。
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` 是刻意监听的依赖 —— 它的变化(追加新行)就是滚动跟随的触发条件,效果体内只读写 ref
  useEffect(() => {
    const el = ref.current;
    if (!el || !followBottomRef.current) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      onScroll={handleScroll}
      data-testid="task-live-output"
      className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 px-2 py-1.5 font-mono text-xs leading-relaxed text-slate-100"
    >
      {text || (
        <span className="text-slate-500">{t("tasks.output.empty")}</span>
      )}
    </pre>
  );
}
