import { Hono } from "hono";
import health from "./health";

const app = new Hono().route("/health", health);

export default app;
