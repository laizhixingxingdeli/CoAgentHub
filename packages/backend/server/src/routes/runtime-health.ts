import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { getRuntimeStatus } from "../lib/runtime-status";

const app = new Hono().get(
  "/",
  describeRoute({
    tags: ["Health"],
    description:
      "Runtime freshness probe: reports the process start time, entry mtime, staleness reason (process/build/both), and the newest scanned source mtime.",
    responses: {
      200: { description: "Runtime status" },
    },
  }),
  (c) => c.json(getRuntimeStatus()),
);

export default app;
