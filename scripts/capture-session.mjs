#!/usr/bin/env node
/**
 * Opens screener.in's login page in your normal Chrome window and waits for the
 * Screener Session Bridge extension to hand over the session cookie.
 *
 * The sessionid cookie is HttpOnly, so page JavaScript cannot read it. The
 * extension uses chrome.cookies, which can. This script is only the receiver:
 * it listens on 127.0.0.1, verifies the cookie actually authenticates, and
 * writes it to the credential file the MCP server reads.
 *
 * One-time setup: chrome://extensions -> Developer mode -> Load unpacked ->
 * select the browser-extension/ folder in this repo.
 *
 * Usage:
 *   node scripts/capture-session.mjs [--timeout=300] [--out=PATH] [--port=8787]
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOGIN_URL = "https://www.screener.in/login/";

/**
 * SRF's warehouse id. Any gated URL works; this one is stable and only ever
 * read to check whether screener accepts the cookie.
 */
const VERIFY_URL = "https://www.screener.in/api/company/6598836/quick_ratios/";

const SESSION_PATTERN = /^[A-Za-z0-9._-]{16,128}$/;

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, "").split("=");
      return [key, value ?? true];
    }),
  );
  return {
    timeoutMs: Number(args.timeout ?? 300) * 1000,
    outPath: args.out ?? process.env.SCREENER_SESSION_FILE ?? join(homedir(), ".screener-mcp", "session"),
    port: Number(args.port ?? 8787),
    // Stay resident so the extension can refresh the cookie whenever it changes.
    watch: Boolean(args.watch),
  };
}

function openInChrome(url) {
  // macOS 'open' hands the URL to the running Chrome, so it lands in a normal
  // window using the profile you are already signed into.
  const child = spawn("open", ["-a", "Google Chrome", url], { stdio: "ignore" });
  child.on("error", () => {
    console.log(`Could not launch Chrome automatically. Open this yourself: ${url}`);
  });
}

/** A cookie that does not actually authenticate is worse than none, so prove it works. */
async function verifyCookie(value) {
  const response = await fetch(VERIFY_URL, {
    headers: { Cookie: `sessionid=${value}`, "User-Agent": "screener-mcp-server/1.0" },
    redirect: "manual",
  });
  return response.status === 200;
}

function saveCookie(outPath, value) {
  mkdirSync(join(outPath, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, value, { mode: 0o600 });
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) request.destroy();
    });
    request.on("end", () => resolve(body.trim()));
  });
}

async function main() {
  const { timeoutMs, outPath, port, watch } = parseArgs();

  return new Promise((resolve) => {
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(code);
    };

    const server = createServer(async (request, response) => {
      // The extension's origin is chrome-extension://<id>, which is not known
      // until it is loaded, so allow the preflight and rely on verification.
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }

      // Lets the extension tell "nobody is waiting" from "listener is up", so it
      // only opens a login tab when a refresh is genuinely wanted.
      if (request.method === "GET" && request.url === "/ping") {
        response.writeHead(200).end("ok");
        return;
      }

      if (request.method !== "POST") {
        response.writeHead(405).end("POST only");
        return;
      }

      const value = await readBody(request);

      if (!SESSION_PATTERN.test(value)) {
        response.writeHead(400).end("malformed session value");
        console.error("Rejected a value that does not look like a session cookie.");
        return;
      }

      process.stdout.write("Received a cookie, verifying against screener.in... ");

      let valid = false;
      try {
        valid = await verifyCookie(value);
      } catch (error) {
        console.log(`failed (${error.message}).`);
        response.writeHead(502).end("verification failed");
        return;
      }

      if (!valid) {
        console.log("rejected.");
        console.error("screener.in did not accept that cookie. Make sure you are fully logged in, then click the extension icon to resend.");
        response.writeHead(401).end("screener rejected the cookie");
        return;
      }

      saveCookie(outPath, value);
      response.writeHead(200).end("ok");

      console.log("accepted.");
      console.log(`Saved to ${outPath} (mode 0600). Length ${value.length}.`);

      if (watch) {
        console.log("Still watching — the extension will push a new cookie whenever it changes.\n");
        return;
      }

      console.log("quick_ratios is ready — no restart needed.");
      finish(0);
    });

    const timer = watch
      ? null
      : setTimeout(() => {
          console.error("\nTimed out. Re-run, and if you were already logged in, click the extension icon to resend.");
          finish(1);
        }, timeoutMs);

    server.on("error", (error) => {
      console.error(
        error.code === "EADDRINUSE"
          ? `Port ${port} is busy — another capture script may already be running.`
          : `Listener failed: ${error.message}`,
      );
      finish(1);
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`Listening on 127.0.0.1:${port} for the Screener Session Bridge extension.`);

      if (watch) {
        console.log("Watch mode: staying resident. The extension pushes the cookie when you open");
        console.log("screener.in, when you log in, and if it opens the login page for you.");
        console.log("Ctrl-C to stop.\n");
        return;
      }

      console.log("Opening screener.in in your normal Chrome window...");
      console.log("Sign in there. The cookie is sent automatically the moment the login completes.");
      console.log(`Waiting up to ${Math.round(timeoutMs / 1000)}s...\n`);
      openInChrome(LOGIN_URL);
    });
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  });
