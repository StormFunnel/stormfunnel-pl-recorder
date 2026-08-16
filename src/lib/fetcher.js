// Per-source fetch with retry. One source failing must never block another —
// poll.js runs sources independently and records per-source outcomes.

import { FETCH_ATTEMPTS, FETCH_BACKOFF_MS, FETCH_TIMEOUT_MS, USER_AGENT } from "../config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Response headers worth keeping on every poll line: they separate publisher
// generation time from CDN/cache delay, which the 10-min poll cannot resolve
// on its own. ~150 B/line.
const KEEP_HEADERS = ["date", "last-modified", "etag", "cache-control", "age", "x-cache", "cf-cache-status", "via"];

export function pickHeaders(headers) {
  const out = {};
  if (!headers || typeof headers.get !== "function") return out;
  for (const h of KEEP_HEADERS) {
    const v = headers.get(h);
    if (v != null && v !== "") out[h] = v;
  }
  return out;
}

/**
 * @returns {Promise<{ok:true, body:string, status:number, ms:number, attempts:number, headers:object}
 *                  |{ok:false, error:string, status:number|null, ms:number, attempts:number, headers?:object}>}
 */
export async function fetchSource(source, { fetchImpl = fetch, sleepImpl = sleep, attemptsMax = FETCH_ATTEMPTS } = {}) {
  const started = Date.now();
  let lastError = "unknown";
  let lastStatus = null;
  let lastHeaders;
  let attempt = 0;
  while (attempt < attemptsMax) {
    attempt += 1;
    try {
      const res = await fetchImpl(source.url, {
        headers: {
          "User-Agent": USER_AGENT,
          // feeds.meteoalarm.org answers 406 to a bare "application/atom+xml"
          // Accept (measured 2026-08-16); a */* fallback is required.
          Accept: source.format === "atom" ? "application/atom+xml, */*;q=0.1" : "application/json, */*;q=0.1",
          "Accept-Encoding": "gzip",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      lastStatus = res.status;
      lastHeaders = pickHeaders(res.headers);
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        // 4xx other than 408/429 will not improve on retry
        if (![408, 429].includes(res.status) && res.status < 500) break;
      } else {
        const body = await res.text();
        if (!body || body.length < 2) {
          lastError = "empty body";
        } else {
          return { ok: true, body, status: res.status, ms: Date.now() - started, attempts: attempt, headers: lastHeaders };
        }
      }
    } catch (err) {
      lastError = err?.name === "TimeoutError" ? `timeout after ${FETCH_TIMEOUT_MS}ms` : String(err?.message ?? err);
    }
    if (attempt < attemptsMax) {
      await sleepImpl(FETCH_BACKOFF_MS[attempt - 1] ?? FETCH_BACKOFF_MS.at(-1));
    }
  }
  return { ok: false, error: lastError, status: lastStatus, ms: Date.now() - started, attempts: attempt, headers: lastHeaders };
}
