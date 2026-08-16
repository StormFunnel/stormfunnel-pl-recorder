import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSource, pickHeaders } from "../src/lib/fetcher.js";

const src = { key: "x", url: "https://example.invalid/feed", format: "json" };
const noSleep = async () => {};
const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => body,
});

test("200 with body: ok on first attempt, keeps cache/publisher headers", async () => {
  const calls = [];
  const r = await fetchSource(src, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return res(200, "[]  ", { date: "Sun, 16 Aug 2026 12:00:00 GMT", etag: '"abc"', age: "17", "x-ignored": "no" });
    },
    sleepImpl: noSleep,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers, { date: "Sun, 16 Aug 2026 12:00:00 GMT", etag: '"abc"', age: "17" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.headers["User-Agent"], /^stormfunnel-pl-recorder\//);
  assert.equal(calls[0].init.headers.Accept, "application/json, */*;q=0.1");
});

test("atom Accept carries the */* fallback (feeds.meteoalarm.org 406s without it)", async () => {
  let accept;
  await fetchSource({ ...src, format: "atom" }, { fetchImpl: async (u, init) => ((accept = init.headers.Accept), res(200, "<feed/>")), sleepImpl: noSleep });
  assert.equal(accept, "application/atom+xml, */*;q=0.1");
});

test("5xx retries up to FETCH_ATTEMPTS with backoff, reports the real attempt count", async () => {
  let n = 0;
  const sleeps = [];
  const r = await fetchSource(src, { fetchImpl: async () => (n += 1, res(503, "")), sleepImpl: async (ms) => sleeps.push(ms) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "HTTP 503");
  assert.equal(r.status, 503);
  assert.equal(r.attempts, 3);
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [2000, 5000]);
});

test("4xx (not 408/429) does NOT retry and reports attempts=1", async () => {
  let n = 0;
  const r = await fetchSource(src, { fetchImpl: async () => (n += 1, res(404, "nope")), sleepImpl: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.error, "HTTP 404");
  assert.equal(r.attempts, 1);
  assert.equal(n, 1);
});

test("429 retries", async () => {
  let n = 0;
  const r = await fetchSource(src, { fetchImpl: async () => (n += 1, n < 3 ? res(429, "") : res(200, "{}")), sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test("empty body counts as failure and retries", async () => {
  let n = 0;
  const r = await fetchSource(src, { fetchImpl: async () => (n += 1, res(200, n < 2 ? "" : "[1]")), sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test("timeout / network error is retried and named", async () => {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  const r = await fetchSource(src, { fetchImpl: async () => { throw err; }, sleepImpl: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /^timeout after \d+ms$/);
  assert.equal(r.attempts, 3);
  const r2 = await fetchSource(src, { fetchImpl: async () => { throw new Error("ECONNRESET"); }, sleepImpl: noSleep });
  assert.equal(r2.error, "ECONNRESET");
});

test("pickHeaders tolerates missing headers object", () => {
  assert.deepEqual(pickHeaders(undefined), {});
});
