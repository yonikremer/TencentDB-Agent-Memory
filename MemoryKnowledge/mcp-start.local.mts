import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./src/mcp/server.ts";

const baseUrl = process.env.KNOWLEDGE_API_URL || "http://127.0.0.1:8421";
const token = process.env.KNOWLEDGE_API_TOKEN;
const server = createMcpServer({ baseUrl, token });
await server.connect(new StdioServerTransport());
