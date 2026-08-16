import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySourceState, updateLedger } from "../src/lib/ledger.js";

const item = (id, hash, summary = {}, norm = { body: hash }) => ({ id, hash, norm, summary: { published: null, ...summary } });
const T = (n) => new Date(Date.UTC(2026, 7, 15, 10, n)).toISOString();

test("appeared on first sight, no events when unchanged", () => {
  let { state, events } = updateLedger(emptySourceState(), [item("A", "h1")], T(0));
  assert.equal(events.length, 1);
  assert.equal(events[0].ev, "appeared");
  assert.equal(events[0].backfill, true, "first poll ever is backfill");
  const before = JSON.stringify(state.active);
  ({ state, events } = updateLedger(state, [item("A", "h1")], T(5)));
  assert.equal(events.length, 0);
  assert.equal(JSON.stringify(state.active), before, "unchanged poll must not touch active entries");
  assert.equal(state.last_poll_t, T(5));
  assert.equal(state.active.A.first_seen, T(0));
});

test("appearances after the first poll are not backfill", () => {
  let { state } = updateLedger(emptySourceState(), [item("A", "h1")], T(0));
  const r = updateLedger(state, [item("A", "h1"), item("B", "h2")], T(10));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].id, "B");
  assert.equal(r.events[0].backfill, undefined);
});

test("disappeared.last_seen is the previous poll time, lifetime derivable", () => {
  let { state } = updateLedger(emptySourceState(), [item("A", "h1")], T(0));
  ({ state } = updateLedger(state, [item("A", "h1")], T(10)));
  ({ state } = updateLedger(state, [item("A", "h1")], T(20)));
  const r = updateLedger(state, [], T(30));
  assert.equal(r.events[0].ev, "disappeared");
  assert.equal(r.events[0].first_seen, T(0));
  assert.equal(r.events[0].last_seen, T(20));
  assert.equal(r.events[0].t, T(30));
});

test("changed on hash mutation, counts changes, names changed keys", () => {
  let { state } = updateLedger(emptySourceState(), [item("A", "h1", {}, { stopien: "1", tresc: "x" })], T(0));
  const r = updateLedger(state, [item("A", "h2", {}, { stopien: "2", tresc: "x" })], T(5));
  assert.deepEqual(
    r.events.map((e) => e.ev),
    ["changed"],
  );
  assert.equal(r.events[0].prev_hash, "h1");
  assert.deepEqual(r.events[0].changed_keys, ["stopien"]);
  assert.equal(r.state.active.A.changes, 1);
});

test("disappeared carries last summary fields for later classification", () => {
  let { state } = updateLedger(
    emptySourceState(),
    [item("A", "h1", { valid_to: T(30), msg_type: null, event: "Upał", level: "2", n_areas: 7 })],
    T(0),
  );
  const r = updateLedger(state, [], T(5));
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.ev, "disappeared");
  assert.equal(e.valid_to, T(30));
  assert.equal(e.level, "2");
  assert.equal(e.n_areas, 7);
  assert.equal(r.state.active.A, undefined);
  assert.ok(r.state.gone.A);
});

test("reappeared after disappearance keeps original first_seen", () => {
  let { state } = updateLedger(emptySourceState(), [item("A", "h1")], T(0));
  ({ state } = updateLedger(state, [], T(5)));
  const r = updateLedger(state, [item("A", "h1")], T(10));
  assert.deepEqual(
    r.events.map((e) => e.ev),
    ["reappeared"],
  );
  assert.equal(r.state.active.A.first_seen, T(0));
  assert.equal(r.state.gone.A, undefined);
});

test("gone map prunes past retention", () => {
  let { state } = updateLedger(emptySourceState(), [item("A", "h1")], T(0));
  ({ state } = updateLedger(state, [], T(5)));
  const later = new Date(Date.parse(T(5)) + 15 * 24 * 3600 * 1000).toISOString();
  const r = updateLedger(state, [], later, { goneRetentionMs: 14 * 24 * 3600 * 1000 });
  assert.equal(Object.keys(r.state.gone).length, 0);
});

test("duplicate ids within one poll: first wins, no phantom events", () => {
  const r = updateLedger(emptySourceState(), [item("A", "h1"), item("A", "h2")], T(0));
  assert.equal(r.events.length, 1);
  assert.equal(r.state.active.A.hash, "h1");
});
