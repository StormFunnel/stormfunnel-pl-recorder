// Parser tests run against the LIVE fixtures captured 2026-08-15 (fixtures/).
// Counts asserted below are facts about those exact files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hydroId,
  imgwIdFromCapIdentifier,
  parseCapReferences,
  parseSource,
} from "../src/lib/parsers.js";

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

test("imgw-meteo fixture: 7 warnings, ids, TERYT areas, Warsaw->UTC times", () => {
  const r = parseSource("imgw-meteo", fx("imgw-warningsmeteo.json"));
  assert.equal(r.items.length, 7);
  assert.equal(r.malformed, 0);
  const first = r.items.find((i) => i.id === "Gd20260814094159060");
  assert.ok(first);
  assert.equal(first.summary.event, "Upał");
  assert.equal(first.summary.level, "2");
  // "2026-08-15 13:00:00" Warsaw (CEST, +02:00) -> 11:00Z
  assert.equal(first.summary.valid_from, "2026-08-15T11:00:00.000Z");
  assert.equal(first.summary.n_areas, first.summary.areas.length);
  assert.ok(first.summary.areas.includes("1208"));
  assert.deepEqual(r.envelope.top, "array");
  assert.ok(r.envelope.item_keys.includes("teryt"));
});

test("imgw-hydro fixture: 93 rows, synthesized stable ids, open-ended data_do -> null", () => {
  const r = parseSource("imgw-hydro", fx("imgw-warningshydro.json"));
  assert.equal(r.items.length, 93);
  const ids = new Set(r.items.map((i) => i.id));
  assert.equal(ids.size, 93, "synthesized hydro ids must be unique across the fixture");
  const one = r.items[0];
  assert.match(one.id, /^hydro:\d{4}:\d+:[0-9a-f]{8}$/);
  assert.equal(one.summary.valid_to, null, "9999-12-31 must map to null");
  assert.ok(one.summary.areas.length >= 1);
});

test("hydroId is deterministic and office-scoped", () => {
  const a = { opublikowano: "2026-05-17 08:45:07", numer: "31", biuro: "BPH Wrocław" };
  assert.equal(hydroId(a), hydroId({ ...a }));
  assert.notEqual(hydroId(a), hydroId({ ...a, biuro: "BPH Kraków" }));
  assert.notEqual(hydroId(a), hydroId({ ...a, numer: "32" }));
});

test("imgw-osmet fixture: warnings map + reversed teryt index", () => {
  const r = parseSource("imgw-osmet", fx("imgw-osmet-teryt.json"));
  assert.equal(r.items.length, 7);
  const one = r.items.find((i) => i.id === "Sk20260815100248479");
  assert.ok(one);
  assert.equal(one.summary.level, "1");
  assert.match(one.summary.event, /^UP:/);
  assert.ok(one.summary.n_areas > 0, "areas come from the reversed teryt map");
  // Lx* carries the real offset: 2026-08-15T12:02:34+02:00 -> 10:02:34Z
  assert.equal(one.summary.valid_from, "2026-08-15T10:02:34.000Z");
  assert.deepEqual(r.envelope.top, ["program", "teryt", "warnings"]);
});

test("meteoalarm-json fixture: 352 records, msgType + refs + embedded IMGW id", () => {
  const r = parseSource("meteoalarm-json", fx("meteoalarm-json-poland.json"));
  assert.equal(r.items.length, 352);
  assert.equal(r.malformed, 0);
  const updates = r.items.filter((i) => i.summary.msg_type === "Update");
  assert.equal(updates.length, 15);
  const withRefs = updates.filter((i) => i.summary.refs.length > 0);
  assert.equal(withRefs.length, 15, "every Update in the fixture carries references");
  const one = r.items.find((i) => i.id === "2.49.0.0.616.0.PL.Sk20260815100248479.PL1061");
  assert.ok(one);
  assert.equal(one.summary.imgw_id, "Sk20260815100248479");
  // Meteoalarm awareness_level is 1..4 (green..red): IMGW stopien 1 == Meteoalarm "2; yellow".
  assert.equal(one.summary.level, "2; yellow; Moderate");
  assert.ok(one.summary.areas.includes("PL1061"));
});

test("meteoalarm-atom fixture: 351 entries, identifiers unique, cap fields extracted", () => {
  const r = parseSource("meteoalarm-atom", fx("meteoalarm-atom-poland.xml"));
  assert.equal(r.items.length, 351);
  assert.equal(new Set(r.items.map((i) => i.id)).size, 351);
  const one = r.items.find((i) => i.id === "2.49.0.0.616.0.PL.Sk20260815100248479.PL1061");
  assert.ok(one);
  assert.equal(one.summary.msg_type, "Update");
  assert.equal(one.summary.imgw_id, "Sk20260815100248479");
  assert.deepEqual(one.summary.areas, ["PL1061"]);
  assert.equal(one.summary.published, "2026-08-15T10:02:00.000Z");
  assert.match(one.norm.entry_xml_hash, /^[0-9a-f]{16}$/);
});

