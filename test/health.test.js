import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHealth } from "../src/lib/health.js";

const H = 3_600_000;
const T0 = Date.parse("2026-08-16T12:00:00Z");
const sources = [{ key: "a" }, { key: "b" }, { key: "c" }];
const base = {
  sources,
  siblings: [["a", "b"]],
  staleAfterMs: 2 * H,
  renotifyAfterMs: 6 * H,
  zeroItemsAfterMs: 12 * H,
};
const hbAt = (t, over = {}) => ({
  updated: new Date(t).toISOString(),
  sources: {
    a: { last_success: new Date(t).toISOString(), consecutive_failures: 0, n_items: 3, zero_since: null, ...over.a },
    b: { last_success: new Date(t).toISOString(), consecutive_failures: 0, n_items: 3, zero_since: null, ...over.b },
    c: { last_success: new Date(t).toISOString(), consecutive_failures: 0, n_items: 3, zero_since: null, ...over.c },
  },
});
const stateWith = (hashes) => ({
  sources: Object.fromEntries(Object.entries(hashes).map(([k, h]) => [k, { schema: { hash: h } }])),
});

test("healthy: no problems, exit 0, first schema hashes auto-acked", () => {
  const r = evaluateHealth({ ...base, now: T0, heartbeat: hbAt(T0), state: stateWith({ a: "h1", b: "h2" }), acked: {} });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ackedDirty, true);
  assert.deepEqual(r.acked, { a: "h1", b: "h2" });
  assert.deepEqual(r.alarms, {});
});

test("no heartbeat -> one problem, notifies", () => {
  const r = evaluateHealth({ ...base, now: T0, heartbeat: null, state: {}, acked: {} });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.notify.map((p) => p.key), ["heartbeat:missing"]);
});

test("stale source: notify once, then suppress for RENOTIFY_AFTER_MS, then notify again", () => {
  const hb = hbAt(T0, { a: { last_success: new Date(T0 - 3 * H).toISOString(), consecutive_failures: 18 } });
  const r1 = evaluateHealth({ ...base, now: T0, heartbeat: hb, state: {}, acked: {}, alarms: {} });
  assert.equal(r1.exitCode, 1);
  assert.deepEqual(r1.notify.map((p) => p.key), ["a:stale"]);
  assert.equal(r1.alarms["a:stale"].first_failed_at, new Date(T0).toISOString());

  // 10 minutes later, still stale: known problem, no red run
  const r2 = evaluateHealth({ ...base, now: T0 + 600_000, heartbeat: hb, state: {}, acked: {}, alarms: r1.alarms });
  assert.equal(r2.exitCode, 0);
  assert.deepEqual(r2.suppressed.map((p) => p.key), ["a:stale"]);
  assert.equal(r2.alarms["a:stale"].last_notified_at, r1.alarms["a:stale"].last_notified_at);
  assert.equal(r2.alarms["a:stale"].first_failed_at, r1.alarms["a:stale"].first_failed_at);

  // 6 h + 1 s later, a still stale (b, c fresh): renotify a
  const hb3 = hbAt(T0 + 6 * H + 1000, { a: { last_success: new Date(T0 - 3 * H).toISOString(), consecutive_failures: 54 } });
  const r3 = evaluateHealth({ ...base, now: T0 + 6 * H + 1000, heartbeat: hb3, state: {}, acked: {}, alarms: r2.alarms });
  assert.deepEqual(r3.notify.map((p) => p.key), ["a:stale"]);
  assert.equal(r3.exitCode, 1);
  assert.equal(r3.alarms["a:stale"].notified, 2);

  // recovered: alarm entry dropped, next occurrence notifies again
  const r4 = evaluateHealth({ ...base, now: T0 + 7 * H, heartbeat: hbAt(T0 + 7 * H), state: {}, acked: {}, alarms: r3.alarms });
  assert.equal(r4.exitCode, 0);
  assert.deepEqual(r4.recovered, ["a:stale"]);
  assert.deepEqual(r4.alarms, {});
});

