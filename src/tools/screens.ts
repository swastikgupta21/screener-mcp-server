import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResponseFormatSchema, formatValue, markdownTable, toErrorResult, toResult } from "../format.js";
import {
  getScreenIndustries,
  runScreen,
  screenUrl,
  searchRatios,
} from "../services/screener.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerScreenTools(server: McpServer): void {
  server.registerTool(
    "screener_search_ratios",
    {
      title: "Search Screener ratio names",
      description: `Look up the exact ratio/field names that screener.in screen queries accept, with a description and unit for each.

Call this before writing a query for screener_run_screen whenever you are not sure of a ratio's exact name. Screener rejects unknown words ("Unknown word: ..."), and the names are idiosyncratic — e.g. "Profit growth 3Years", "Return over 3years", "Market Capitalization", "Interest Coverage Ratio", "Debt to equity", "Promoter holding".

Args:
  - query (string): a word or fragment, e.g. "profit", "roce", "debt", "promoter", "pe". Matches names, common aliases ("roce", "p/e") and descriptions. Case-insensitive.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns:
  {
    "query": string,
    "count": number,
    "ratios": [
      {
        "name": string,         // "Profit growth 3Years" — use verbatim in queries
        "description": string,  // "Compounded profit growth (CAGR) over last 3 years..."
        "unit": string          // "%", "Rs.Cr." or "" for scores/ratios
      }
    ]
  }

Notes:
  - Screener returns at most 10 matches and has no paging, so search with a more specific fragment to find others (e.g. "profit growth 5" rather than "profit").
  - Time-shifted variants exist for many fields: "... last year", "... preceding year", "... latest quarter", "... preceding quarter", "... 3Years back", "... 5Years" etc.
  - Some matches are community-defined ratios (e.g. "G Factor", "Debt Capacity"); they work in queries like any other.
  - No login required. An unmatched query returns an empty list.`,
      inputSchema: {
        query: z.string().trim().min(1).max(60).describe('Ratio name fragment, e.g. "profit growth", "roce"'),
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        query: z.string(),
        count: z.number(),
        ratios: z.array(z.object({ name: z.string(), description: z.string(), unit: z.string() })),
      },
      annotations: READ_ONLY,
    },
    async ({ query, response_format }) => {
      try {
        const ratios = await searchRatios(query);
        const structured = { query, count: ratios.length, ratios };
        const markdown =
          ratios.length === 0
            ? `No ratios match "${query}". Try a shorter fragment or a synonym (e.g. "sales" instead of "revenue").`
            : [
                `# Ratios matching "${query}" (${ratios.length}${ratios.length === 10 ? ", screener's max — refine to see more" : ""})`,
                "",
                ...ratios.map(
                  (ratio) =>
                    `- **${ratio.name}**${ratio.unit ? ` (${ratio.unit})` : ""} — ${ratio.description || "no description"}`,
                ),
              ].join("\n");
        return toResult(markdown, structured, response_format);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "screener_run_screen",
    {
      title: "Run a Screener stock screen",
      description: `Run a custom screener.in stock screen (the "Query Builder" / /screen/raw/ page) and get the matching Indian listed companies with their metrics.

Requires a logged-in screener.in session (same as screener_get_quick_ratios). If it fails with login_required, call screener_refresh_session.

Query syntax:
  - Conditions use exact ratio names (find them with screener_search_ratios) and the operators > < >= <= =.
  - Combine with AND / OR and parentheses. Newlines between conditions are optional.
  - Ratios can be compared to each other and to arithmetic: "Return over 3years < Profit growth 3Years", "Return on equity > Debt to equity * 10".
  - Names are case-insensitive.
  Example: "Profit growth 3Years >= 15 AND Sales growth 3Years >= 8 AND Interest Coverage Ratio > 3 AND Market Capitalization > 2500"

Args:
  - query (string): the screen query.
  - page (number): 1-based results page (default 1). A page past the end returns the last page; check "page" in the response.
  - page_size (number): results per page, 10-100 (default 50). Screener enforces this range.
  - sort (string, optional): ratio name to sort by, e.g. "Market Capitalization", or "name". Default is screener's (Return on capital employed, descending). An unrecognised name makes screener fall back to name order; a warning is returned when that happens.
  - order ('asc' | 'desc'): sort direction when sort is set (default 'desc').
  - include_industries (boolean): also return how the full result set breaks down by industry (one extra request, default false).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns:
  {
    "query": string,
    "screen_url": string,          // open in a browser to see the same screen
    "total_results": number,       // across all pages
    "page": number,
    "total_pages": number,
    "page_size": number,
    "columns": [{ "name": "Market Capitalization", "label": "Mar Cap", "unit": "Rs.Cr." }],
    "count": number,               // rows on this page
    "results": [
      {
        "rank": number | null,
        "name": string,            // may be truncated by screener, e.g. "Waaree Renewab."
        "slug": string | null,     // "SPARC" — pass to the other screener tools
        "consolidated": boolean,
        "chart_id": number | null, // for screener_get_price_history
        "metrics": { "Current Price": 197.03, "Market Capitalization": 6394.71, ... }  // keyed by column name
      }
    ],
    "industries": [{ "code": string, "industry": string, "count": number | null }] | null,
    "warnings": string[]           // e.g. sort ratio not recognised
  }

Columns are NOT fixed. Screener shows the account's saved columns (set at screener.in → Edit Columns), plus up to two ratios from the query that are not already shown, plus the sort ratio. To see a specific ratio's values, sort by it. Read "columns" rather than assuming a set. A null metric means screener left the cell blank.

Error Handling:
  - invalid_query: screener's message is included, e.g. "Unknown word: foo" (wrong ratio name — use screener_search_ratios) or "Syntax error in the query".
  - login_required: session missing/expired — call screener_refresh_session.
  - Zero matches is not an error: total_results is 0.

Notes:
  - Industry filtering is a paid screener feature and is not offered here; include_industries only reports the breakdown.
  - Each call is one request (two with include_industries). Paginate rather than requesting everything when total_results is large.`,
      inputSchema: {
        query: z.string().trim().min(3).max(2000).describe("Screener query, e.g. \"Market Capitalization > 2500 AND Return on equity > 20\""),
        page: z.number().int().min(1).max(1000).default(1).describe("1-based page number (default 1)"),
        page_size: z.number().int().min(10).max(100).default(50).describe("Results per page, 10-100 (default 50)"),
        sort: z.string().trim().min(1).max(100).optional().describe('Ratio name to sort by, e.g. "Market Capitalization"'),
        order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction when sort is given (default desc)"),
        include_industries: z.boolean().default(false).describe("Also return the industry breakdown of all results"),
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        query: z.string(),
        screen_url: z.string(),
        total_results: z.number(),
        page: z.number(),
        total_pages: z.number(),
        page_size: z.number(),
        columns: z.array(z.object({ name: z.string(), label: z.string(), unit: z.string().nullable() })),
        count: z.number(),
        results: z.array(
          z.object({
            rank: z.number().nullable(),
            name: z.string(),
            slug: z.string().nullable(),
            consolidated: z.boolean(),
            chart_id: z.number().nullable(),
            metrics: z.record(z.number().nullable()),
          }),
        ),
        industries: z
          .array(z.object({ code: z.string(), industry: z.string(), count: z.number().nullable() }))
          .nullable(),
        warnings: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    async ({ query, page, page_size, sort, order, include_industries, response_format }) => {
      try {
        const results = await runScreen(query, { page, pageSize: page_size, sort, order });
        const industries = include_industries ? await getScreenIndustries(query) : null;

        const warnings: string[] = [];
        // Screener appends the sort ratio as a column; if it is absent the name was not recognised.
        if (
          sort &&
          sort.toLowerCase() !== "name" &&
          results.rows.length > 0 &&
          !results.columns.some((column) => column.name.toLowerCase() === sort.toLowerCase())
        ) {
          warnings.push(
            `Screener did not recognise sort "${sort}" and fell back to company-name order. Use an exact name from screener_search_ratios.`,
          );
        }
        if (page > results.totalPages && results.totalResults > 0) {
          warnings.push(`Page ${page} is past the end; screener returned page ${results.page}.`);
        }

        const structured = {
          query,
          screen_url: screenUrl(query),
          total_results: results.totalResults,
          page: results.page,
          total_pages: results.totalPages,
          page_size,
          columns: results.columns,
          count: results.rows.length,
          results: results.rows.map((row) => ({
            rank: row.rank,
            name: row.name,
            slug: row.slug,
            consolidated: row.consolidated,
            chart_id: row.chartId,
            metrics: row.metrics,
          })),
          industries,
          warnings,
        };

        const lines = [
          `# Screen: ${results.totalResults} results — page ${results.page} of ${results.totalPages}`,
          `\`${query.replace(/\s+/g, " ")}\``,
          sort ? `Sorted by ${sort} (${order})` : "Sorted by screener default (Return on capital employed, desc)",
          "",
        ];

        if (warnings.length > 0) {
          lines.push(...warnings.map((warning) => `> Warning: ${warning}`), "");
        }

        if (results.rows.length === 0) {
          lines.push("No companies match this screen. Loosen a condition and try again.");
        } else {
          const headers = [
            "#",
            "Company",
            "Slug",
            ...results.columns.map((column) => (column.unit ? `${column.label} (${column.unit})` : column.label)),
          ];
          const rows = results.rows.map((row) => [
            row.rank === null ? "" : String(row.rank),
            row.name,
            row.slug ?? "",
            ...results.columns.map((column) => formatValue(row.metrics[column.name] ?? null)),
          ]);
          lines.push(markdownTable(headers, rows));
          if (results.page < results.totalPages) {
            lines.push("", `More results: call again with page=${results.page + 1}.`);
          }
        }

        if (industries && industries.length > 0) {
          lines.push(
            "",
            "## Industry breakdown (all results)",
            ...industries.map((item) => `- ${item.industry}${item.count === null ? "" : `: ${item.count}`}`),
          );
        }

        lines.push("", `Open in browser: ${structured.screen_url}`);

        return toResult(lines.join("\n"), structured, response_format);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
