import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { SECTION_IDS } from "../constants.js";
import type {
  CompanyOverview,
  FinancialTable,
  FinancialRow,
  FinancialPeriod,
  KeyValue,
  PeerRow,
  PeerTable,
  ScreenColumn,
  ScreenResults,
  ScreenRow,
} from "../types.js";

export type SectionKey = keyof typeof SECTION_IDS;

function clean(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Screener renders "3,338", "21%", "₹ 2,512" and "" for missing values. */
export function parseNumber(raw: string): number | null {
  const text = clean(raw).replace(/[₹%]/g, "").replace(/,/g, "").trim();
  if (!text || text === "-" || text === "—") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function attrNumber($: CheerioAPI, selector: string, attribute: string): number | null {
  const raw = $(selector).first().attr(attribute);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function parseCompanyPage(html: string, slug: string, consolidated: boolean): CompanyOverview {
  const $ = cheerio.load(html);

  const chartId = attrNumber($, "[data-company-id]", "data-company-id");
  if (chartId === null) {
    throw new Error(
      `Could not find data-company-id on the page for "${slug}". The slug may be wrong or screener changed its markup.`,
    );
  }

  const aboutNode = $(".company-profile .about").first().clone();
  aboutNode.find("sup").remove();
  const about = clean(aboutNode.text());

  const keyRatios: KeyValue[] = [];
  $("#top-ratios li").each((_, element) => {
    const name = clean($(element).find(".name").first().text());
    const value = clean($(element).find(".value").first().text());
    if (name) keyRatios.push({ name, value });
  });

  const pros: string[] = [];
  $("#analysis .pros li").each((_, element) => {
    const text = clean($(element).text());
    if (text) pros.push(text);
  });

  const cons: string[] = [];
  $("#analysis .cons li").each((_, element) => {
    const text = clean($(element).text());
    if (text) cons.push(text);
  });

  let website: string | null = null;
  $("a").each((_, element) => {
    if (website) return;
    if (clean($(element).text()) === "Website") {
      website = $(element).attr("href") ?? null;
    }
  });

  const headerText = clean($("#top").first().text());
  const bseCode = /BSE:\s*([0-9]+)/.exec(headerText)?.[1] ?? null;
  const nseCode = /NSE:\s*([A-Z0-9&_-]+)/.exec(headerText)?.[1] ?? null;

  const availableSections = (Object.keys(SECTION_IDS) as SectionKey[]).filter(
    (key) => $(`#${SECTION_IDS[key]}`).length > 0,
  );

  return {
    slug,
    name: clean($("h1").first().text()) || slug,
    chartId,
    warehouseId: attrNumber($, "[data-warehouse-id]", "data-warehouse-id"),
    consolidated,
    about: about || null,
    website,
    bseCode,
    nseCode,
    keyRatios,
    pros,
    cons,
    availableSections,
  };
}

interface SectionOptions {
  /** Shareholding ships two tables in one section. */
  shareholdingView?: "quarterly" | "yearly";
}

export function parseFinancialTable(
  html: string,
  section: SectionKey,
  options: SectionOptions = {},
): FinancialTable {
  const $ = cheerio.load(html);
  const root = $(`#${SECTION_IDS[section]}`);
  if (root.length === 0) {
    throw new Error(`Section "${section}" is not present on this company page.`);
  }

  const table =
    section === "shareholding"
      ? root.find(`#${options.shareholdingView ?? "quarterly"}-shp table`).first()
      : root.find("table").first();

  if (table.length === 0) {
    throw new Error(`Section "${section}" has no table — screener may not publish it for this company.`);
  }

  const periods: FinancialPeriod[] = [];
  table
    .find("thead th")
    .slice(1)
    .each((_, element) => {
      periods.push({
        label: clean($(element).text()),
        date: $(element).attr("data-date-key") ?? null,
      });
    });

  const rows: FinancialRow[] = [];
  table.find("tbody > tr").each((_, element) => {
    const cells = $(element).find("td");
    if (cells.length === 0) return;

    const labelCell = cells.first().clone();
    labelCell.find(".blue-icon, sup").remove();
    const label = clean(labelCell.text()).replace(/\s*\+$/, "");
    // "Raw PDF" is a row of document links, not financial data.
    if (!label || label === "Raw PDF") return;

    const values = cells
      .slice(1)
      .toArray()
      .map((cell) => parseNumber($(cell).text()));

    rows.push({ label, values });
  });

  const subtitle = clean(root.find("p.sub").first().text());
  const unit = subtitle ? (subtitle.split("/")[0] ?? "").trim() || null : null;

  return {
    section,
    title: clean(root.find("h2").first().text()) || section,
    unit,
    periods,
    rows,
  };
}

function peerRowFrom($: CheerioAPI, row: AnyNode, columns: string[]): PeerRow | null {
  const cells = $(row).find("td").toArray();
  if (cells.length < 2) return null;

  const nameCell = $(cells[1]);
  const link = nameCell.find("a").first();
  const href = link.attr("href") ?? "";
  const slugMatch = /^\/company\/([^/]+)\//.exec(href);

  const metrics: Record<string, number | null> = {};
  cells.slice(2).forEach((cell, index) => {
    const column = columns[index + 2] ?? `col_${index + 2}`;
    metrics[column] = parseNumber($(cell).text());
  });

  const chartIdRaw = $(row).attr("data-row-company-id");
  const chartId = chartIdRaw ? Number(chartIdRaw) : null;

  return {
    rank: parseNumber($(cells[0]).text()),
    name: clean(nameCell.text()),
    slug: slugMatch?.[1] ?? null,
    chartId: chartId !== null && Number.isFinite(chartId) ? chartId : null,
    metrics,
  };
}

export function parsePeers(html: string): PeerTable {
  const $ = cheerio.load(html);
  const table = $("table").first();
  if (table.length === 0) {
    throw new Error("Peers response contained no table.");
  }

  const columns: string[] = [];
  table
    .find("tr")
    .first()
    .find("th")
    .each((_, element) => {
      columns.push(clean($(element).text()) || `col_${columns.length}`);
    });

  const peers: PeerRow[] = [];
  table.find("tbody > tr").each((_, element) => {
    if ($(element).find("th").length > 0) return;
    const row = peerRowFrom($, element, columns);
    if (row && row.name) peers.push(row);
  });

  const footNode = table.find("tfoot > tr").first().get(0);
  const medianRow = footNode ? peerRowFrom($, footNode, columns) : null;

  return {
    industry: null,
    columns,
    peers,
    medianRow,
  };
}

export function parseQuickRatios(html: string): KeyValue[] {
  const $ = cheerio.load(html);
  const ratios: KeyValue[] = [];
  $("li").each((_, element) => {
    const name = clean($(element).find(".name").first().text());
    const value = clean($(element).find(".value").first().text());
    if (name) ratios.push({ name, value });
  });
  return ratios;
}

/**
 * Screen query errors come back as HTTP 200 with the message in the form's
 * errorlist, e.g. "Unknown word: foo bar" or "Syntax error in the query".
 */
export function parseScreenErrors(html: string): string[] {
  const $ = cheerio.load(html);
  const errors: string[] = [];
  $(".errorlist li, ul.errorlist").each((_, element) => {
    const text = clean($(element).text());
    if (text && !errors.includes(text)) errors.push(text);
  });
  return errors;
}

/** "198 results found: Showing page 1 of 4" */
function parsePageInfo(text: string): { total: number; page: number; pages: number } | null {
  const match = /([\d,]+)\s+results?\s+found.*?page\s+(\d+)\s+of\s+(\d+)/i.exec(text);
  if (!match) return null;
  return {
    total: Number(match[1]!.replace(/,/g, "")),
    page: Number(match[2]),
    pages: Number(match[3]),
  };
}

export function parseScreenResults(html: string): ScreenResults {
  const $ = cheerio.load(html);

  const info = parsePageInfo(clean($("[data-page-info]").first().text()));
  if (!info) {
    throw new Error("Screen results page had no result count. Screener may have changed its markup.");
  }

  const table = $("[data-page-results] table").first();

  // The header row is repeated every ~15 rows inside tbody; the first one defines the columns.
  // Columns vary per query (user's saved columns + query ratios + sort column), so never assume a fixed set.
  const columns: ScreenColumn[] = [];
  table
    .find("tr")
    .filter((_, row) => $(row).find("th").length > 0)
    .first()
    .find("th")
    .slice(2)
    .each((_, element) => {
      const th = $(element);
      const unitText = clean(th.find("span").last().text());
      const labelNode = th.clone();
      labelNode.find("span").remove();
      const label = clean(labelNode.text());
      columns.push({
        name: th.attr("data-tooltip")?.trim() || label || `col_${columns.length + 2}`,
        label,
        unit: unitText || null,
      });
    });

  const rows: ScreenRow[] = [];
  table.find("tr[data-row-company-id]").each((_, element) => {
    const cells = $(element).find("td").toArray();
    if (cells.length < 2) return;

    const link = $(cells[1]).find("a").first();
    const href = link.attr("href") ?? null;
    const slugMatch = href ? /^\/company\/([^/]+)\//.exec(href) : null;

    const metrics: Record<string, number | null> = {};
    columns.forEach((column, index) => {
      const cell = cells[index + 2];
      metrics[column.name] = cell ? parseNumber($(cell).text()) : null;
    });

    const idRaw = Number($(element).attr("data-row-company-id"));
    rows.push({
      rank: parseNumber($(cells[0]).text().replace(/\.$/, "")),
      name: clean(link.text() || $(cells[1]).text()),
      slug: slugMatch?.[1] ? decodeURIComponent(slugMatch[1]) : null,
      url: href,
      consolidated: href?.includes("/consolidated/") ?? false,
      chartId: Number.isFinite(idRaw) ? idRaw : null,
      metrics,
    });
  });

  return {
    totalResults: info.total,
    page: info.page,
    totalPages: info.pages,
    columns,
    rows,
  };
}
