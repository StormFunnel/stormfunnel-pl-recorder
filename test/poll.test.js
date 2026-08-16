// End-to-end tick against a scratch RECORDER_ROOT with an injected fetch.
// RECORDER_ROOT is read when config.js loads, so it is set before the dynamic import.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "recorder-test-"));
process.env.RECORDER_ROOT = root;

const { pollOnce } = await import("../src/poll.js");
const { SOURCES } = await import("../src/config.js");
const { readLedger, readPollLog, readHeartbeat, readState } = await import("../src/lib/store.js");

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const FIXTURE = {
  "imgw-meteo": fx("imgw-warningsmeteo.json"),
  "imgw-hydro": fx("imgw-warningshydro.json"),
  "imgw-osmet": fx("imgw-osmet-teryt.json"),
  "meteoalarm-json": fx("meteoalarm-json-poland.json"),
  "meteoalarm-atom": fx("meteoalarm-atom-poland.xml"),
};
const byUrl = Object.fromEntries(SOURCES.map((s) => [s.url, s.key]));

// scripted responses per source key: array of {status, body} consumed per call; default = fixture 200
const script = {};
const fetchImpl = async (url) => {
  const key = byUrl[url];
  const next = script[key]?.shift() ?? { status: 200, body: FIXTURE[key] };
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    headers: new Headers({ date: "Sun, 16 Aug 2026 12:00:00 GMT", age: "3" }),
    text: async () => next.body,
  };
};

// deterministic clock: each tick +10 min
let tick = 0;
const T0 = Date.parse("2026-08-31T23:45:00Z");
const clock = () => new Date(T0 + tick * 600_000).toISOString();

after(() => rmSync(root, { recursive: true, force: true }));
let schemaHashAfterTick1 = null;

test("tick 1: backfill — everything appears, snapshots + items + ledger written under RECORDER_ROOT", async () => {
  const r = await pollOnce({ fetchImpl, now: clock });
  assert.equal(r.anySuccess, true);
  assert.equal(r.anyException, false);
  const led = await readLedger("imgw-meteo");
  assert.equal(led.length, 7);
  assert.ok(led.every((e) => e.ev === "appeared" && e.backfill === true));
  const files = await fs.readdir(path.join(root, "ledger", "imgw-meteo"));
  assert.deepEqual(files, ["2026-08.ndjson"], "ledger is monthly per source");
  const polls = await readPollLog("imgw-osmet");
  assert.equal(polls.length, 1);
  assert.equal(polls[0].ok, true);
  assert.deepEqual(polls[0].hdr, { date: "Sun, 16 Aug 2026 12:00:00 GMT", age: "3" });
  assert.equal(polls[0].meta.upstream_t, "2026-08-16T04:29:59.000Z");
  const hb = await readHeartbeat();
  assert.equal(hb.sources["imgw-meteo"].n_items, 7);
  assert.equal(hb.sources["imgw-meteo"].zero_since, null);
  const items = await fs.readFile(path.join(root, "data", "items", "imgw-meteo", "2026-08.ndjson"), "utf8");
  assert.equal(items.trim().split("\n").length, 7);
  schemaHashAfterTick1 = hb.sources["imgw-meteo"].schema_hash;
  // same value as the committed state/acknowledged-schemas.json entry: the new
  // seen-union hash is backward compatible with the plain-envelope hash
  assert.equal(schemaHashAfterTick1, "cd6c64de970696386cb234bbe656f68ffff51cf749f7048d3e4566b5c08a7d43");
});

test("tick 2 (next month): unchanged — no events, no snapshot, poll line lands in the new month file", async () => {
  tick = 2; // 2026-09-01T00:05Z
  const r = await pollOnce({ fetchImpl, now: clock });
  assert.ok(r.summaryLines.every((l) => l.includes("0 events")), r.summaryLines.join("\n"));
  const polls = await readPollLog("imgw-meteo");
  assert.equal(polls.length, 2);
  assert.equal(polls[1].changed, false);
  assert.equal(polls[1].snapshot, null, "on-change source, unchanged: no snapshot");
  const maPolls = await readPollLog("meteoalarm-json");
  assert.ok(maPolls[1].snapshot, "daily source: first poll of the new UTC day takes a keyframe even if unchanged");
  const files = await fs.readdir(path.join(root, "data", "polls", "imgw-meteo"));
  assert.deepEqual(files, ["2026-08.ndjson", "2026-09.ndjson"]);
});

test("tick 3: imgw-meteo goes EMPTY — 7 disappeared, NO schema drift, zero_since set", async () => {
  tick = 3;
  script["imgw-meteo"] = [{ status: 200, body: "[]" }];
  const r = await pollOnce({ fetchImpl, now: clock });
  assert.ok(r.summaryLines.find((l) => l.startsWith("imgw-meteo: ok 0 items, 7 events")), r.summaryLines.join("\n"));
  const led = await readLedger("imgw-meteo");
  assert.equal(led.filter((e) => e.ev === "disappeared").length, 7);
  assert.equal(led.filter((e) => e.ev === "schema_drift").length, 0);
  const hb = await readHeartbeat();
  assert.equal(hb.sources["imgw-meteo"].n_items, 0);
  assert.equal(hb.sources["imgw-meteo"].zero_since, clock());
  const st = await readState();
  assert.equal(st.sources["imgw-meteo"].schema.hash, schemaHashAfterTick1, "empty feed leaves the schema hash (and the ack) alone");
});

