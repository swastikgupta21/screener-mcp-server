#!/usr/bin/env node
// Drives every tool against live screener.in through a real MCP stdio client.
// Usage: npm run build && node scripts/smoke-test.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: projectRoot,
});

const client = new Client({ name: "screener-smoke-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}): ${tools.map((tool) => tool.name).join(", ")}\n`);

async function call(name, args, preview = 600) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  console.log(`=== ${name} ${JSON.stringify(args)}${result.isError ? "  [ERROR]" : ""}`);
  console.log(text.slice(0, preview));
  console.log("");
  return result;
}

await call("screener_search_company", { query: "deepak" });
await call("screener_get_company_overview", { slug: "SRF" });
await call("screener_get_financials", { slug: "SRF", section: "quarters", periods: 4 });
await call("screener_get_financials", { slug: "SRF", section: "shareholding", periods: 3 });
await call("screener_get_peers", { slug: "SRF", limit: 5 });
await call("screener_get_price_history", { slug: "SRF", metrics: ["price", "volume"], days: 365, max_points: 10 });
await call("screener_get_quick_ratios", { slug: "SRF" });
await call("screener_get_company_overview", { slug: "NOT_A_REAL_SLUG_XYZ" });

await client.close();
