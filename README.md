# screener-mcp-server

MCP server for [screener.in](https://www.screener.in) — Indian equity fundamentals, peer comparison and price history.

Built on the site's undocumented internal endpoints (no official API exists). Verified live on 2026-09-19.

## Auth: four of five endpoints need nothing

| Tool | Upstream endpoint | Login needed |
|---|---|---|
| `screener_search_company` | `GET /api/company/search/` | no |
| `screener_get_company_overview` | `GET /company/{slug}/consolidated/` | no |
| `screener_get_financials` | same page HTML, parsed per section | no |
| `screener_get_peers` | `GET /api/company/{warehouse_id}/peers/` | no |
| `screener_get_price_history` | `GET /api/company/{chart_id}/chart/` | no |
| `screener_get_quick_ratios` | `GET /api/company/{warehouse_id}/quick_ratios/` | **yes** |
| `screener_search_ratios` | `GET /api/ratio/search/?q=` | no |
| `screener_run_screen` | `GET /screen/raw/?query=` (+ `/api/get/sectors/` for the industry breakdown) | **yes** |
| `screener_refresh_session` | none (reloads the local credential, then verifies it) | n/a |

`quick_ratios` and `run_screen` are gated — they 302-redirect to `/register/` without a valid session. Everything else works anonymously, so the server is useful with zero configuration.

Most headline ratios (Market Cap, Current Price, Stock P/E, Book Value, Dividend Yield, ROCE, ROE, Face Value) come from `screener_get_company_overview` **without** a login. `quick_ratios` only adds Price to book value, Industry PBV, Industry PE, Return on assets, Debt to equity, EPS, Sales growth % and Profit growth %.

## Screens

`screener_search_ratios` returns the exact field names screen queries accept (max 10 per search, no paging; aliases like `roce`, `p/e` work). `screener_run_screen` runs a query such as `Profit growth 3Years >= 15 AND Market Capitalization > 2500` and returns one page of results.

Upstream behaviour worth knowing (verified 2026-11-08):

- Page size must be 10-100. Screener **saves the `limit` param on the account** and reuses it on later requests that leave it out, so the tool always sends it.
- Result columns = the account's saved columns (Edit Columns on screener.in) + up to two query ratios not already shown + the sort ratio. To see a ratio's values, sort by it. An unknown sort name falls back silently to name order; the tool flags it.
- Bad queries come back as HTTP 200 with an error list (`Unknown word: ...`, `Syntax error in the query`), which the tool maps to `invalid_query`.
- A page past the end returns the last page.
- Industry filtering (`sectors=`) is a paid feature; free accounts get the unfiltered results plus "Please upgrade". Only the industry breakdown is exposed.

## Install

```bash
npm install
npm run build
```

## Configure

Add to your MCP client config (Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "screener": {
      "command": "node",
      "args": ["/Users/swastikgupta/screener-mcp-server/dist/index.js"]
    }
  }
}
```

## Session cookie (only for `quick_ratios`)

Get the value from a logged-in browser: DevTools → Application → Cookies → `https://www.screener.in` → `sessionid`. It is a live credential equal to being logged in — treat it like a password, and rotate it (log out and back in) if it leaks. The server never logs or returns it.

The cookie is resolved in this order, re-checked on every request:

1. **Runtime** — set by calling `screener_refresh_session` with a `session_id`.
2. **Credential file** — `~/.screener-mcp/session` (override with `SCREENER_SESSION_FILE`).
3. **Environment** — `SCREENER_SESSIONID`.

**Easiest: capture it from a login in your normal Chrome.**

One-time setup — install the bundled extension:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this repo's `browser-extension/` folder

Then leave the receiver running:

```bash
node scripts/capture-session.mjs --watch
```

From then on it is hands-off. The extension pushes the cookie automatically when you open any screener.in page, the instant a login completes, and every 5 minutes as an expiry check. The script verifies each cookie actually authenticates before writing it to the credential file (mode 0600).

Without `--watch` the script opens the login page itself, waits for one cookie, then exits — handy for a one-off refresh.

