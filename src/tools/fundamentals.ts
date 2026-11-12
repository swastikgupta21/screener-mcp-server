import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SECTION_IDS } from "../constants.js";
import { ResponseFormatSchema, formatValue, markdownTable, toErrorResult, toResult } from "../format.js";
import { hasSession } from "../services/session.js";
import { getFinancials, getPeers, getQuickRatios } from "../services/screener.js";
import type { SectionKey } from "../services/parse.js";
import type { PeerRow } from "../types.js";

const SECTION_KEYS = Object.keys(SECTION_IDS) as [SectionKey, ...SectionKey[]];

const SlugSchema = z.string().min(1).max(50).describe('Company slug, e.g. "SRF". From screener_search_company.');

const ConsolidatedSchema = z
  .boolean()
  .default(true)
  .describe("Consolidated (group) statements when true, standalone (parent only) when false.");

function peerToStructured(peer: PeerRow) {
  return {
    rank: peer.rank,
    name: peer.name,
    slug: peer.slug,
    chart_id: peer.chartId,
    metrics: peer.metrics,
  };
}

export function registerFundamentalsTools(server: McpServer): void {
  server.registerTool(
    "screener_get_financials",
    {
      title: "Get Screener financial statements",
      description: `Read one financial statement table for a company: quarterly results, annual P&L, balance sheet, cash flow, ratios, or shareholding pattern.

All six sections ship inside the company page HTML, so this needs no login and no extra request beyond the cached page fetch.

Args:
  - slug (string): company slug, e.g. "SRF".
  - section ('quarters' | 'profit_loss' | 'balance_sheet' | 'cash_flow' | 'ratios' | 'shareholding'): which table to read.
  - consolidated (boolean): consolidated vs standalone (default true).
  - periods (number): keep only the most recent N columns, 1-30 (default 12). Lower this for long histories.
  - shareholding_view ('quarterly' | 'yearly'): only used when section='shareholding' (default 'quarterly').
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns:
  {
    "slug": string,
    "section": string,
    "title": string,             // "Quarterly Results"
    "unit": string | null,       // "Consolidated Figures in Rs. Crores"
    "periods": [{ "label": "Jun 2023", "date": "2023-06-30" }],
    "rows": [{ "label": "Sales", "values": [3338, 3177, null] }]
  }

Values are numbers with commas and % signs stripped; a blank cell becomes null. Percentage rows keep their label (e.g. "OPM %") so the unit stays clear.

Examples:
  - "Is SRF's margin improving?" -> section='quarters', read the "OPM %" row.
  - "Show me debt over time" -> section='balance_sheet', read "Borrowings".
  - "Who owns this company?" -> section='shareholding'.
  - "Full 10-year P&L" -> section='profit_loss', periods=30.

Error Handling:
  - not_found if the slug is wrong.
  - An error naming the section if screener does not publish that table for the company.`,
      inputSchema: {
        slug: SlugSchema,
        section: z.enum(SECTION_KEYS).describe("Which statement table to read"),
        consolidated: ConsolidatedSchema,
        periods: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(12)
          .describe("Keep only the most recent N periods (default 12)"),
        shareholding_view: z
          .enum(["quarterly", "yearly"])
          .default("quarterly")
          .describe("Only used when section='shareholding'"),
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        slug: z.string(),
        section: z.string(),
        title: z.string(),
        unit: z.string().nullable(),
        periods: z.array(z.object({ label: z.string(), date: z.string().nullable() })),
        rows: z.array(z.object({ label: z.string(), values: z.array(z.number().nullable()) })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug, section, consolidated, periods, shareholding_view, response_format }) => {
      try {
        const table = await getFinancials(slug, section, consolidated, shareholding_view);

        const keep = Math.min(periods, table.periods.length);
        const start = table.periods.length - keep;
        const trimmedPeriods = table.periods.slice(start);
        const trimmedRows = table.rows.map((row) => ({
          label: row.label,
          values: row.values.slice(start),
        }));

        const structured = {
          slug,
          section,
          title: table.title,
          unit: table.unit,
          periods: trimmedPeriods,
          rows: trimmedRows,
        };

        const markdown = [
          `# ${table.title} — ${slug}`,
          table.unit ?? "",
          "",
          markdownTable(
            ["", ...trimmedPeriods.map((period) => period.label)],
            trimmedRows.map((row) => [row.label, ...row.values.map(formatValue)]),
          ),
        ]
          .filter(Boolean)
          .join("\n");

        return toResult(markdown, structured, response_format);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "screener_get_peers",
    {
      title: "Get Screener peer comparison",
      description: `Get the peer comparison table for a company — the same industry cohort screener shows, with each peer's valuation and growth metrics plus the industry median row.

Use this for "how does X compare to its competitors" questions instead of fetching each company separately.

Args:
  - slug (string): company slug, e.g. "SRF".
  - consolidated (boolean): consolidated vs standalone basis (default true).
  - limit (number): max peers to return, 1-60 (default 15).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns:
  {
    "slug": string,
    "columns": string[],            // ["S.No.", "Company", "CMP", "P/E", "Mkt Cap", ...] — varies by industry
    "count": number,
    "peers": [
      {
        "rank": number | null,
        "name": string,             // "Tata Chemicals"
        "slug": string | null,      // "TATACHEM" — usable with the other tools
        "chart_id": number | null,
        "metrics": { "CMP": 693.25, "P/E": null, "Mkt Cap": 17661.24 }
      }
    ],
    "median": { ... } | null        // industry median row, e.g. "Median: 44 Co."
  }

Column names come straight from screener and differ between industries, so read "columns" rather than assuming a fixed set. A null metric means screener left the cell blank (e.g. a loss-making company has no P/E).

Examples:
  - "Is SRF cheap vs peers?" -> compare the company's P/E against the median row.
  - "Who are SRF's competitors?" -> read the peer names.

Notes:
  - No login required. Internally resolves the warehouse id from the company page, since the search endpoint does not return it.`,
      inputSchema: {
        slug: SlugSchema,
        consolidated: ConsolidatedSchema,
        limit: z.number().int().min(1).max(60).default(15).describe("Maximum peers to return (default 15)"),
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        slug: z.string(),
        columns: z.array(z.string()),
        count: z.number(),
        peers: z.array(
          z.object({
            rank: z.number().nullable(),
            name: z.string(),
            slug: z.string().nullable(),
            chart_id: z.number().nullable(),
            metrics: z.record(z.number().nullable()),
          }),
        ),
        median: z
          .object({
            rank: z.number().nullable(),
            name: z.string(),
            slug: z.string().nullable(),
            chart_id: z.number().nullable(),
            metrics: z.record(z.number().nullable()),
          })
          .nullable(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug, consolidated, limit, response_format }) => {
      try {
        const table = await getPeers(slug, consolidated);
        const peers = table.peers.slice(0, limit);

        const structured = {
          slug,
          columns: table.columns,
          count: peers.length,
          peers: peers.map(peerToStructured),
          median: table.medianRow ? peerToStructured(table.medianRow) : null,
        };

        const metricColumns = table.columns.slice(2);
        const rows = peers.map((peer) => [
          peer.name,
          ...metricColumns.map((column) => formatValue(peer.metrics[column] ?? null)),
        ]);
        if (table.medianRow) {
          const median = table.medianRow;
          rows.push([median.name, ...metricColumns.map((column) => formatValue(median.metrics[column] ?? null))]);
        }

        const markdown = [
          `# Peer comparison — ${slug} (${peers.length} peers)`,
          "",
          markdownTable(["Company", ...metricColumns], rows),
        ].join("\n");

        return toResult(markdown, structured, response_format);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "screener_get_quick_ratios",
    {
      title: "Get Screener quick ratios (login required)",
      description: `Get screener's extended quick-ratio block: Price to book value, Industry PBV, Industry PE, Return on assets, Debt to equity, EPS, Sales growth %, Profit growth % and share counts.

LOGIN REQUIRED — this is the only screener endpoint of the five that is gated. It needs a SCREENER_SESSIONID environment variable holding a valid screener.in sessionid cookie. Without it the call fails with a login_required error.

Before reaching for this tool, check screener_get_company_overview: Market Cap, Current Price, Stock P/E, Book Value, Dividend Yield, ROCE and ROE are all available there with no login at all. Only use this tool when you specifically need the extra metrics listed above.

Args:
  - slug (string): company slug, e.g. "SRF".
  - consolidated (boolean): consolidated vs standalone basis (default true).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns:
  {
    "slug": string,
    "authenticated": boolean,
    "count": number,
    "ratios": [{ "name": "Price to book value", "value": "5.30" }]
  }

Values are display strings exactly as screener renders them, not parsed numbers.

Error Handling:
  - login_required: SCREENER_SESSIONID is unset, expired or invalid. Tell the user to log in to screener.in, copy the sessionid cookie, set the env var and restart the server — do not retry without a new cookie.
  - not_found: wrong slug, or the company page has no warehouse id.`,
      inputSchema: {
        slug: SlugSchema,
        consolidated: ConsolidatedSchema,
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        slug: z.string(),
        authenticated: z.boolean(),
        count: z.number(),
        ratios: z.array(z.object({ name: z.string(), value: z.string() })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug, consolidated, response_format }) => {
      try {
        const ratios = await getQuickRatios(slug, consolidated);
        const structured = {
          slug,
          authenticated: hasSession(),
          count: ratios.length,
          ratios,
        };

        const markdown = [
          `# Quick ratios — ${slug}`,
          "",
          ...ratios.map((ratio) => `- **${ratio.name}**: ${ratio.value}`),
        ].join("\n");

        return toResult(markdown, structured, response_format);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
