export const BASE_URL = "https://www.screener.in";

export const USER_AGENT = "screener-mcp-server/1.0 (MCP server; contact via repo)";

export const REQUEST_TIMEOUT_MS = 20_000;

export const CHARACTER_LIMIT = 25_000;

/** Company page HTML is ~220KB and serves several tools, so it is cached briefly. */
export const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
export const PAGE_CACHE_MAX_ENTRIES = 12;

/** Screener slugs are tickers (SRF), numeric codes (544036) or contain & (M&M). */
export const SLUG_PATTERN = /^[A-Za-z0-9&._-]{1,50}$/;

/** Section id in the company page HTML for each financial statement. */
export const SECTION_IDS = {
  quarters: "quarters",
  profit_loss: "profit-loss",
  balance_sheet: "balance-sheet",
  cash_flow: "cash-flow",
  ratios: "ratios",
  shareholding: "shareholding",
} as const;

/** Chart metric keys mapped to the names screener's chart endpoint expects. */
export const CHART_METRICS = {
  price: "Price",
  dma50: "DMA50",
  dma200: "DMA200",
  volume: "Volume",
  pe: "Price to Earning",
  median_pe: "Median PE",
  eps: "EPS",
} as const;
