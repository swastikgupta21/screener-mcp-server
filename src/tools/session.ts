import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResponseFormatSchema, toErrorResult, toResult } from "../format.js";
import { ScreenerError } from "../services/http.js";
import { resolveSession, sessionFilePath, setRuntimeSession } from "../services/session.js";
import { getQuickRatios } from "../services/screener.js";

/** Cheap, stable company used only to prove the cookie is accepted. */
const VERIFY_SLUG = "SRF";

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    "screener_refresh_session",
    {
      title: "Refresh the Screener session cookie",
      description: `Reload the screener.in session cookie used by screener_get_quick_ratios, without restarting the server.

Screener sessions expire. When screener_get_quick_ratios starts failing with a login_required error, use this tool rather than asking the user to restart anything.

Two ways to supply the cookie:

  1. Credential file (preferred). The user saves the cookie to ~/.screener-mcp/session (override with the SCREENER_SESSION_FILE env var), then this tool is called with no arguments to pick it up. The file is re-read on every request, so this mainly serves to verify and report status.

  2. Inline (session_id argument). Pass the cookie value directly and it is held in memory for the life of the process. Convenient, but the value then appears in the conversation transcript — prefer the file when the user cares about that, and suggest it if they paste a cookie into chat.

Args:
  - session_id (string, optional): the sessionid cookie value. Accepts a bare value or a pasted "sessionid=abc123" pair. Omit to reload from the credential file / environment.
  - verify (boolean): make one real request to confirm the cookie is accepted (default true).
  - response_format ('markdown' | 'json'): output format (default 'markdown').

Returns:
  {
    "source": "runtime" | "file" | "environment" | "none",  // where the active cookie came from
    "has_session": boolean,
    "verified": boolean | null,   // null when verify=false
    "session_file": string,       // path checked for the credential file
    "message": string
  }

The cookie value itself is never returned or logged.

Examples:
  - quick_ratios just failed with login_required and the user says they updated the file -> call with no arguments.
  - User pastes a fresh cookie in chat -> session_id="<value>", then mention the file option for next time.
  - Check whether a session is configured at all -> call with verify=false.

Error Handling:
  - has_session=false means no cookie was found anywhere; tell the user where the credential file goes.
  - verified=false means screener rejected the cookie — it is expired or wrong, and a new one must be copied from a logged-in browser.`,
      inputSchema: {
        session_id: z
          .string()
          .min(8)
          .max(200)
          .optional()
          .describe("Session cookie value. Omit to reload from the credential file or environment."),
        verify: z.boolean().default(true).describe("Confirm the cookie works with one live request"),
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        source: z.enum(["runtime", "file", "environment", "none"]),
        has_session: z.boolean(),
        verified: z.boolean().nullable(),
        session_file: z.string(),
        message: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ session_id, verify, response_format }) => {
      try {
        if (session_id) setRuntimeSession(session_id);

        const { value, source } = resolveSession();
        const filePath = sessionFilePath();

        if (!value) {
          const message = `No screener.in session found. Save the sessionid cookie to ${filePath} and call this tool again, or pass it as session_id.`;
          return toResult(
            message,
            { source, has_session: false, verified: null, session_file: filePath, message },
            response_format,
          );
        }

        let verified: boolean | null = null;
        let message = `Session loaded from ${source}. Verification skipped.`;

        if (verify) {
          try {
            await getQuickRatios(VERIFY_SLUG, true);
            verified = true;
            message = `Session loaded from ${source} and verified — screener_get_quick_ratios is ready.`;
          } catch (error) {
            if (error instanceof ScreenerError && error.code === "login_required") {
              verified = false;
              message = `Session loaded from ${source} but screener rejected it. Copy a fresh sessionid cookie from a logged-in browser and try again.`;
            } else {
              throw error;
            }
          }
        }

        return toResult(
          message,
          { source, has_session: true, verified, session_file: filePath, message },
          response_format,
        );
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
