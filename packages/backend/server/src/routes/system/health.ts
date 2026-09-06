import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import {
  getAutoRebuildState,
  getStaleStallState,
} from "../../lib/watchdog-state";

const app = new Hono().get(
  "/",
  describeRoute({
    tags: ["Health"],
    description:
      "Liveness probe: text `ok`, or JSON {status, autoRebuild, staleStall} when asked. autoRebuild.disabled surfaces the watchdog's auto-rebuild disabled state (R4: the platform abandoned self-healing and why/when); staleStall surfaces stale rounds blocked by in-flight tasks (R2 escalation).",
    responses: {
      200: { description: "Service is healthy" },
    },
  }),
  (c) => {
    const wantsJson = c.req.header("accept")?.includes("application/json");
    if (!wantsJson) return c.text("ok");
    return c.json({
      status: "ok",
      autoRebuild: getAutoRebuildState(),
      staleStall: getStaleStallState(),
    });
  },
);

export default app;
