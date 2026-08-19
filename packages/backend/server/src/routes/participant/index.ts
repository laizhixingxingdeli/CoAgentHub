import { Hono } from "hono";
import taskCompletionEventsRouter from "./task-completion-events";
import registry from "./registry";

const app = new Hono()
  .route("/", registry)
  .route("/", taskCompletionEventsRouter);

export default app;
