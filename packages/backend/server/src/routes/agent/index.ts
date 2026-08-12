import { Hono } from "hono";
import registry from "./registry";

const app = new Hono().route("/", registry);

export default app;
