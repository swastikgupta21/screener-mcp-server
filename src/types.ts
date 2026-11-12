/**
 * Screener exposes two distinct numeric id spaces for the same company:
 * chartId powers /chart/, warehouseId powers /peers/ and /quick_ratios/.
 * Calling one endpoint with the other id returns 404.
 */
export interface CompanyIds {
  slug: string;
  name: string;
  chartId: number;
  warehouseId: number | null;
  consolidated: boolean;
}

export interface SearchResult {
  name: string;
  slug: string;
  chartId: number;
  url: string;
  consolidatedAvailable: boolean;
}

export interface KeyValue {
  name: string;
  value: string;
}

export interface CompanyOverview extends CompanyIds {
  about: string | null;
  website: string | null;
  bseCode: string | null;
  nseCode: string | null;
  keyRatios: KeyValue[];
  pros: string[];
  cons: string[];
  availableSections: string[];
}

export interface FinancialPeriod {
  label: string;
  date: string | null;
}

export interface FinancialRow {
  label: string;
  values: (number | null)[];
}

export interface FinancialTable {
  section: string;
  title: string;
  unit: string | null;
  periods: FinancialPeriod[];
  rows: FinancialRow[];
}

export interface PeerRow {
  rank: number | null;
  name: string;
  slug: string | null;
  chartId: number | null;
  metrics: Record<string, number | null>;
}

export interface PeerTable {
  industry: string | null;
  columns: string[];
  peers: PeerRow[];
  medianRow: PeerRow | null;
}

export interface ChartPoint {
  date: string;
  value: number | null;
  /** Volume points carry an extra object, e.g. {"delivery": 57} — the inner value can be null. */
  extra?: Record<string, number | null> | null;
}

export interface ChartSeries {
  metric: string;
  label: string;
  points: ChartPoint[];
  totalPoints: number;
  sampled: boolean;
}

/** One entry from /api/ratio/search/ — `name` is the exact token screen queries accept. */
export interface RatioInfo {
  name: string;
  description: string;
  unit: string;
}

export interface ScreenColumn {
  /** Canonical ratio name (the th data-tooltip), e.g. "Market Capitalization". Keys `metrics`. */
  name: string;
  /** Short header label screener shows, e.g. "Mar Cap". */
  label: string;
  unit: string | null;
}

export interface ScreenRow {
  rank: number | null;
  /** Screener truncates long names in screen results ("Waaree Renewab."); use slug to identify. */
  name: string;
  slug: string | null;
  url: string | null;
  consolidated: boolean;
  chartId: number | null;
  metrics: Record<string, number | null>;
}

export interface ScreenResults {
  totalResults: number;
  page: number;
  totalPages: number;
  columns: ScreenColumn[];
  rows: ScreenRow[];
}

export interface IndustryCount {
  code: string;
  industry: string;
  count: number | null;
}
