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
 */

import { Fragment, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { parseOutputLine } from "@/lib/output-detail";

type DetailState =
  | { status: "loading" }
  | { status: "ok"; text: string }
  | { status: "error"; message: string };

export function OutputDetailBlock({
  groupId,
  taskId,
  text,
}: {
  groupId: string;
  taskId: string;
  text: string;
}) {
  const lines = useMemo(() => text.split("\n").map(parseOutputLine), [text]);
  // 已展开的条目 id 集合(按 entryId 记忆;追加新行不收起)。
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // entryId → 明细加载状态(成功缓存,折叠再展开不重复请求)。
  const [details, setDetails] = useState<Record<string, DetailState>>({});

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
