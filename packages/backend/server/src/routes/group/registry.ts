import type { DataBase } from "@server/lib/database";
import { Hono } from "hono";
import groupsRouter from "./groups";
import membersRouter from "./members";
import messagesRouter from "./messages";
import tasksRouter from "./tasks";

/**
 * 群管理路由汇总(架构审视拆分):原 1299 行单文件按职责拆分为
 * groups(群本体)/ members(成员)/ messages(消息)/ tasks(任务)四个子路由,
 * 本文件仅负责挂载。API 路径与响应形状与拆分前完全一致(所有子路由均挂在
 * "/" 下,路径自包含 /:id/...)。共享守卫(assertGroupWritable)在
 * ./helpers.ts。
 */
const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app.route("/", groupsRouter);
app.route("/", membersRouter);
app.route("/", messagesRouter);
app.route("/", tasksRouter);

export default app;
