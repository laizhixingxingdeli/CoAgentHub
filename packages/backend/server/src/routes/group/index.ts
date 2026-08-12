import type { DataBase } from "@server/lib/database";
import db from "@server/lib/database";
import { agentAuth } from "@server/middleware/agent-auth";
import { Hono } from "hono";
import registry from "./registry";

/**
 * Group management API. Every endpoint is protected by agentAuth — the
 * operator is the authenticated agent (`c.get("agentId")`).
 *
 */
const app = new Hono<{ Variables: { db: DataBase; agentId: string } }>();

app.use(async (c, next) => {
  c.set("db", db);
  await next();
});
app.use(agentAuth);
app.route("/", registry);

export default app;
