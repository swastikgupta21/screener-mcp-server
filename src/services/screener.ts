import {
  CHART_METRICS,
  PAGE_CACHE_MAX_ENTRIES,
  PAGE_CACHE_TTL_MS,
  SLUG_PATTERN,
} from "../constants.js";
import { ScreenerError, screenerGet, screenerGetJson } from "./http.js";
import {
  parseCompanyPage,
  parseFinancialTable,
  parsePeers,
  parseQuickRatios,
  parseScreenErrors,
  parseScreenResults,
  type SectionKey,
} from "./parse.js";
import type {
  ChartPoint,
  ChartSeries,
  CompanyOverview,
  FinancialTable,
  KeyValue,
  IndustryCount,
  PeerTable,
  RatioInfo,
  ScreenResults,
  SearchResult,
} from "../types.js";

export type ChartMetricKey = keyof typeof CHART_METRICS;

interface CachedPage {
  html: string;
  overview: CompanyOverview;
  fetchedAt: number;
}

const pageCache = new Map<string, CachedPage>();

function assertSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new ScreenerError(
      "not_found",
      `"${slug}" is not a valid screener slug. Use screener_search_company to find the correct slug (e.g. "SRF", "TCS", "M&M").`,
    );
  }
  return slug;
}

function companyPath(slug: string, consolidated: boolean): string {
  const encoded = encodeURIComponent(slug);
  return consolidated ? `/company/${encoded}/consolidated/` : `/company/${encoded}/`;
}

/**
 * The company page is the only place that carries data-warehouse-id, so it is
 * fetched once and reused by the overview, financials, peers and quick-ratio tools.
 */
export async function getCompanyPage(slug: string, consolidated: boolean): Promise<CachedPage> {
  assertSlug(slug);
  const key = `${slug.toLowerCase()}|${consolidated}`;
  const cached = pageCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PAGE_CACHE_TTL_MS) {
    return cached;
  }

  const html = await screenerGet(companyPath(slug, consolidated));
  const entry: CachedPage = {
    html,
    overview: parseCompanyPage(html, slug, consolidated),
    fetchedAt: Date.now(),
  };

  if (pageCache.size >= PAGE_CACHE_MAX_ENTRIES) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  pageCache.set(key, entry);
  return entry;
}

export async function getCompanyOverview(slug: string, consolidated: boolean): Promise<CompanyOverview> {
  return (await getCompanyPage(slug, consolidated)).overview;
}

export async function getFinancials(
  slug: string,
  section: SectionKey,
  consolidated: boolean,
  shareholdingView?: "quarterly" | "yearly",
): Promise<FinancialTable> {
  const page = await getCompanyPage(slug, consolidated);
  return parseFinancialTable(page.html, section, { shareholdingView });
}

interface RawSearchResult {
  // null on the synthetic "Search everywhere: ..." row screener appends to results
  id: number | null;
  name: string;
  url: string;
}

function isCompanyResult(item: RawSearchResult): item is RawSearchResult & { id: number } {
  return item.id !== null && !item.url.startsWith("/full-text-search/");
}

export async function searchCompanies(query: string): Promise<SearchResult[]> {
  const results = await screenerGetJson<RawSearchResult[]>(
    `/api/company/search/?q=${encodeURIComponent(query)}&v=5`,
  );

  // Filter even without fts=1, in case screener starts appending the row anyway.
  return results.filter(isCompanyResult).map((item) => {
    const slugMatch = /^\/company\/([^/]+)\//.exec(item.url);
    return {
      name: item.name,
      slug: slugMatch?.[1] ?? item.url,
      chartId: item.id,
      url: item.url,
      consolidatedAvailable: item.url.includes("/consolidated/"),
    };
  });
}

async function resolveWarehouseId(slug: string, consolidated: boolean): Promise<number> {
  const overview = await getCompanyOverview(slug, consolidated);
  if (overview.warehouseId === null) {
    throw new ScreenerError(
      "not_found",
      `No data-warehouse-id found on the page for "${slug}", so peers and quick ratios cannot be fetched for this company.`,
    );
  }
  return overview.warehouseId;
}

export async function getPeers(slug: string, consolidated: boolean): Promise<PeerTable> {
  const warehouseId = await resolveWarehouseId(slug, consolidated);
  const html = await screenerGet(`/api/company/${warehouseId}/peers/`, {
    referer: `https://www.screener.in${companyPath(slug, consolidated)}`,
  });
  return parsePeers(html);
}

export async function getQuickRatios(slug: string, consolidated: boolean): Promise<KeyValue[]> {
  const warehouseId = await resolveWarehouseId(slug, consolidated);
  const html = await screenerGet(`/api/company/${warehouseId}/quick_ratios/`, {
    authenticated: true,
    referer: `https://www.screener.in${companyPath(slug, consolidated)}`,
  });
  return parseQuickRatios(html);
}

interface RawChartResponse {
  datasets: Array<{
    metric: string;
    label: string;
    values: Array<Array<string | number | Record<string, number>>>;
  }>;
}

