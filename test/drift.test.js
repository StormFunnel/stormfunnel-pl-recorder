import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectDrift, diffEnvelopes, envelopeHash } from "../src/lib/drift.js";
import { parseSource } from "../src/lib/parsers.js";

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const env1 = { top: "array", item_keys: ["id", "stopien", "teryt"] };
const env2 = { top: "array", item_keys: ["id", "stopien", "teryt", "poziom_nowy"] };

test("first observation is not drift and hashes like the plain envelope (ack-file compatible)", () => {
  const r = detectDrift(undefined, env1, { nItems: 3 });
  assert.equal(r.drifted, false);
  assert.equal(r.first, true);
  assert.equal(r.record.hash, envelopeHash(env1));
  assert.deepEqual(r.record.seen, env1);
  assert.deepEqual(r.record.last, env1);
});

test("same envelope is stable", () => {
  const first = detectDrift(undefined, env1, { nItems: 3 });
  const r = detectDrift(first.record, { item_keys: ["id", "stopien", "teryt"], top: "array" }, { nItems: 3 });
  assert.equal(r.drifted, false);
  assert.equal(r.record.hash, first.record.hash);
});

test("added key is drift with a usable diff and grows the union", () => {
  const first = detectDrift(undefined, env1, { nItems: 3 });
  const r = detectDrift(first.record, env2, { nItems: 3 });
  assert.equal(r.drifted, true);
  assert.deepEqual(r.diff.item_keys.added, ["poziom_nowy"]);
  assert.deepEqual(r.diff.item_keys.removed, []);
  assert.deepEqual(r.record.seen.item_keys, ["id", "poziom_nowy", "stopien", "teryt"]);
  assert.notEqual(r.record.hash, first.record.hash);
});

test("EMPTY FEED (calm day, [] body) is NOT drift and leaves the hash alone", () => {
  const first = detectDrift(undefined, env1, { nItems: 3 });
  const empty = parseSource("imgw-meteo", "[]");
  assert.equal(empty.items.length, 0);
  assert.deepEqual(empty.envelope, { top: "array", item_keys: [] });
  const r = detectDrift(first.record, empty.envelope, { nItems: 0 });
  assert.equal(r.drifted, false);
  assert.equal(r.removed, undefined, "nothing to learn from an empty feed");
  assert.equal(r.record.hash, first.record.hash);
  // ...and when warnings come back with the same keys, still no drift
  const back = detectDrift(r.record, env1, { nItems: 2 });
  assert.equal(back.drifted, false);
  assert.equal(back.record.hash, first.record.hash);
});

test("optional key vanishing (Meteoalarm `references` when no Update records) is NOT drift, only informational", () => {
  const body = fx("meteoalarm-json-poland.json");
  const withUpdates = parseSource("meteoalarm-json", body);
  assert.ok(withUpdates.envelope.alert_keys.includes("references"));
  const first = detectDrift(undefined, withUpdates.envelope, { nItems: withUpdates.items.length });

  const data = JSON.parse(body);
  data.warnings = data.warnings.filter((w) => w.alert?.msgType !== "Update");
  const noUpdates = parseSource("meteoalarm-json", JSON.stringify(data));
  assert.ok(noUpdates.items.length > 0);
  assert.ok(!noUpdates.envelope.alert_keys.includes("references"), "fixture minus Updates has no `references` key");

  const r = detectDrift(first.record, noUpdates.envelope, { nItems: noUpdates.items.length });
  assert.equal(r.drifted, false);
  assert.deepEqual(r.removed, { alert_keys: ["references"] });
  assert.equal(r.record.hash, first.record.hash, "union is monotone: hash unchanged, ack stays valid");
  assert.ok(r.record.seen.alert_keys.includes("references"));
  assert.ok(!r.record.last.alert_keys.includes("references"));

  // Updates return: not drift, not even informational
  const again = detectDrift(r.record, withUpdates.envelope, { nItems: withUpdates.items.length });
  assert.equal(again.drifted, false);
  assert.equal(again.removed, undefined);
  assert.equal(again.record.hash, first.record.hash);
});

test("osmet with an empty warnings map ({} or PHP-style []) is not drift", () => {
  const full = parseSource("imgw-osmet", fx("imgw-osmet-teryt.json"));
  const first = detectDrift(undefined, full.envelope, { nItems: full.items.length });
  for (const body of ['{"warnings":{},"teryt":{},"program":{}}', '{"warnings":[],"teryt":[],"program":{}}']) {
    const p = parseSource("imgw-osmet", body);
    assert.equal(p.items.length, 0);
    const r = detectDrift(first.record, p.envelope, { nItems: 0 });
    assert.equal(r.drifted, false, body);
    assert.equal(r.record.hash, first.record.hash);
  }
});

test("top-level shape change IS drift even on an empty feed", () => {
  const first = detectDrift(undefined, env1, { nItems: 3 });
  const r = detectDrift(first.record, { top: "object", item_keys: [] }, { nItems: 0 });
  assert.equal(r.drifted, true);
  assert.deepEqual(r.diff.top, { added: ['"object"'], removed: ['"array"'] });
});

test("legacy record shape { hash, envelope } is upgraded in place", () => {
  const legacy = { hash: envelopeHash(env1), envelope: env1 };
  const r = detectDrift(legacy, env1, { nItems: 1 });
  assert.equal(r.drifted, false);
  assert.equal(r.record.hash, legacy.hash);
  assert.deepEqual(r.record.seen, env1);
});

test("diffEnvelopes reports removals and scalar changes", () => {
  const d = diffEnvelopes({ top: "array", a: ["x"] }, { top: "object", a: ["x"] });
  assert.deepEqual(d.top, { added: ['"object"'], removed: ['"array"'] });
  assert.equal(d.a, undefined);
});
