import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDrift, diffEnvelopes, envelopeHash } from "../src/lib/drift.js";

const env1 = { top: "array", item_keys: ["id", "stopien", "teryt"] };
const env2 = { top: "array", item_keys: ["id", "stopien", "teryt", "poziom_nowy"] };

test("first observation is not drift", () => {
  const r = detectDrift(undefined, env1);
  assert.equal(r.drifted, false);
  assert.equal(r.first, true);
  assert.equal(r.record.hash, envelopeHash(env1));
});

test("same envelope is stable", () => {
  const first = detectDrift(undefined, env1);
  const r = detectDrift(first.record, { item_keys: ["id", "stopien", "teryt"], top: "array" });
  assert.equal(r.drifted, false);
});

test("added key is drift with a usable diff", () => {
  const first = detectDrift(undefined, env1);
  const r = detectDrift(first.record, env2);
  assert.equal(r.drifted, true);
  assert.deepEqual(r.diff.item_keys.added, ["poziom_nowy"]);
  assert.deepEqual(r.diff.item_keys.removed, []);
});

test("diffEnvelopes reports removals and scalar changes", () => {
  const d = diffEnvelopes({ top: "array", a: ["x"] }, { top: "object", a: ["x"] });
  assert.deepEqual(d.top, { added: ['"object"'], removed: ['"array"'] });
  assert.equal(d.a, undefined);
});
