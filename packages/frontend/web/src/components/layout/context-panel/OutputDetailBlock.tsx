/**
 * 输出明细就地展开(frontend-expand-output-detail R1/R2/R3/R4):
 * 把 outputTail 摘要流逐行渲染 —— 带 #id 的行(`[思考 #t7] …`)渲染为可展开
 * 控件,点击调单条明细 API 就地展示完整原文;不带 #id 的行保持纯文本,
 * 不成为按钮/空壳。展开状态按 entryId 保存在组件内:追加新行不收起已展开
 * 条目(R2),失败(404/非 2xx/网络)就地显示原因(R3);运行中与终态任务共用
 * 同一组件(R4)。
 *
 * 容器复用共享 LiveOutput 的终端样式与 testid(`task-live-output`,
 * `bg-slate-950`),保证既有时间线渲染与测试不变。
 *
 * spec live-output-hide-thinking-and-autoscroll(渲染侧三条):
 *  - R3:展开即定位到最新输出(滚到底部),而不是停在顶部。
 *  - R4:运行中追加新行时,仅当追加前已贴着底部(≤32px)才跟随;用户上滚看
 *    历史时不被拉回。判据取最近一次滚动事件后的位置 —— 追加会先抬高
 *    scrollHeight,追加后再量反而会把「刚到底部」误判成「离底很远」。
 *  - R8:未完成的命令(输出流最后一条命令行)在行尾显示已耗时,开始时刻取明细
 *    行自带的 `at`(后端落盘时刻,组件中途挂载也准)。摘要行格式一字不改。
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "@/lib/i18n";
import { type ParsedOutputLine, parseOutputLine } from "@/lib/output-detail";
import { formatDurationMs, useLiveNow } from "@/pages/app/groups/messages/lib";

type DetailState =
  | { status: "loading" }
  | { status: "ok"; text: string }
  | { status: "error"; message: string };

/** 距底部多少像素内算「在底部」:超过就不跟随(spec R4 建议阈值 ≤ 32px)。 */
const FOLLOW_THRESHOLD_PX = 32;
/** 命令行摘要的行首标签(后端 output-parser 对 system.task_started 的渲染)。 */
const COMMAND_LABEL_PREFIX = "[命令";

/**
 * 输出流里最后一条带 #id 的行 —— 它若是命令行,说明该命令还没跑完(命令结束
 * 后解析器必再落工具结果/汇报行,命令行就不再是最末条目)。
 */
function trailingCommandId(lines: readonly ParsedOutputLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.entryId === null) continue;
    return line.line.startsWith(COMMAND_LABEL_PREFIX) ? line.entryId : null;
  }
  return null;
}

/** 条目落盘时刻 → 已耗时文案;时刻不可解析时不猜(返回 null → 不显示)。 */
function elapsedSince(at: string, now: number): string | null {
  const start = Date.parse(at);
  return Number.isFinite(start)
    ? formatDurationMs(Math.max(0, now - start))
    : null;
}

