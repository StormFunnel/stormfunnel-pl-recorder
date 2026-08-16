// IMGW danepubliczne timestamps are wall-clock Europe/Warsaw with no offset
// ("2026-08-15 13:00:00"). Everything the recorder writes is UTC ISO-8601.

const WARSAW = "Europe/Warsaw";
const dtf = new Intl.DateTimeFormat("en-US", {
  timeZone: WARSAW,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Offset (ms) of Europe/Warsaw from UTC at a given UTC instant. */
function warsawOffsetMs(utcMs) {
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

/**
 * "YYYY-MM-DD HH:mm[:ss]" (Warsaw wall clock) -> ISO UTC string, or null.
 * "9999-12-31 23:59:59" (IMGW's "open-ended") -> null.
 * Two-pass offset resolution handles the DST edges well enough for a recorder:
 * the ambiguous autumn hour (02:00-02:59 on the last Sunday of October) resolves
 * to the SECOND occurrence (CET, +01:00); the nonexistent spring hour maps
 * forward into the following hour. Both edges are pinned by test/time.test.js.
 */
export function warsawToUtcIso(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (y === "9999") return null;
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const guess = naive - warsawOffsetMs(naive);
  const utc = naive - warsawOffsetMs(guess);
  return new Date(utc).toISOString();
}

/** Any ISO string with offset (Meteoalarm, osmet Lx*) -> ISO UTC, or null. */
export function isoToUtcIso(text) {
  if (typeof text !== "string" || !text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function nowIso() {
  return new Date().toISOString();
}

/** Seconds between two ISO strings (b - a); null if either missing. */
export function diffSeconds(a, b) {
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isNaN(ms) ? null : Math.round(ms / 1000);
}
