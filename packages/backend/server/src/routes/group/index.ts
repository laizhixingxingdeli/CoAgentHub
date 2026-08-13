import type { DataBase } from "@server/lib/database";
import db from "@server/lib/database";
import { participantAuth } from "@server/middleware/participant-auth";
import { Hono } from "hono";
import registry from "./registry";

/**
 * Group management API. Every endpoint is protected by participantAuth — the
 * operator is the authenticated participant (`c.get("participantId")`).
 *
 */
const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app.use(async (c, next) => {
  c.set("db", db);
  await next();
});
app.use(participantAuth);
app.route("/", registry);

export default app;
