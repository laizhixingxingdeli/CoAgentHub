/**
 * 停止/回滚控制按钮(共享):被 TaskPanel 与需求时间线任务卡片
 * 复用,避免两段相同的按钮 UI + 禁用/提示逻辑。无权限或归档只读时禁用并给出
 * 提示。title 挂在包裹 span 上 —— disabled 按钮自身不触发 title 悬浮提示。
 */
import type { ComponentProps, ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export function ControlButton({
  canControl,
  readOnly,
  disabled,
  ...props
}: ComponentProps<typeof Button> & {
  canControl: boolean;
  readOnly: boolean;
}): ReactElement {
  const btn = (
    <Button {...props} disabled={disabled || !canControl || readOnly} />
  );
  if (canControl && !readOnly) {
    return btn;
  }
  const hint = readOnly
    ? t("tasks.hint.readOnly")
    : t("tasks.hint.noPermission");
  return (
    <span title={hint} className="inline-flex">
      {btn}
    </span>
  );
}
