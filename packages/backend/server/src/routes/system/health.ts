import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

const app = new Hono().get(
  "/",
  describeRoute({
    tags: ["Health"],
    description: "Liveness probe: text `ok`, or JSON {status: ok} when asked.",
    responses: {
      200: { description: "Service is healthy" },
    },
  }),
  (c) => {
    const wantsJson = c.req.header("accept")?.includes("application/json");
    return wantsJson ? c.json({ status: "ok" }) : c.text("ok");
  },
);

export default app;
