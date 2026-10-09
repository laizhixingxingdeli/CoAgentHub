import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({ name: "coagenthub-codex", version: "0.2.2" });
registerTools(server);
await server.connect(new StdioServerTransport());