Flags: `--watch`, `--timeout=300` (seconds, ignored in watch mode), `--out=PATH`, `--port=8787`.

**Auto-prompt.** If the receiver is running and Chrome has no screener session cookie, the extension opens the login page in a new tab. It only does this when something is actually waiting for a token, never more than once per 10 minutes, and never when a screener tab is already open.

**Status badge** on the extension icon, with detail in the tooltip:

| Badge | Meaning |
|---|---|
| `OK` green | cookie sent and accepted |
| `ERR` red | screener rejected it — sign in again |
| `OFF` amber | receiver not running |
| `—` grey | no session cookie; you are signed out |

Why an extension: screener's `sessionid` is HttpOnly, so page JavaScript cannot read it — no bookmarklet or injected snippet can work. `chrome.cookies` can, and the manifest scopes it to `https://www.screener.in/*` and one localhost port. Nothing else is readable, no debug port is opened, and your everyday profile is used as-is.

After editing anything in `browser-extension/`, hit the reload icon on the extension's card in `chrome://extensions` — Chrome keeps running the old service worker otherwise.

**Manual alternative: the credential file.** Sessions expire, and the file is re-read on every call, so rotating the cookie needs no restart and the value never passes through a conversation transcript:

```bash
mkdir -p ~/.screener-mcp
printf '%s' 'your-sessionid-cookie-value' > ~/.screener-mcp/session
chmod 600 ~/.screener-mcp/session
```

Then call `screener_refresh_session` to confirm it works.

The `session_id` argument on that tool does the same thing inline without touching disk — convenient when you just want to paste a cookie, but it puts the value in the transcript.

Environment variable still works if you prefer it:

```json
{
  "mcpServers": {
    "screener": {
      "command": "node",
      "args": ["/Users/swastikgupta/screener-mcp-server/dist/index.js"],
      "env": { "SCREENER_SESSIONID": "your-sessionid-cookie-value" }
    }
  }
}
```

## Tools

- **`screener_search_company`** — name/ticker → slug. Start here.
- **`screener_get_company_overview`** — key ratios, pros/cons, business description, exchange codes, and both numeric ids.
- **`screener_get_financials`** — one of `quarters`, `profit_loss`, `balance_sheet`, `cash_flow`, `ratios`, `shareholding`. Parsed into `{periods, rows}` with numeric values.
- **`screener_get_peers`** — industry cohort table plus the median row. Column names vary by industry.
- **`screener_get_price_history`** — price/DMA/volume/PE/EPS time series, downsampled to keep responses small.
- **`screener_get_quick_ratios`** — extended ratio block (login required).
- **`screener_refresh_session`** — reload and verify the session cookie without restarting the server. Call it when `quick_ratios` returns `login_required`.

All tools take `response_format: "markdown" | "json"`. All are read-only except `screener_refresh_session`, which only changes in-process session state.

## Two id spaces

A company has two different numeric ids upstream, and crossing them returns 404:

- `chart_id` (`data-company-id` on the page) → used by `/chart/`. This is also what the search endpoint returns.
- `warehouse_id` (`data-warehouse-id` on the page) → used by `/peers/` and `/quick_ratios/`.

Search never returns `warehouse_id`, so the server fetches the company page to resolve it and caches the result for 5 minutes. All tools take a human-readable `slug` instead, so callers never handle ids directly.

## Testing

```bash
npm run build && node scripts/smoke-test.mjs
```

Drives all six tools against live screener.in, including a deliberate bad slug and the login-gated tool.

## Caveats

- These endpoints are undocumented and unsupported; screener can change or gate them at any time. `quick_ratios` was public until recently.
- `robots.txt` disallows `/*?q=`, which covers the search and chart endpoints. Keep usage low-volume and personal; do not run this as a bulk scraper.
- Chart values arrive as strings and are cast to numbers. Volume points carry an extra `{"delivery": n}` object whose value is sometimes `null`.
- Series density differs per metric in the same window (price daily, EPS quarterly, median PE nearly flat) — array lengths across series are not equal.
- Nothing here is investment advice.