export function OutputDetailBlock({
  groupId,
  taskId,
  text,
  running = false,
}: {
  groupId: string;
  taskId: string;
  text: string;
  /** 任务是否仍在运行:只有运行中的任务才给未完成的命令计时(R8)。 */
  running?: boolean;
}) {
  const lines = useMemo(() => text.split("\n").map(parseOutputLine), [text]);
  // 已展开的条目 id 集合(按 entryId 记忆;追加新行不收起)。
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // entryId → 明细加载状态(成功缓存,折叠再展开不重复请求)。
  const [details, setDetails] = useState<Record<string, DetailState>>({});

  const scrollRef = useRef<HTMLPreElement>(null);
  // 追加前是否贴着底部:初值 true —— 展开即定位到最新输出处(R3)。
  const followBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
  }, []);

  // R3/R4:挂载(展开)与每次追加后滚动到底部 —— 后者受「追加前是否在底部」
  // 约束,用户上滚看历史时不拉回。
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` 是刻意监听的依赖 —— 它的变化(追加新行)就是滚动跟随的触发条件,效果体内只读写 ref
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followBottomRef.current) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, [text]);

  // R8:未完成的命令 = 输出流最末的命令行,且任务仍在运行。
  const pendingCommandId = running ? trailingCommandId(lines) : null;
  const now = useLiveNow(pendingCommandId !== null);
  // 命令开始时刻:明细行自带的 at(后端落盘时刻)。明细不可得时不显示耗时。
  const [startedAtById, setStartedAtById] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    if (pendingCommandId === null) return;
    if (startedAtById[pendingCommandId]) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/groups/${groupId}/tasks/${taskId}/output/${pendingCommandId}`,
        );
        if (!res.ok) return;
        const row = (await res.json()) as { at?: unknown };
        const at = row.at;
        if (cancelled || typeof at !== "string") return;
        setStartedAtById((prev) => ({ ...prev, [pendingCommandId]: at }));
      } catch {
        // 明细取不到(无文件/网络)→ 宁可不显示,不猜一个开始时刻。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingCommandId, groupId, taskId, startedAtById]);
  const pendingElapsed =
    pendingCommandId !== null && startedAtById[pendingCommandId]
      ? elapsedSince(startedAtById[pendingCommandId], now)
      : null;

  const loadDetail = async (entryId: string) => {
    const existing = details[entryId];
    if (existing?.status === "ok" || existing?.status === "loading") {
      return;
    }
    setDetails((prev) => ({ ...prev, [entryId]: { status: "loading" } }));
    try {
      const res = await fetch(
        `/api/groups/${groupId}/tasks/${taskId}/output/${entryId}`,
      );
      if (!res.ok) {
        // 优先透出后端 BizError 的 message(如「明细文件不存在,可能已被
        // 14 天清理」);非 JSON 或没有 message 时回落状态码文案。
        let message: string | null = null;
        try {
          const body = (await res.json()) as { message?: unknown };
          if (typeof body.message === "string" && body.message.length > 0) {
            message = body.message;
          }
        } catch {
          // 非 JSON 响应体,回落状态码文案。
        }
        setDetails((prev) => ({
          ...prev,
          [entryId]: {
            status: "error",
            message: message ?? `明细获取失败: HTTP ${res.status}`,
          },
        }));
        return;
      }
      const row = (await res.json()) as { text?: unknown };
      setDetails((prev) => ({
        ...prev,
        [entryId]: {
          status: "ok",
          text: typeof row.text === "string" ? row.text : "",
        },
      }));
    } catch {
      setDetails((prev) => ({
        ...prev,
        [entryId]: { status: "error", message: "网络错误,明细加载失败" },
      }));
    }
  };

  const handleToggle = (entryId: string) => {
    const willExpand = !expandedIds.has(entryId);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
    if (willExpand) {
      void loadDetail(entryId);
    }
  };

  const renderDetail = (entryId: string) => {
    const state = details[entryId];
    if (!state || state.status === "loading") {
      return <span className="text-slate-400">加载中…</span>;
    }
    if (state.status === "ok") {
      return (
        <span className="whitespace-pre-wrap break-words text-slate-100">
          {state.text || t("tasks.output.empty")}
        </span>
      );
    }
    return (
      <span className="break-words text-status-unconfirmed">
        {state.message}
      </span>
    );
  };

  return (
    <pre
      ref={scrollRef}
      onScroll={handleScroll}
      data-testid="task-live-output"
      className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 px-2 py-1.5 font-mono text-xs leading-relaxed text-slate-100"
    >
      {lines.map((line, index) => {
        const entryId = line.entryId;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 输出流按位置追加,普通行只有位置身份
          <Fragment key={`${entryId ?? "plain"}-${index}`}>
            {index > 0 ? "\n" : null}
            {entryId === null ? (
              line.line
            ) : (
              <span className="block">
                <button
                  type="button"
                  data-testid={`output-entry-toggle-${entryId}`}
                  aria-expanded={expandedIds.has(entryId)}
                  onClick={() => handleToggle(entryId)}
                  className="block w-full rounded px-1 py-0.5 text-left hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {line.line}
                  {entryId === pendingCommandId && pendingElapsed !== null && (
                    <span
                      data-testid={`output-elapsed-${entryId}`}
                      className="ml-1 text-status-running"
                    >
                      (运行中 {pendingElapsed})
                    </span>
                  )}
                </button>
                {expandedIds.has(entryId) && (
                  <span
                    data-testid={`output-entry-detail-${entryId}`}
                    className="block border-l-2 border-slate-700 pl-2"
                  >
                    {renderDetail(entryId)}
                  </span>
                )}
              </span>
            )}
          </Fragment>
        );
      })}
    </pre>
  );
}
