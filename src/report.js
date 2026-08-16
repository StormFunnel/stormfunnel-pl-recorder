// Per-source stats from the observation ledger. Read-only; answers the ingest
// design questions from what the ledger already holds:
//   - ids ever seen / currently active / disappeared / reappeared
//   - mutation rate: % of concluded ids that changed content at least once
//   - cancel semantics: % of disappearances that had a Cancel msg_type or an
//     expired valid_to at disappearance vs SILENT (still valid, just gone)
//   - lifetime: median observed id lifetime (first_seen -> last_seen)
//   - latency: median (first_seen - published) — how stale the warning already
//     was when we first observed it (upper bound: poll interval + feed delay)
//   - blanket size: median/max areas per warning

import { SOURCES } from "./config.js";
import { readLedger, readPollLog, readState } from "./lib/store.js";
import { diffSeconds } from "./lib/time.js";

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const fmtDur = (s) => {
  if (s == null) return "n/a";
  if (Math.abs(s) < 90) return `${s}s`;
  if (Math.abs(s) < 5400) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");

const state = await readState();

for (const source of SOURCES) {
  const events = await readLedger(source.key);
  const s = state.sources?.[source.key];
  console.log(`\n=== ${source.key}`);
  if (!events.length) {
    console.log("  no ledger events yet");
    continue;
  }

  const ids = new Set();
  const appeared = events.filter((e) => e.ev === "appeared");
  const reappeared = events.filter((e) => e.ev === "reappeared");
  const changed = events.filter((e) => e.ev === "changed");
  const disappeared = events.filter((e) => e.ev === "disappeared");
  const drift = events.filter((e) => e.ev === "schema_drift");
  for (const e of events) if (e.id) ids.add(e.id);

  const changedIds = new Set(changed.map((e) => e.id));

  // Disappearance classification
  let viaCancel = 0;
  let viaExpiry = 0;
  let silent = 0;
  const lifetimes = [];
  for (const e of disappeared) {
    lifetimes.push(diffSeconds(e.first_seen, e.last_seen));
    if (String(e.msg_type ?? "").toLowerCase() === "cancel") viaCancel += 1;
    else if (e.valid_to && Date.parse(e.valid_to) <= Date.parse(e.t)) viaExpiry += 1;
    else silent += 1;
  }

  // Latency: only meaningful for ids whose published time we saw at appearance
  const latencies = appeared
    .filter((e) => !e.backfill)
    .map((e) => diffSeconds(e.summary?.published, e.t))
    .filter((v) => v != null && v >= 0);

  const areaCounts = appeared.map((e) => e.summary?.n_areas).filter((v) => typeof v === "number");

  console.log(`  ids ever seen:        ${ids.size}`);
  console.log(`  currently active:     ${s ? Object.keys(s.ledger.active).length : "?"}`);
  console.log(`  appeared/reappeared:  ${appeared.length}/${reappeared.length}`);
  console.log(`  content mutations:    ${changed.length} events, ${changedIds.size} ids (${pct(changedIds.size, ids.size)} of ids mutated)`);
  console.log(`  disappearances:       ${disappeared.length}  — cancel: ${viaCancel}, expired: ${viaExpiry}, SILENT: ${silent} (${pct(silent, disappeared.length)})`);
  console.log(`  median id lifetime:   ${fmtDur(median(lifetimes))} (n=${lifetimes.length}, concluded ids only)`);
  console.log(`  first-seen latency:   median ${fmtDur(median(latencies))}, max ${fmtDur(latencies.length ? Math.max(...latencies) : null)} (n=${latencies.length}, backfill excluded; upper-bounded by poll interval)`);
  console.log(`  areas per warning:    median ${median(areaCounts) ?? "n/a"}, max ${areaCounts.length ? Math.max(...areaCounts) : "n/a"}`);
  console.log(`  schema drift events:  ${drift.length}`);

  // Poll cadence and reliability from the poll log (GH cron drift shows up here)
  const polls = await readPollLog(source.key);
  if (polls.length) {
    const ok = polls.filter((p) => p.ok);
    const gaps = [];
    for (let i = 1; i < polls.length; i += 1) gaps.push(diffSeconds(polls[i - 1].t, polls[i].t));
    const changedPolls = ok.filter((p) => p.changed).length;
    const lat = ok.map((p) => p.ms).filter((v) => typeof v === "number");
    console.log(`  polls:                ${polls.length} (${pct(ok.length, polls.length)} ok), feed changed on ${changedPolls} (${pct(changedPolls, ok.length)} of ok polls)`);
    console.log(`  poll gap:             median ${fmtDur(median(gaps))}, p90 ${fmtDur(percentile(gaps, 0.9))}, max ${fmtDur(gaps.length ? Math.max(...gaps) : null)}`);
    console.log(`  fetch time:           median ${median(lat) ?? "n/a"} ms, max ${lat.length ? Math.max(...lat) : "n/a"} ms`);
  }
}

// Cross-source: how much later does Meteoalarm carry an IMGW warning?
// Join on imgw_id embedded in CAP identifiers vs imgw-meteo ids.
const meteoLedger = await readLedger("imgw-meteo");
const maLedger = await readLedger("meteoalarm-json");
const firstSeen = new Map();
for (const e of meteoLedger) {
  if (e.ev === "appeared" && !e.backfill && e.id && !firstSeen.has(e.id)) firstSeen.set(e.id, e.t);
}
const deltas = [];
const seenPairs = new Set();
for (const e of maLedger) {
  if (e.ev !== "appeared" || e.backfill) continue;
  const imgwId = e.summary?.imgw_id;
  if (!imgwId || seenPairs.has(imgwId) || !firstSeen.has(imgwId)) continue;
  seenPairs.add(imgwId);
  deltas.push(diffSeconds(firstSeen.get(imgwId), e.t));
}
if (deltas.length) {
  console.log(`\n=== cross-source (imgw-meteo -> meteoalarm-json, joined on embedded IMGW id)`);
  console.log(`  pairs: ${deltas.length}, median observed delta ${fmtDur(median(deltas))} (negative = Meteoalarm first; resolution = poll interval)`);
} else {
  console.log(`\n=== cross-source: no joinable pairs yet`);
}
