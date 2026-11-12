import { z } from "zod";
import { CHARACTER_LIMIT } from "./constants.js";
import { ScreenerError } from "./services/http.js";

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' for compact human-readable text, 'json' for the full structured payload");

export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  /** Omitted on errors: the SDK validates it against the declared outputSchema. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Truncated at ${CHARACTER_LIMIT} characters. Narrow the request — fewer periods, fewer metrics, or a smaller max_points — to see the rest.]`
  );
}

export function toResult(
  markdown: string,
  structured: Record<string, unknown>,
  format: ResponseFormat,
): ToolResult {
  const text = format === "json" ? JSON.stringify(structured, null, 2) : markdown;
  return {
    content: [{ type: "text", text: truncate(text) }],
    structuredContent: structured,
  };
}

export function toErrorResult(error: unknown): ToolResult {
  const message =
    error instanceof ScreenerError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  const code = error instanceof ScreenerError ? error.code : "tool_error";

  return {
    content: [{ type: "text", text: `Error (${code}): ${message}` }],
    isError: true,
  };
}

export function markdownTable(headers: string[], rows: string[][]): string {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) {
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

export function formatValue(value: number | null): string {
  if (value === null) return "";
  return Number.isInteger(value) ? value.toLocaleString("en-IN") : value.toString();
}
