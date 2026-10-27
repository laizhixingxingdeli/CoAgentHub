import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { startBridgeSupervision } from "./bridge-supervisor.js";

const server = new McpServer({ name: "coagenthub-codex", version: "0.2.2" });
registerTools(server);
await server.connect(new StdioServerTransport());
// Started only after the transport is up: a failed daemon spawn must not sit in
// front of the handshake. The shared helper retries every 60s and returns before
// creating a timer when COAGENTHUB_L3_BRIDGE=0.
startBridgeSupervision();
