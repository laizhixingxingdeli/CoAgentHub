/**
 * S6 任务书策略模板:方法论文案入库、按 dispatchKind 覆盖、平台段不可覆盖、
 * 改盘上模板无需重建 server。
 */
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTicket,
  loadTicketTemplate,
  resolveTicketTemplatesDir,
} from "@server/lib/executor-task";
import type { QueuedRun } from "../src/lib/executor-task/types";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const envKey = "COAGENTHUB_TICKET_TEMPLATES_DIR";
const originalEnv = process.env[envKey];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[envKey];
  else process.env[envKey] = originalEnv;
});

function useTemplatesDir(dir: string): void {
  process.env[envKey] = dir;
}

function writeTemplates(dir: string, files: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(
      path.join(dir, name),
      typeof body === "string" ? body : JSON.stringify(body, null, 2),
    );
  }
}

function minimalRun(
  overrides: Partial<
    Pick<
      QueuedRun,
      "participantId" | "groupId" | "taskId" | "detached" | "dispatchKind"
    >
  > = {},
): QueuedRun {
  return {
    participantId: "p-exec-1",
    groupId: "g-1",
    taskId: "task-abc-123",
    detached: true,
    dispatchKind: null,
    ...overrides,
  } as QueuedRun;
}

/** 仓库内真实模板的「执行方式」协调者全文(搬家锚点)。 */
function repoCoordinatorMode(): string {
  delete process.env[envKey];
  const t = loadTicketTemplate(null);
  return t.executionMode.coordinator;
}

describe("ticket-template:仓库真相源", () => {
  it("默认目录解析到仓库根 ticket-templates/", () => {
    delete process.env[envKey];
    expect(resolveTicketTemplatesDir()).toBe(
      path.join(repoRoot, "ticket-templates"),
    );
  });

  it("default.json 承载与搬家前一致的执行器汇报四段", () => {
    delete process.env[envKey];
    const t = loadTicketTemplate(null);
    expect(t.report.executor).toContain("提交: <commit hash>");
    expect(t.report.executor).toContain("Token: <本执行消耗的 token 数量>");
    expect(t.report.executor).toContain('遗留: <未完成事项,无则写"无">');
    expect(t.executionMode.executor).toContain("coagenthub-executor");
    expect(t.executionMode.coordinator).toContain("派发成功后立即退出本轮");
    expect(t.specInstruction).toBe(
      "请严格遵循上述文档中的定义进行开发。如有冲突，以 Spec 为准。",
    );
  });
});

describe("ticket-template:R2 dispatchKind 覆盖", () => {
  it("fix 覆盖 coordinatorWithReviewer(lite),requirement 无专属文件回落全局", () => {
    delete process.env[envKey];
    const fix = loadTicketTemplate("fix");
    const req = loadTicketTemplate("requirement");
    const def = loadTicketTemplate(null);

    expect(fix.report.coordinatorWithReviewer).toContain('"lite": true');
    expect(fix.report.coordinatorWithReviewer).toContain("精简档");
    // requirement 无专属文件 → 与全局一致,不报错。
    expect(req.report.coordinatorWithReviewer).toBe(
      def.report.coordinatorWithReviewer,
    );
    expect(req.report.coordinatorWithReviewer).not.toContain('"lite": true');
    // fix 未覆盖的字段仍来自全局。
    expect(fix.executionMode.executor).toBe(def.executionMode.executor);
    expect(fix.report.executor).toBe(def.report.executor);
  });

  it("专属模板缺失 → 静默回落全局,不抛错", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ticket-tpl-missing-"));
    writeTemplates(dir, {
      "default.json": {
        executionMode: {
          coordinator: "MODE-DEFAULT",
          executor: "EXEC-DEFAULT",
          fallbackNote: "",
        },
        report: {
          coordinatorWithReviewer: "R-DEF",
          coordinatorNoReviewer: "R-NO",
          executor: "R-EX",
        },
        specInstruction: "SI",
      },
    });
    useTemplatesDir(dir);
    expect(() => loadTicketTemplate("fix")).not.toThrow();
    expect(loadTicketTemplate("fix").executionMode.coordinator).toBe(
      "MODE-DEFAULT",
    );
  });

  it("两种 dispatchKind 经 buildTicket 得到不同汇报文案", () => {
    delete process.env[envKey];
    const base = {
      body: "body",
      label: "codebuddy",
      repoRoot: "/tmp/proj",
      groupPrompt: {
        roles: ["coordinator"],
        prompt: null,
      },
      groupHasReviewer: true,
    };
    const requirementTicket = buildTicket(
      base.body,
      base.label,
      base.repoRoot,
      minimalRun({ dispatchKind: "requirement", detached: true }),
      base.groupPrompt,
      null,
      null,
      null,
      base.groupHasReviewer,
    );
    const fixTicket = buildTicket(
      base.body,
      base.label,
      base.repoRoot,
      minimalRun({ dispatchKind: "fix", detached: true }),
      base.groupPrompt,
      null,
      null,
      null,
      base.groupHasReviewer,
    );
    expect(requirementTicket).toContain("完整档,不带 `lite`");
    expect(requirementTicket).not.toContain('"lite": true');
    expect(fixTicket).toContain('"lite": true');
    expect(fixTicket).toContain("精简档");
    expect(requirementTicket).not.toEqual(fixTicket);
  });
});