test("tick 4: warnings come back with the same hash — reappeared, no new item lines, zero_since cleared", async () => {
  tick = 4;
  const before = (await fs.readFile(path.join(root, "data", "items", "imgw-meteo", "2026-08.ndjson"), "utf8")).length;
  await pollOnce({ fetchImpl, now: clock });
  const led = await readLedger("imgw-meteo");
  assert.equal(led.filter((e) => e.ev === "reappeared").length, 7);
  let after = 0;
  try {
    after = (await fs.readFile(path.join(root, "data", "items", "imgw-meteo", "2026-09.ndjson"), "utf8")).length;
  } catch {}
  assert.equal(after, 0, "reappearance with an unchanged hash is not a new (id,hash) version");
  assert.equal(before > 0, true);
  const hb = await readHeartbeat();
  assert.equal(hb.sources["imgw-meteo"].zero_since, null);
});

test("tick 5: one source 503s — recorded as ok:false, others fine, tick does not fail", async () => {
  tick = 5;
  // 404 fails fast (no retry sleep); the retry path is covered in fetcher.test.js
  script["imgw-hydro"] = [{ status: 404, body: "gone" }];
  const r = await pollOnce({ fetchImpl, now: clock });
  assert.equal(r.anySuccess, true);
  const polls = await readPollLog("imgw-hydro");
  const last = polls.at(-1);
  assert.equal(last.ok, false);
  assert.equal(last.error, "HTTP 404");
  assert.equal(last.attempts, 1);
  const hb = await readHeartbeat();
  assert.equal(hb.sources["imgw-hydro"].consecutive_failures, 1);
});

test("tick 6+7: parse failure keeps ONE snapshot per distinct body", async () => {
  tick = 6;
  script["imgw-osmet"] = [{ status: 200, body: "<html>maintenance</html>" }];
  await pollOnce({ fetchImpl, now: clock });
  tick = 7;
  script["imgw-osmet"] = [{ status: 200, body: "<html>maintenance</html>" }];
  await pollOnce({ fetchImpl, now: clock });
  const polls = await readPollLog("imgw-osmet");
  const [p6, p7] = polls.slice(-2);
  assert.match(p6.error, /^parse: /);
  assert.ok(p6.snapshot, "first distinct broken body is snapshotted");
  assert.equal(p7.snapshot, null, "identical broken body is not snapshotted again");
  assert.equal(p6.body_hash, p7.body_hash);
});

test("tick 8: an exception in one source's processing does not abort the others", async () => {
  tick = 8;
  let n = 0;
  const flakyClock = () => {
    n += 1;
    if (n === 3) throw new Error("clock broke"); // heartbeat=1, source1 t=2, source2 t=3 -> throws inside source 2
    return clock();
  };
  const r = await pollOnce({ fetchImpl, now: flakyClock });
  assert.equal(r.anyException, true);
  assert.equal(r.anySuccess, true);
  assert.equal(r.summaryLines.filter((l) => l.includes(": ok ")).length, 4, r.summaryLines.join("\n"));
  const bad = r.summaryLines.find((l) => l.includes("EXCEPTION"));
  assert.match(bad, /clock broke/);
  const key = bad.split(":")[0];
  const polls = await readPollLog(key);
  assert.match(polls.at(-1).error, /^exception: /);
});

test("meteoalarm daily source: keyframe when new content arrives > 6 h after the last one", async () => {
  // last meteoalarm keyframe was tick 2 (2026-09-01T00:05Z). Jump 7 h with an added record.
  tick = 2 + 42; // +7 h
  const data = JSON.parse(FIXTURE["meteoalarm-json"]);
  const clone = JSON.parse(JSON.stringify(data.warnings[0]));
  clone.alert.identifier = clone.alert.identifier + ".TEST";
  data.warnings.push(clone);
  script["meteoalarm-json"] = [{ status: 200, body: JSON.stringify(data) }];
  await pollOnce({ fetchImpl, now: clock });
  const polls = await readPollLog("meteoalarm-json");
  assert.equal(polls.at(-1).events, 1);
  assert.ok(polls.at(-1).snapshot, "new record + last keyframe > 6 h old -> keyframe");
  // and a change 10 min later does NOT (same day, < 6 h)
  tick += 1;
  data.warnings.pop();
  script["meteoalarm-json"] = [{ status: 200, body: JSON.stringify(data) }];
  await pollOnce({ fetchImpl, now: clock });
  assert.equal((await readPollLog("meteoalarm-json")).at(-1).snapshot, null);
});
