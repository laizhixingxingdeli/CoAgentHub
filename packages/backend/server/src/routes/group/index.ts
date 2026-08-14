import type { DataBase } from "@server/lib/database";
import db from "@server/lib/database";
import { participantIdentity } from "@server/middleware/participant-identity";
import { Hono } from "hono";
import registry from "./registry";

/**
 * Group management API. Every endpoint resolves the claimed identity via
 * participantIdentity — the operator is the declared participant
 * (`c.get("participantId")`; missing/unknown claim falls back to Local User).
 *
 */
const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app.use(async (c, next) => {
  c.set("db", db);
  await next();
});
app.use(participantIdentity);
app.route("/", registry);

export default app;
