// Per-source fetch with retry. One source failing must never block another —
// poll.js runs sources independently and records per-source outcomes.

import { FETCH_ATTEMPTS, FETCH_BACKOFF_MS, FETCH_TIMEOUT_MS, USER_AGENT } from "../config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{ok:true, body:string, status:number, ms:number, attempts:number}
 *                  |{ok:false, error:string, status:number|null, ms:number, attempts:number}>}
 */
export async function fetchSource(source, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const started = Date.now();
  let lastError = "unknown";
  let lastStatus = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
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
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        // 4xx other than 408/429 will not improve on retry
        if (![408, 429].includes(res.status) && res.status < 500) break;
      } else {
        const body = await res.text();
        if (!body || body.length < 2) {
          lastError = "empty body";
        } else {
          return { ok: true, body, status: res.status, ms: Date.now() - started, attempts: attempt };
        }
      }
    } catch (err) {
      lastError = err?.name === "TimeoutError" ? `timeout after ${FETCH_TIMEOUT_MS}ms` : String(err?.message ?? err);
    }
    if (attempt < FETCH_ATTEMPTS) {
      await sleepImpl(FETCH_BACKOFF_MS[attempt - 1] ?? FETCH_BACKOFF_MS.at(-1));
    }
  }
  return { ok: false, error: lastError, status: lastStatus, ms: Date.now() - started, attempts: FETCH_ATTEMPTS };
}