test("a second, different problem notifies even while the first is suppressed", () => {
  const hb = hbAt(T0, { a: { last_success: new Date(T0 - 3 * H).toISOString() } });
  const r1 = evaluateHealth({ ...base, now: T0, heartbeat: hb, state: {}, acked: {} });
  const hb2 = hbAt(T0, {
    a: { last_success: new Date(T0 - 3 * H).toISOString() },
    b: { last_success: new Date(T0 - 3 * H).toISOString() },
  });
  const r2 = evaluateHealth({ ...base, now: T0 + 600_000, heartbeat: hb2, state: {}, acked: {}, alarms: r1.alarms });
  assert.equal(r2.exitCode, 1);
  assert.deepEqual(r2.notify.map((p) => p.key), ["b:stale"]);
  assert.deepEqual(r2.suppressed.map((p) => p.key), ["a:stale"]);
});

test("schema drift: keyed by hash so an ack clears it and a further drift notifies anew", () => {
  const acked = { a: "h1" };
  const r1 = evaluateHealth({ ...base, now: T0, heartbeat: hbAt(T0), state: stateWith({ a: "h2" }), acked });
  assert.equal(r1.exitCode, 1);
  assert.deepEqual(r1.notify.map((p) => p.key), ["a:drift:h2"]);
  assert.equal(r1.ackedDirty, false, "drift must never auto-ack");
  const r2 = evaluateHealth({ ...base, now: T0 + 60_000, heartbeat: hbAt(T0), state: stateWith({ a: "h2" }), acked, alarms: r1.alarms });
  assert.equal(r2.exitCode, 0);
  // Bart acks h2
  const r3 = evaluateHealth({ ...base, now: T0 + 120_000, heartbeat: hbAt(T0), state: stateWith({ a: "h2" }), acked: { a: "h2" }, alarms: r2.alarms });
  assert.equal(r3.exitCode, 0);
  assert.deepEqual(r3.recovered, ["a:drift:h2"]);
  // then it drifts again to h3 within the renotify window: new key -> notify
  const r4 = evaluateHealth({ ...base, now: T0 + 180_000, heartbeat: hbAt(T0), state: stateWith({ a: "h3" }), acked: { a: "h2" }, alarms: r3.alarms });
  assert.equal(r4.exitCode, 1);
});

test("zero-items rule: fires only after zeroItemsAfterMs and only when the sibling has items", () => {
  const zeroSince = new Date(T0 - 13 * H).toISOString();
  const r = evaluateHealth({ ...base, now: T0, heartbeat: hbAt(T0, { a: { n_items: 0, zero_since: zeroSince } }), state: {}, acked: {} });
  assert.deepEqual(r.notify.map((p) => p.key), ["a:zero-items"]);
  // both empty (calm day): fine
  const r2 = evaluateHealth({
    ...base,
    now: T0,
    heartbeat: hbAt(T0, { a: { n_items: 0, zero_since: zeroSince }, b: { n_items: 0, zero_since: zeroSince } }),
    state: {},
    acked: {},
  });
  assert.equal(r2.exitCode, 0);
  // recently empty: fine
  const r3 = evaluateHealth({ ...base, now: T0, heartbeat: hbAt(T0, { a: { n_items: 0, zero_since: new Date(T0 - H).toISOString() } }), state: {}, acked: {} });
  assert.equal(r3.exitCode, 0);
  // c has no sibling: never fires
  const r4 = evaluateHealth({ ...base, now: T0, heartbeat: hbAt(T0, { c: { n_items: 0, zero_since: zeroSince } }), state: {}, acked: {} });
  assert.equal(r4.exitCode, 0);
});

test("poll crash outcome is a deduped problem", () => {
  const r1 = evaluateHealth({ ...base, now: T0, heartbeat: hbAt(T0), state: {}, acked: {}, pollOutcome: "failure" });
  assert.deepEqual(r1.notify.map((p) => p.key), ["poll:crashed"]);
  const r2 = evaluateHealth({ ...base, now: T0 + 600_000, heartbeat: hbAt(T0), state: {}, acked: {}, pollOutcome: "failure", alarms: r1.alarms });
  assert.equal(r2.exitCode, 0);
  const r3 = evaluateHealth({ ...base, now: T0 + 1_200_000, heartbeat: hbAt(T0), state: {}, acked: {}, pollOutcome: "success", alarms: r2.alarms });
  assert.deepEqual(r3.recovered, ["poll:crashed"]);
});
