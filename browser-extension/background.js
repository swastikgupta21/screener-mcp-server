/**
 * Watches for the screener.in session cookie and hands it to the local capture
 * script. chrome.cookies can read HttpOnly cookies; page JavaScript cannot, which
 * is why this lives in an extension rather than a content script.
 *
 * Scope is deliberately narrow: one cookie, one domain, one local endpoint.
 */

const BASE = "http://127.0.0.1:8787";
const ENDPOINT = `${BASE}/session`;
const PING = `${BASE}/ping`;
const COOKIE_URL = "https://www.screener.in/";
const LOGIN_URL = "https://www.screener.in/login/";
const COOKIE_NAME = "sessionid";

/** Resending the same cookie repeatedly just costs screener round-trips. */
const RESEND_INTERVAL_MS = 60_000;
/** Never reopen a login tab more often than this, so a logged-out browser cannot loop. */
const PROMPT_INTERVAL_MS = 10 * 60_000;

let lastSentHash = null;
let lastSentAt = 0;
let lastPromptAt = 0;

const STATES = {
  sent: { text: "OK", color: "#1F8A4C", title: "Session sent and accepted" },
  rejected: { text: "ERR", color: "#C0392B", title: "screener.in rejected the cookie — sign in again" },
  offline: { text: "OFF", color: "#B7791F", title: "Capture script is not running (node scripts/capture-session.mjs)" },
  nocookie: { text: "—", color: "#888888", title: "No screener.in session cookie — you are signed out" },
};

async function setState(key, detail = "") {
  const state = STATES[key];
  await chrome.action.setBadgeBackgroundColor({ color: state.color });
  await chrome.action.setBadgeText({ text: state.text });
  await chrome.action.setTitle({
    title: `Screener Session Bridge — ${state.title}${detail ? `\n${detail}` : ""}`,
  });
}

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function listenerIsUp() {
  try {
    const response = await fetch(PING, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Opens the login page when a refresh is actually needed — that is, something
 * local is waiting for a cookie and the browser has none.
 */
async function promptLoginIfNeeded() {
  if (Date.now() - lastPromptAt < PROMPT_INTERVAL_MS) return;
  if (!(await listenerIsUp())) return;

  const cookie = await chrome.cookies.get({ url: COOKIE_URL, name: COOKIE_NAME });
  if (cookie?.value) return;

  const existing = await chrome.tabs.query({ url: "https://www.screener.in/*" });
  if (existing.length > 0) return;

  lastPromptAt = Date.now();
  await chrome.tabs.create({ url: LOGIN_URL, active: true });
  await setState("nocookie", "Opened the login page for you.");
}

async function sendSession({ force = false } = {}) {
  const cookie = await chrome.cookies.get({ url: COOKIE_URL, name: COOKIE_NAME });

  if (!cookie?.value) {
    await setState("nocookie");
    await promptLoginIfNeeded();
    return;
  }

  const fingerprint = await hash(cookie.value);
  const unchanged = fingerprint === lastSentHash;
  const recent = Date.now() - lastSentAt < RESEND_INTERVAL_MS;
  if (!force && unchanged && recent) return;

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: cookie.value,
    });

    if (response.ok) {
      lastSentHash = fingerprint;
      lastSentAt = Date.now();
      await setState("sent", new Date().toLocaleTimeString());
    } else {
      await setState("rejected");
    }
  } catch {
    await setState("offline");
  }
}

// Fires the moment a login completes and Chrome stores the new cookie.
chrome.cookies.onChanged.addListener(async ({ cookie, removed }) => {
  if (cookie.name !== COOKIE_NAME) return;
  if (!cookie.domain.includes("screener.in")) return;

  if (removed) {
    lastSentHash = null;
    await setState("nocookie");
    await promptLoginIfNeeded();
    return;
  }

  await sendSession({ force: true });
});

// Fires whenever you simply open or reload a screener.in page.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url?.startsWith("https://www.screener.in/")) return;
  sendSession();
});

// Manual resend, always forced.
chrome.action.onClicked.addListener(() => sendSession({ force: true }));

chrome.runtime.onStartup.addListener(() => sendSession({ force: true }));
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("session-check", { periodInMinutes: 5 });
  sendSession({ force: true });
});

// Catches the case where the cookie expires while you are not browsing screener.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "session-check") sendSession();
});
