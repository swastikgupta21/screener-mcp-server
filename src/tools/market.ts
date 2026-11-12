import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHART_METRICS } from "../constants.js";
import { ResponseFormatSchema, toErrorResult, toResult } from "../format.js";
import { getChart, type ChartMetricKey } from "../services/screener.js";

const METRIC_KEYS = Object.keys(CHART_METRICS) as [ChartMetricKey, ...ChartMetricKey[]];

export function registerMarketTools(server: McpServer): void {
  server.registerTool(
    "screener_get_price_history",
    {
      title: "Get Screener price and valuation history",
      description: `Get time series for a company: price, moving averages, volume, or the valuation overlays (P/E, median P/E, EPS).

This is the only screener endpoint that returns real JSON time series, and history goes back to the early 2000s if you ask for enough days.

Args:
  - slug (string): company slug, e.g. "SRF".
  - metrics (array of 'price' | 'dma50' | 'dma200' | 'volume' | 'pe' | 'median_pe' | 'eps'): series to fetch (default ['price']).
  - days (number): lookback window in calendar days, 30-20000 (default 365). 1095 is 3 years; 10000 returns the full available history.
  - consolidated (boolean): basis for the pe/eps overlays (default true).
  - max_points (number): evenly downsample each series to at most N points, 10-500 (default 120). Raise only when precise daily values matter — a 20-year daily series is over 1000 points per metric.
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns:
  {
    "slug": string,
    "chart_id": number,
    "days": number,
    "series": [
      {
        "metric": "Price",
        "label": "Price on NSE",
        "total_points": 247,        // before downsampling
        "sampled": true,            // true when points were thinned
        "points": [{ "date": "2025-09-19", "value": 2937.2 }]
      }
    ]
  }

Volume points carry an extra field, e.g. { "date": "...", "value": 4946623, "extra": { "delivery": 74 } } where delivery is the delivery percentage.

Series density varies per metric in the same window: price is daily, eps updates quarterly, median_pe may be a flat two-point line. Do not assume equal array lengths across series.

Examples:
  - "How has SRF moved this year?" -> metrics=['price'], days=365.
  - "Is it above its 200 DMA?" -> metrics=['price','dma200'], days=365.
  - "Is it expensive vs its own history?" -> metrics=['pe','median_pe'], days=3650.
  - "Show delivery volumes" -> metrics=['volume'].

Error Handling:
  - not_found if the slug is wrong.
  - rate_limited if screener throttles; wait a few seconds rather than retrying immediately.`,
      inputSchema: {
        slug: z.string().min(1).max(50).describe('Company slug, e.g. "SRF"'),
        metrics: z
          .array(z.enum(METRIC_KEYS))
          .min(1)
          .max(7)
          .default(["price"])
          .describe("Which series to fetch (default ['price'])"),
        days: z
          .number()
          .int()
          .min(30)
          .max(20000)
          .default(365)
          .describe("Lookback window in calendar days (default 365; 10000 for full history)"),
        consolidated: z.boolean().default(true).describe("Basis for pe/eps overlays"),
        max_points: z
          .number()
          .int()
          .min(10)
          .max(500)
          .default(120)
          .describe("Downsample each series to at most N points (default 120)"),
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        slug: z.string(),
        chart_id: z.number(),
        days: z.number(),
        series: z.array(
          z.object({
            metric: z.string(),
            label: z.string(),
            total_points: z.number(),
            sampled: z.boolean(),
            points: z.array(
              z.object({
                date: z.string(),
                value: z.number().nullable(),
                extra: z.record(z.number().nullable()).optional(),
              }),
            ),
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
    async ({ slug, metrics, days, consolidated, max_points, response_format }) => {
      try {
        const { chartId, series } = await getChart(slug, metrics, days, consolidated, max_points);

        const structured = {
          slug,
          chart_id: chartId,
          days,
          series: series.map((item) => ({
            metric: item.metric,
            label: item.label,
            total_points: item.totalPoints,
            sampled: item.sampled,
            points: item.points.map((point) => ({
              date: point.date,
              value: point.value,
              ...(point.extra ? { extra: point.extra } : {}),
            })),
          })),
        };

        const lines = [`# Price history — ${slug} (last ${days} days)`, ""];
        for (const item of series) {
          const first = item.points[0];
          const last = item.points[item.points.length - 1];
          lines.push(
            `## ${item.label} (${item.metric})`,
            `${item.totalPoints} points${item.sampled ? `, downsampled to ${item.points.length}` : ""}`,
          );
          if (first && last) {
            lines.push(`Range: ${first.date} = ${first.value ?? "—"} → ${last.date} = ${last.value ?? "—"}`);
            if (typeof first.value === "number" && typeof last.value === "number" && first.value !== 0) {
              const change = ((last.value - first.value) / first.value) * 100;
              lines.push(`Change: ${change.toFixed(1)}%`);
            }
          }
          lines.push("");
          lines.push(item.points.map((point) => `${point.date}: ${point.value ?? "—"}`).join("\n"), "");
        }

        return toResult(lines.join("\n"), structured, response_format);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