describe("ticket-template:R5 平台段不可覆盖", () => {
  it("模板改空 → 任务书仍含 taskId 与 detached 回写要求", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ticket-tpl-empty-"));
    writeTemplates(dir, {
      "default.json": {
        executionMode: { coordinator: "", executor: "", fallbackNote: "" },
        report: {
          coordinatorWithReviewer: "",
          coordinatorNoReviewer: "",
          executor: "",
        },
        specInstruction: "",
      },
    });
    useTemplatesDir(dir);

    const ticket = buildTicket(
      "做点事",
      "codebuddy",
      "/tmp/proj",
      minimalRun({
        taskId: "task-abc-123",
        groupId: "g-1",
        participantId: "p-exec-1",
        detached: true,
        dispatchKind: null,
      }),
      { roles: ["executor"], prompt: null },
    );

    // 实际任务书文本(验收 R5 要求给出)。
    expect(ticket).toContain("taskId: task-abc-123");
    expect(ticket).toContain("这是 detached 任务。完成后必须 PATCH");
    expect(ticket).toContain(
      "/groups/g-1/tasks/task-abc-123，带 status 与 diffSummary 回写终态",
    );
    expect(ticket).toContain("detachedTimeoutMinutes");
    // 方法论文案已被掏空。
    expect(ticket).not.toContain("## 执行方式");
    expect(ticket).not.toContain("## 汇报格式要求");
    expect(ticket).toContain(
      "## 执行上下文 (用于直接调用 CoAgentHub HTTP API)",
    );
  });
});

describe("ticket-template:验收1 改模板无需重建", () => {
  it("改盘上「执行方式」文案后,下一次 buildTicket 立即读到新文案", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ticket-tpl-live-"));
    const defaultBody = {
      executionMode: {
        coordinator: "## 执行方式\n旧协调者文案-AAA",
        executor: "## 执行方式\n旧执行器文案-BBB",
        fallbackNote: "",
      },
      report: {
        coordinatorWithReviewer: "## 汇报格式要求\nr1",
        coordinatorNoReviewer: "## 汇报格式要求\nr2",
        executor: "## 汇报格式要求\nr3",
      },
      specInstruction: "si",
    };
    writeTemplates(dir, { "default.json": defaultBody });
    useTemplatesDir(dir);

    const before = buildTicket(
      "body",
      "x",
      "/p",
      minimalRun({ detached: false }),
      { roles: ["executor"], prompt: null },
    );
    expect(before).toContain("旧执行器文案-BBB");
    expect(before).not.toContain("新执行器文案-CCC");

    // 模拟人改仓库模板(不重建 server、不重载模块)。
    writeTemplates(dir, {
      "default.json": {
        ...defaultBody,
        executionMode: {
          ...defaultBody.executionMode,
          executor: "## 执行方式\n新执行器文案-CCC",
        },
      },
    });

    const after = buildTicket(
      "body",
      "x",
      "/p",
      minimalRun({ detached: false }),
      { roles: ["executor"], prompt: null },
    );
    expect(after).toContain("新执行器文案-CCC");
    expect(after).not.toContain("旧执行器文案-BBB");
  });
});

