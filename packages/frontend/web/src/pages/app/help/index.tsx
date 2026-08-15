import {
  BookOpen,
  FolderKanban,
  ListChecks,
  MessageSquare,
  Plus,
  Users,
} from "lucide-react";
import { t } from "@/lib/i18n";

/**
 * 帮助页(网页体验批次):平台功能介绍 + 简要使用步骤(建群 / 发消息 / 发任务 /
 * 看任务 / 绑定项目)。入口在侧边栏「帮助」。
 */
const STEPS: Array<{
  icon: typeof Plus;
  titleKey: import("@/lib/i18n").DictKey;
  bodyKey: import("@/lib/i18n").DictKey;
}> = [
  {
    icon: Plus,
    titleKey: "help.step.create.title",
    bodyKey: "help.step.create.body",
  },
  {
    icon: MessageSquare,
    titleKey: "help.step.message.title",
    bodyKey: "help.step.message.body",
  },
  {
    icon: Users,
    titleKey: "help.step.task.title",
    bodyKey: "help.step.task.body",
  },
  {
    icon: ListChecks,
    titleKey: "help.step.watch.title",
    bodyKey: "help.step.watch.body",
  },
  {
    icon: FolderKanban,
    titleKey: "help.step.project.title",
    bodyKey: "help.step.project.body",
  },
];

export default function HelpPage() {
  return (
    <div className="mx-auto w-full max-w-[1440px] p-4 sm:p-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">{t("help.title")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("help.subtitle")}
        </p>
      </div>

      <div className="mb-8 rounded-lg border bg-card p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <BookOpen className="size-4" />
          {t("help.features.title")}
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {t("help.features.body")}
        </p>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3 text-sm font-medium">
          {t("help.steps.title")}
        </div>
        <ol className="divide-y">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <li key={step.titleKey} className="flex gap-3 px-4 py-3">
                <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {i + 1}. {t(step.titleKey)}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                    {t(step.bodyKey)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
