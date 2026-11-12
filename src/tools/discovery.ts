import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResponseFormatSchema, toErrorResult, toResult } from "../format.js";
import { getCompanyOverview, searchCompanies } from "../services/screener.js";

const SlugSchema = z
  .string()
  .min(1)
  .max(50)
  .describe('Screener company slug, e.g. "SRF", "TCS", "DEEPAKNTR". Get it from screener_search_company.');

const ConsolidatedSchema = z
  .boolean()
  .default(true)
  .describe(
    "true reads the consolidated statements (group-level, the site default), false reads standalone (parent company only). Some companies only publish standalone.",
  );

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    "screener_search_company",
    {
      title: "Search Screener companies",
      description: `Find Indian listed companies on screener.in by name or ticker, and get the slug needed by every other screener tool.

Start here whenever the user names a company in words rather than giving a slug.

Args:
  - query (string): company name or ticker fragment, e.g. "tata", "deepak", "SRF". Single characters work.
  - limit (number): max results to return, 1-10 (default 5). Screener itself returns at most 5 companies, so values above 5 add nothing.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns:
  {
    "count": number,
    "results": [
      {
        "name": string,                    // "Tata Consultancy Services Ltd"
        "slug": string,                    // "TCS" — pass this to the other tools
        "chart_id": number,                // numeric id used by screener_get_price_history
        "url": string,                     // "/company/TCS/consolidated/"
        "consolidated_available": boolean  // false means only standalone statements exist
      }
    ]
  }

Examples:
  - "How is Deepak Nitrite doing?" -> query="deepak", then use slug "DEEPAKNTR" with screener_get_company_overview.
  - "Compare TCS and Infosys" -> two searches, then screener_get_peers or two overview calls.

Notes:
  - No login required.
  - An unmatched query returns an empty list, not an error.
  - chart_id here is NOT the id used by peers/quick-ratio endpoints; the other tools resolve that themselves.`,
      inputSchema: {
        query: z.string().min(1).max(100).describe("Company name or ticker fragment to search for"),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum results to return (default 5)"),
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        count: z.number(),
        results: z.array(
          z.object({
            name: z.string(),
            slug: z.string(),
            chart_id: z.number(),
            url: z.string(),
            consolidated_available: z.boolean(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, limit, response_format }) => {
      try {
        const results = (await searchCompanies(query)).slice(0, limit);
        const structured = {
          count: results.length,
          results: results.map((result) => ({
            name: result.name,
            slug: result.slug,
            chart_id: result.chartId,
            url: result.url,
            consolidated_available: result.consolidatedAvailable,
          })),
        };

        const markdown =
          results.length === 0
            ? `No companies found matching "${query}". Try a shorter or differently spelled query.`
            : [`# Search: "${query}" (${results.length} results)`, ""]
                .concat(
                  results.map(
                    (result) =>
                      `- **${result.name}** — slug \`${result.slug}\`, chart_id ${result.chartId}${
                        result.consolidatedAvailable ? "" : " (standalone only)"
                      }`,
                  ),
                )
                .join("\n");

        return toResult(markdown, structured, response_format);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "screener_get_company_overview",
    {
      title: "Get Screener company overview",
      description: `Get the headline snapshot of one company: key ratios, machine-generated pros and cons, business description and exchange codes.

This is the cheapest single call for "how is company X doing" questions. The key ratios here (Market Cap, Current Price, Stock P/E, Book Value, Dividend Yield, ROCE, ROE, Face Value) are served without any login — screener_get_quick_ratios only adds a handful of extra metrics and does require a session.

Args:
  - slug (string): company slug from screener_search_company, e.g. "SRF".
  - consolidated (boolean): consolidated vs standalone basis (default true).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns:
  {
    "slug": string,
    "name": string,                 // "SRF Ltd"
    "chart_id": number,             // for screener_get_price_history
    "warehouse_id": number | null,  // for peers / quick ratios
    "consolidated": boolean,
    "about": string | null,         // business description
    "website": string | null,
    "bse_code": string | null,      // "503806"
    "nse_code": string | null,      // "SRF"
    "key_ratios": [{ "name": "Market Cap", "value": "₹ 74,462 Cr." }],
    "pros": string[],               // machine-generated bull points
    "cons": string[],               // machine-generated bear points
    "available_sections": string[]  // sections screener_get_financials can read
  }

Examples:
  - "Is SRF expensive?" -> slug="SRF", read Stock P/E and the pros/cons.
  - "What does this company actually do?" -> read "about".
  - "Standalone numbers please" -> consolidated=false.

Error Handling:
  - Returns a not_found error if the slug is wrong — search for the company first.`,
      inputSchema: {
        slug: SlugSchema,
        consolidated: ConsolidatedSchema,
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        slug: z.string(),
        name: z.string(),
        chart_id: z.number(),
        warehouse_id: z.number().nullable(),
        consolidated: z.boolean(),
        about: z.string().nullable(),
        website: z.string().nullable(),
        bse_code: z.string().nullable(),
        nse_code: z.string().nullable(),
        key_ratios: z.array(z.object({ name: z.string(), value: z.string() })),
        pros: z.array(z.string()),
        cons: z.array(z.string()),
        available_sections: z.array(z.string()),
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
        const overview = await getCompanyOverview(slug, consolidated);
        const structured = {
          slug: overview.slug,
          name: overview.name,
          chart_id: overview.chartId,
          warehouse_id: overview.warehouseId,
          consolidated: overview.consolidated,
          about: overview.about,
          website: overview.website,
          bse_code: overview.bseCode,
          nse_code: overview.nseCode,
          key_ratios: overview.keyRatios,
          pros: overview.pros,
          cons: overview.cons,
          available_sections: overview.availableSections,
        };

        const lines = [
          `# ${overview.name} (${overview.slug})`,
          `${overview.consolidated ? "Consolidated" : "Standalone"} basis · BSE ${overview.bseCode ?? "—"} · NSE ${overview.nseCode ?? "—"}`,
          "",
        ];

        if (overview.about) lines.push(overview.about, "");

        if (overview.keyRatios.length > 0) {
          lines.push("## Key ratios");
          lines.push(...overview.keyRatios.map((ratio) => `- **${ratio.name}**: ${ratio.value}`));
          lines.push("");
        }

        if (overview.pros.length > 0) {
          lines.push("## Pros", ...overview.pros.map((item) => `- ${item}`), "");
        }
        if (overview.cons.length > 0) {
          lines.push("## Cons", ...overview.cons.map((item) => `- ${item}`), "");
        }

        lines.push(
          `Sections available via screener_get_financials: ${overview.availableSections.join(", ")}`,
        );

        return toResult(lines.join("\n"), structured, response_format);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
