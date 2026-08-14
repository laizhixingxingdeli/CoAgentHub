import { ExternalLink, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * 反馈页(网页体验批次):展示项目 GitHub issues 地址 + 「打开」按钮,跳转
 * https://github.com/laizhixingxingdeli/CoAgentHub/issues。入口在侧边栏「反馈」。
 */
const ISSUES_URL = "https://github.com/laizhixingxingdeli/CoAgentHub/issues";

export default function FeedbackPage() {
  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">{t("feedback.title")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("feedback.subtitle")}
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Send className="size-4" />
          {t("feedback.card.title")}
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {t("feedback.card.body")}
        </p>
        <p
          data-testid="feedback-url"
          className="mt-3 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm"
        >
          {ISSUES_URL}
        </p>
        <div className="mt-4 flex justify-end">
          <Button asChild>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              {t("feedback.open")}
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