describe("ticket-template:搬家 diff 为空", () => {
  it("仓库模板 + buildTicket 输出的执行/汇报段与搬家前字面量逐字一致", () => {
    delete process.env[envKey];
    const coordinatorMode = repoCoordinatorMode();
    // 搬家前字面量锚点(逐字,来自原 queue.ts buildExecutionModeSection)。
    const legacyCoordinatorMode = [
      "## 执行方式",
      "本任务按 `coagenthub-coordinator` skill 执行。",
      "- 已安装：直接按 skill 流程执行（获取冻结 spec→下发任务→L2 功能检视→按编制交回 L3→结案）。",
      "- 未安装：先 GET /api/skills/coordinator 获取 skill 内容，安装到 skills 目录后执行。",
      "### 派发成功后立即退出本轮（强制）",
      "- 一旦子任务确认创建成功（接口返回成功且已拿到子任务 id），**本轮进程必须立即结束**，不得轮询、`sleep` 或以任何形式阻塞等待子任务终态。",
      "- ⚠️ 严禁在派发成功后用 `coagenthub_get_task` 轮询自身任务或子任务状态来等待其终态——这会被平台判定为空转,且无续跑接管。",
      "- 子任务进入终态时,平台会**自动创建续跑任务**把你拉起做 L2 检视与结案;你无需、也不应守着它。续跑任务书会带回父任务 id、specRef、specHash 与子任务的完整 diffSummary。",
      "- 仅当派发失败 / 被 403·400 拒绝 / 找不到健康执行器时,才按 skill §2 处置(在群内说明阻塞原因或以 failed 结案),**绝不**在没有任何子任务的情况下静默退出。",
      "- 后端以自动重载方式运行时，改完源码无需重启；若确需重启，由发起方在验收阶段自行处理，不要在执行窗口内停掉后端。",
      "- 结案被拒且运行时陈旧时，不要反复重试、不要改代码迎合旧守卫、不要自行重启后端；应以 failed 结案，并在 error 中写明「实现已提交 <hash>,因旧构建守卫拒绝回写」。",
    ].join("\n");
    expect(coordinatorMode).toBe(legacyCoordinatorMode);

    const legacyExecutorReport = [
      "## 汇报格式要求(stdout 请按此输出)",
      "提交: <commit hash>",
      "测试: <测试结果摘要>",
      "Token: <本执行消耗的 token 数量>",
      "汇报: <做了什么,3-5 句>",
      '遗留: <未完成事项,无则写"无">',
    ].join("\n");
    expect(loadTicketTemplate(null).report.executor).toBe(legacyExecutorReport);

    const legacyFixReport = [
      "## 汇报格式要求(stdout 请按此输出)",
      "PATCH 自身这条 detached 任务为终态。",
      'PATCH 时，`diffSummary` 必须带 `review_request` 结构化载荷且带 `"lite": true`（fix 票走 L3 精简档:免 spec 对照,只检 diff 架构质量;参见 spec §3.10 / coordinator skill §4.2）。',
    ].join("\n");
    expect(loadTicketTemplate("fix").report.coordinatorWithReviewer).toBe(
      legacyFixReport,
    );

    const legacyReqReport = [
      "## 汇报格式要求(stdout 请按此输出)",
      "PATCH 自身这条 detached 任务为终态。",
      "PATCH 时，`diffSummary` 必须带 `review_request` 结构化载荷（完整档,不带 `lite`;参见 spec §3.10 / coordinator skill §4.2）。",
    ].join("\n");
    expect(
      loadTicketTemplate("requirement").report.coordinatorWithReviewer,
    ).toBe(legacyReqReport);

    // buildTicket 组装后段落仍在(平台段 + 策略段)。
    const ticket = buildTicket(
      "建一个文件 hello.txt",
      "codebuddy",
      "/repo",
      minimalRun({ detached: false, dispatchKind: null }),
      { roles: ["executor"], prompt: null },
      null,
      "specs/x.md",
      "abc123",
    );
    expect(ticket).toContain(legacyExecutorReport);
    expect(ticket).toContain(
      "- **指令**: 请严格遵循上述文档中的定义进行开发。如有冲突，以 Spec 为准。",
    );
    expect(ticket).toContain("- **文档路径**: specs/x.md");
    expect(ticket).toContain("- **版本哈希**: abc123");
  });
});

describe("ticket-template:R3 平台只读", () => {
  it("server 源码无写模板的 API 路由或 writeFile 指向 ticket-templates", () => {
    // 保证:不存在写模板的 HTTP 路由;loader 模块不含 writeFileSync。
    const loader = readFileSync(
      path.join(
        repoRoot,
        "packages/backend/server/src/lib/executor-task/ticket-template.ts",
      ),
      "utf8",
    );
    expect(loader).not.toMatch(/writeFileSync|writeFile\b/);
    expect(loader).toContain("readFileSync");

    // 粗检 routes:无 ticket-template 写接口。
    const routesDir = path.join(repoRoot, "packages/backend/server/src/routes");
    const stack = [routesDir];
    while (stack.length > 0) {
      const d = stack.pop()!;
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.name.endsWith(".ts")) {
          const src = readFileSync(p, "utf8");
          expect(src).not.toMatch(/ticket-templates/);
          expect(src).not.toMatch(/TicketTemplate/);
        }
      }
    }
  });
});
