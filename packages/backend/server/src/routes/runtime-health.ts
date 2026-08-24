import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { getRuntimeStatus } from "../lib/runtime-status";

const app = new Hono().get(
  "/",
  describeRoute({
    tags: ["Health"],
    description:
      "Runtime freshness probe: reports the process start time, entry mtime, and whether the entry was updated after boot.",
    responses: {
      200: { description: "Runtime status" },
    },
  }),
  (c) => c.json(getRuntimeStatus()),
);

export default app;
