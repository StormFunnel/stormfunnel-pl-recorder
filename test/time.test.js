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
