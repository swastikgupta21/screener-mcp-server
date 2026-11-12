#!/usr/bin/env node
/**
 * MCP server for screener.in — Indian equity fundamentals, peers and price history.
 *
 * Four of the five upstream endpoints are public. Only quick_ratios is gated;
 * set SCREENER_SESSIONID to a screener.in sessionid cookie to enable that tool.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveSession } from "./services/session.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerFundamentalsTools } from "./tools/fundamentals.js";
import { registerMarketTools } from "./tools/market.js";
import { registerScreenTools } from "./tools/screens.js";
import { registerSessionTools } from "./tools/session.js";

const server = new McpServer({
  name: "screener-mcp-server",
  version: "1.0.0",
});

registerDiscoveryTools(server);
registerFundamentalsTools(server);
registerMarketTools(server);
registerScreenTools(server);
registerSessionTools(server);
stripSchemaDialect(server);

/**
 * The SDK converts zod schemas with zod-to-json-schema's default target, which
 * stamps every inputSchema/outputSchema with `"$schema": draft-07`. Clients
 * validating with a 2020-12-only Ajv (e.g. Claude Code) reject the whole tool.
 * The generated schemas use no draft-07-only keywords, so dropping the dialect
 * marker lets them fall back to the MCP default (2020-12). Output validation
 * still runs server-side against the zod schemas, so it is unaffected.
 */
function stripSchemaDialect(mcp: McpServer): void {
  type Handler = (request: unknown, extra: unknown) => Promise<unknown>;
  // McpServer exposes no hook for the tools/list payload, so wrap its handler.
  const handlers = (mcp.server as unknown as { _requestHandlers: Map<string, Handler> })
    ._requestHandlers;
  const listTools = handlers.get("tools/list");
  if (!listTools) {
    throw new Error("tools/list handler missing — register tools before stripSchemaDialect()");
  }
  handlers.set("tools/list", async (request, extra) => {
    const result = (await listTools(request, extra)) as ListToolsResult;
    for (const tool of result.tools) {
      delete tool.inputSchema.$schema;
      if (tool.outputSchema) delete tool.outputSchema.$schema;
    }
    return result;
  });
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout carries the protocol, so all logging goes to stderr.
  const { source } = resolveSession();
  console.error(
    source === "none"
      ? "screener-mcp-server ready (quick_ratios disabled — call screener_refresh_session to add a session)"
      : `screener-mcp-server ready (quick_ratios enabled, session from ${source})`,
  );
}

main().catch((error: unknown) => {
  console.error("Fatal error starting screener-mcp-server:", error);
  process.exit(1);
});
