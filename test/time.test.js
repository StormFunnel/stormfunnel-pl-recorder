import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSeconds, isoToUtcIso, warsawToUtcIso } from "../src/lib/time.js";

test("summer (CEST, +02:00)", () => {
  assert.equal(warsawToUtcIso("2026-08-15 13:00:00"), "2026-08-15T11:00:00.000Z");
});

test("winter (CET, +01:00)", () => {
  assert.equal(warsawToUtcIso("2026-01-15 13:00:00"), "2026-01-15T12:00:00.000Z");
});

test("open-ended and garbage map to null", () => {
  assert.equal(warsawToUtcIso("9999-12-31 23:59:59"), null);
  assert.equal(warsawToUtcIso("not a date"), null);
  assert.equal(warsawToUtcIso(null), null);
});

test("seconds optional", () => {
  assert.equal(warsawToUtcIso("2026-08-16 21:00"), "2026-08-16T19:00:00.000Z");
});

test("isoToUtcIso normalizes offsets", () => {
  assert.equal(isoToUtcIso("2026-08-15T12:02:34+02:00"), "2026-08-15T10:02:34.000Z");
  assert.equal(isoToUtcIso("bogus"), null);
});

test("diffSeconds", () => {
  assert.equal(diffSeconds("2026-08-15T10:00:00Z", "2026-08-15T10:05:00Z"), 300);
  assert.equal(diffSeconds(null, "2026-08-15T10:05:00Z"), null);
});

// DST edges inside the 6-month window. Europe/Warsaw: 2026-10-25 03:00 CEST -> 02:00 CET
// (02:00-02:59 happens twice), 2026-03-29 02:00 CET -> 03:00 CEST (02:00-02:59 does not exist).
test("autumn ambiguous hour resolves to the SECOND occurrence (CET, +01:00), neighbours exact", () => {
  assert.equal(warsawToUtcIso("2026-10-25 01:59:00"), "2026-10-24T23:59:00.000Z");
  assert.equal(warsawToUtcIso("2026-10-25 02:30:00"), "2026-10-25T01:30:00.000Z");
  assert.equal(warsawToUtcIso("2026-10-25 03:00:00"), "2026-10-25T02:00:00.000Z");
  assert.equal(warsawToUtcIso("2026-10-25 04:00:00"), "2026-10-25T03:00:00.000Z");
});

test("spring nonexistent hour maps forward without throwing, neighbours are exact", () => {
  assert.equal(warsawToUtcIso("2026-03-29 01:59:00"), "2026-03-29T00:59:00.000Z");
  assert.equal(warsawToUtcIso("2026-03-29 03:00:00"), "2026-03-29T01:00:00.000Z");
  const gap = warsawToUtcIso("2026-03-29 02:30:00");
  assert.ok(gap, "must return a value");
  const ms = Date.parse(gap);
  assert.ok(ms >= Date.parse("2026-03-29T00:30:00Z") && ms <= Date.parse("2026-03-29T01:30:00Z"), `got ${gap}`);
});
