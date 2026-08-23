import { Hono } from "hono";
import registry from "./registry";
import taskCompletionEventsRouter from "./task-completion-events";
import taskDispatchWarningsRouter from "./task-dispatch-warnings";

const app = new Hono()
  .route("/", registry)
  .route("/", taskCompletionEventsRouter)
  .route("/", taskDispatchWarningsRouter);

export default app;
