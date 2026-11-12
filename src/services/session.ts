import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionSource = "runtime" | "file" | "environment" | "none";

/** Set by screener_refresh_session; takes priority so a refresh needs no restart. */
let runtimeOverride: string | null = null;

export function sessionFilePath(): string {
  return process.env.SCREENER_SESSION_FILE?.trim() || join(homedir(), ".screener-mcp", "session");
}

/** Accepts a bare cookie value or a pasted "sessionid=abc123" pair. */
function normalize(raw: string): string | null {
  const trimmed = raw.trim().replace(/^sessionid=/i, "").replace(/;$/, "").trim();
  return trimmed ? trimmed : null;
}

export function setRuntimeSession(value: string | null): void {
  runtimeOverride = value ? normalize(value) : null;
}

function readSessionFile(): string | null {
  try {
    return normalize(readFileSync(sessionFilePath(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolution order: runtime override, then credential file, then environment.
 * The file is re-read on every call so rotating it takes effect immediately.
 */
export function resolveSession(): { value: string | null; source: SessionSource } {
  if (runtimeOverride) return { value: runtimeOverride, source: "runtime" };

  const fromFile = readSessionFile();
  if (fromFile) return { value: fromFile, source: "file" };

  const fromEnv = process.env.SCREENER_SESSIONID ? normalize(process.env.SCREENER_SESSIONID) : null;
  if (fromEnv) return { value: fromEnv, source: "environment" };

  return { value: null, source: "none" };
}

export function getSessionId(): string | null {
  return resolveSession().value;
}

export function hasSession(): boolean {
  return getSessionId() !== null;
}