test("imgwIdFromCapIdentifier accepts the real pattern, rejects noise", () => {
  assert.equal(imgwIdFromCapIdentifier("2.49.0.0.616.0.PL.Sk20260815100248479.PL1061"), "Sk20260815100248479");
  assert.equal(imgwIdFromCapIdentifier("2.49.0.0.616.0.PL.260811032920.PL805_00931"), null, "marine numeric ids are not Biuro-prefixed");
  assert.equal(imgwIdFromCapIdentifier(null), null);
  assert.equal(imgwIdFromCapIdentifier("short.id"), null);
});

test("parseCapReferences splits sender,id,sent tuples", () => {
  assert.deepEqual(
    parseCapReferences("https://www.imgw.pl,2.49.0.0.616.0.PL.Gd20260814094133267.PL0208,2026-08-14T11:41:00+02:00"),
    ["2.49.0.0.616.0.PL.Gd20260814094133267.PL0208"],
  );
  assert.deepEqual(parseCapReferences("a,id1,t a,id2,t"), ["id1", "id2"]);
  assert.deepEqual(parseCapReferences(undefined), []);
});

test("IMGW teryt order shuffle does NOT change the hash (feed shuffles it between polls)", () => {
  const body = fx("imgw-warningsmeteo.json");
  const a = parseSource("imgw-meteo", body);
  const data = JSON.parse(body);
  data[0].teryt.reverse();
  data.reverse();
  const b = parseSource("imgw-meteo", JSON.stringify(data));
  const byId = new Map(b.items.map((i) => [i.id, i.hash]));
  for (const it of a.items) assert.equal(byId.get(it.id), it.hash);
});

test("mutating one IMGW row changes only that item's hash", () => {
  const body = fx("imgw-warningsmeteo.json");
  const a = parseSource("imgw-meteo", body);
  const data = JSON.parse(body);
  data[0].stopien = "3";
  const b = parseSource("imgw-meteo", JSON.stringify(data));
  assert.notEqual(a.items[0].hash, b.items[0].hash);
  assert.equal(a.items[1].hash, b.items[1].hash);
});

// ---------------------------------------------------------------- negative / edge shapes
test("negative bodies: HTML, empty array, empty warnings map, missing keys", () => {
  assert.throws(() => parseSource("imgw-meteo", "<html><body>503</body></html>"), /JSON/);
  assert.throws(() => parseSource("imgw-meteo", '{"not":"array"}'), /not an array/);
  assert.throws(() => parseSource("imgw-hydro", "null"), /not an array/);
  assert.throws(() => parseSource("imgw-osmet", "[]"), /missing warnings map/);
  assert.throws(() => parseSource("imgw-osmet", '{"teryt":{}}'), /missing warnings map/);
  assert.throws(() => parseSource("meteoalarm-json", '{"warnings":{}}'), /missing warnings array/);
  assert.throws(() => parseSource("meteoalarm-atom", "<html>Bad gateway</html>"), /not an Atom feed/);
  assert.throws(() => parseSource("nope", "{}"), /no parser/);

  const emptyMeteo = parseSource("imgw-meteo", "[]");
  assert.deepEqual(emptyMeteo, { items: [], malformed: 0, envelope: { top: "array", item_keys: [] } });
  const emptyOsmet = parseSource("imgw-osmet", '{"warnings":[],"teryt":[],"program":{"LxLastChange":"2026-08-16T06:29:59+02:00"}}');
  assert.equal(emptyOsmet.items.length, 0);
  assert.equal(emptyOsmet.meta.upstream_t, "2026-08-16T04:29:59.000Z");
  const emptyMa = parseSource("meteoalarm-json", '{"warnings":[]}');
  assert.deepEqual(emptyMa.envelope, { top: ["warnings"], record_keys: [], alert_keys: [], info_keys: [] });
  const emptyAtom = parseSource("meteoalarm-atom", '<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-08-16T04:05:16Z</updated></feed>');
  assert.equal(emptyAtom.items.length, 0);
  assert.equal(emptyAtom.meta.feed_updated, "2026-08-16T04:05:16.000Z");
});

test("rows without an id are counted as malformed, not thrown", () => {
  const r = parseSource("imgw-meteo", JSON.stringify([{ nazwa_zdarzenia: "x" }, { id: "A1", teryt: ["1"] }, null]));
  assert.equal(r.items.length, 1);
  assert.equal(r.malformed, 2);
  const h = parseSource("imgw-hydro", JSON.stringify([{ biuro: "b" }, 42]));
  assert.equal(h.malformed, 2);
  const m = parseSource("meteoalarm-json", JSON.stringify({ warnings: [{ uuid: "u" }, { alert: {} }] }));
  assert.equal(m.malformed, 2);
});

test("meteoalarm-atom: <entry xmlns=...> with attributes still yields every entry (regression: literal '<entry>' split)", () => {
  const body = fx("meteoalarm-atom-poland.xml").replace(/<entry>/g, '<entry xmlns="http://www.w3.org/2005/Atom" xml:lang="pl">');
  const r = parseSource("meteoalarm-atom", body);
  assert.equal(r.items.length, 351);
  assert.ok(!r.envelope.top.includes("entry"), "head tags stop at the first entry");
});

test("osmet meta carries IMGW's own generation time", () => {
  const r = parseSource("imgw-osmet", fx("imgw-osmet-teryt.json"));
  assert.equal(r.meta.upstream_t, "2026-08-16T04:29:59.000Z");
  assert.equal(r.meta.upstream_unix, 1786854599);
});
