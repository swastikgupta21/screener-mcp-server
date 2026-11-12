import { BASE_URL, REQUEST_TIMEOUT_MS, USER_AGENT } from "../constants.js";
import { getSessionId } from "./session.js";

export type ScreenerErrorCode =
  | "login_required"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "network"
  | "http_error"
  | "invalid_query";

export class ScreenerError extends Error {
  constructor(
    readonly code: ScreenerErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ScreenerError";
  }
}

interface RequestOptions {
  /** Send the sessionid cookie when one is configured. */
  authenticated?: boolean;
  /** Referer header; screener does not require it but it keeps requests honest. */
  referer?: string;
}

/**
 * Query strings are built by callers because the chart endpoint expects a
 * literal `q=Price+to+Earning-Median+PE` where `+` is part of the metric name.
 */
export async function screenerGet(path: string, options: RequestOptions = {}): Promise<string> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: options.referer ?? `${BASE_URL}/`,
  };

  const sessionId = getSessionId();
  if (options.authenticated && sessionId) {
    headers["Cookie"] = `sessionid=${sessionId}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ScreenerError("timeout", `Request to ${path} timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw new ScreenerError(
      "network",
      `Could not reach screener.in: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    if (location.includes("/register") || location.includes("/login")) {
      throw new ScreenerError(
        "login_required",
        sessionId
          ? "The configured screener.in session is expired or invalid. Log in to screener.in in a browser, copy the fresh sessionid cookie, then call screener_refresh_session to load it — no restart needed."
          : "This screener.in endpoint requires a logged-in session. Save your screener.in sessionid cookie to the credential file and call screener_refresh_session, or set the SCREENER_SESSIONID environment variable.",
        response.status,
      );
    }
    throw new ScreenerError("http_error", `Unexpected redirect to ${location}`, response.status);
  }

  if (response.status === 404) {
    throw new ScreenerError(
      "not_found",
      `screener.in returned 404 for ${path}. Check the slug or id is correct — note that chart ids and peers/quick-ratio ids are different numbers for the same company.`,
      404,
    );
  }

  if (response.status === 429 || response.status === 503) {
    throw new ScreenerError(
      "rate_limited",
      "screener.in is throttling requests. Wait a few seconds and retry; avoid issuing bursts of calls.",
      response.status,
    );
  }

  if (!response.ok) {
    throw new ScreenerError("http_error", `screener.in returned HTTP ${response.status} for ${path}.`, response.status);
  }

  return response.text();
}

export async function screenerGetJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const body = await screenerGet(path, options);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ScreenerError("http_error", `Expected JSON from ${path} but got a non-JSON response.`);
  }
}