function normalizePoint(raw: Array<string | number | Record<string, number>>): ChartPoint | null {
  const [date, value, extra] = raw;
  if (typeof date !== "string") return null;

  const numeric = typeof value === "number" ? value : Number(value);
  return {
    date,
    value: Number.isFinite(numeric) ? numeric : null,
    ...(extra && typeof extra === "object" ? { extra: extra as Record<string, number | null> } : {}),
  };
}

/** Evenly samples a long series so a 20-year daily history stays readable in context. */
function downsample(points: ChartPoint[], maxPoints: number): { points: ChartPoint[]; sampled: boolean } {
  if (points.length <= maxPoints) return { points, sampled: false };

  const step = (points.length - 1) / (maxPoints - 1);
  const sampledPoints: ChartPoint[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const point = points[Math.round(index * step)];
    if (point) sampledPoints.push(point);
  }
  return { points: sampledPoints, sampled: true };
}

export async function getChart(
  slug: string,
  metrics: ChartMetricKey[],
  days: number,
  consolidated: boolean,
  maxPoints: number,
): Promise<{ chartId: number; series: ChartSeries[] }> {
  const overview = await getCompanyOverview(slug, consolidated);

  // Metric names keep their spaces as "+" and are joined by "-", e.g.
  // q=Price+to+Earning-Median+PE-EPS. Building this by hand avoids the
  // percent-encoding URLSearchParams would apply.
  const query = metrics.map((metric) => CHART_METRICS[metric].replace(/ /g, "+")).join("-");
  const path = `/api/company/${overview.chartId}/chart/?q=${query}&days=${days}&consolidated=${consolidated}`;

  const raw = await screenerGetJson<RawChartResponse>(path, {
    referer: `https://www.screener.in${companyPath(slug, consolidated)}`,
  });

  const series: ChartSeries[] = raw.datasets.map((dataset) => {
    const points = dataset.values
      .map(normalizePoint)
      .filter((point): point is ChartPoint => point !== null);
    const { points: finalPoints, sampled } = downsample(points, maxPoints);
    return {
      metric: dataset.metric,
      label: dataset.label,
      points: finalPoints,
      totalPoints: points.length,
      sampled,
    };
  });

  return { chartId: overview.chartId, series };
}

/** Public endpoint; returns at most 10 matches and accepts aliases like "roce" or "p/e". */
export async function searchRatios(query: string): Promise<RatioInfo[]> {
  const results = await screenerGetJson<Array<Partial<RatioInfo>>>(
    `/api/ratio/search/?q=${encodeURIComponent(query)}`,
    { referer: "https://www.screener.in/screen/new/" },
  );
  return results
    .filter((item): item is Partial<RatioInfo> & { name: string } => typeof item.name === "string")
    .map((item) => ({
      name: item.name,
      // Descriptions carry template indentation and newlines.
      description: (item.description ?? "").replace(/\s+/g, " ").trim(),
      unit: item.unit ?? "",
    }));
}

export interface ScreenOptions {
  page: number;
  pageSize: number;
  sort?: string;
  order: "asc" | "desc";
}

function screenParams(query: string, options?: ScreenOptions): URLSearchParams {
  const params = new URLSearchParams();
  params.set("query", query);
  if (options) {
    params.set("sort", options.sort ? options.sort.trim().toLowerCase() : "");
    params.set("order", options.sort ? options.order : "");
    params.set("page", String(options.page));
    // Screener persists the page size on the account when `limit` is sent, and
    // reuses it on later requests that omit it — so always send it explicitly.
    params.set("limit", String(options.pageSize));
  }
  return params;
}

export function screenUrl(query: string): string {
  return `https://www.screener.in/screen/raw/?${screenParams(query).toString()}`;
}

export async function runScreen(query: string, options: ScreenOptions): Promise<ScreenResults> {
  const html = await screenerGet(`/screen/raw/?${screenParams(query, options).toString()}`, {
    authenticated: true,
    referer: "https://www.screener.in/screen/new/",
  });

  const errors = parseScreenErrors(html);
  if (errors.length > 0) {
    throw new ScreenerError(
      "invalid_query",
      `Screener rejected the query: ${errors.join("; ")}. Ratio names must match screener exactly — look them up with screener_search_ratios. Combine conditions with AND / OR, use parentheses, and compare with > < >= <= = (arithmetic like "Return on equity > Debt to equity * 10" is allowed).`,
    );
  }

  return parseScreenResults(html);
}

/** Industry breakdown of the full result set. Free to read; filtering by industry is a paid feature. */
export async function getScreenIndustries(query: string): Promise<IndustryCount[]> {
  const params = screenParams(query);
  params.set("url_name", "raw_query");
  const raw = await screenerGetJson<Array<{ code?: string; name?: string }>>(
    `/api/get/sectors/?${params.toString()}`,
    { authenticated: true, referer: screenUrl(query) },
  );
  return raw
    .filter((item) => typeof item.name === "string")
    .map((item) => {
      // "Pharmaceuticals - 14" -> industry + count
      const match = /^(.*?)\s+-\s+(\d+)$/.exec(item.name!.trim());
      return {
        code: item.code ?? "",
        industry: match ? match[1]! : item.name!.trim(),
        count: match ? Number(match[2]) : null,
      };
    });
}
