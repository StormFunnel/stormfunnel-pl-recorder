// Health gate — run AFTER poll in the workflow. Rules and dedupe live in
// lib/health.js. Exit 1 (fails the workflow -> GitHub emails the workflow's
// actor) only when a problem is NEW or was last notified more than
// RENOTIFY_AFTER_MS ago; a problem that is still present but already notified
// is a ::warning:: annotation on a green run. state/alarms.json carries the
// dedupe map and is committed with the tick (check.js runs before `git add`).

import {
  RENOTIFY_AFTER_MS,
  SIBLINGS,
  SOURCES,
  STALE_AFTER_MS,
  ZERO_ITEMS_AFTER_MS,
} from "./config.js";
import { evaluateHealth } from "./lib/health.js";
import { readAcked, readAlarms, readHeartbeat, readState, writeAcked, writeAlarms } from "./lib/store.js";
import { nowIso } from "./lib/time.js";

const result = evaluateHealth({
  now: Date.now(),
  heartbeat: await readHeartbeat(),
  state: await readState(),
  acked: await readAcked(),
  alarms: await readAlarms(),
  sources: SOURCES,
  siblings: SIBLINGS,
  staleAfterMs: STALE_AFTER_MS,
  renotifyAfterMs: RENOTIFY_AFTER_MS,
  zeroItemsAfterMs: ZERO_ITEMS_AFTER_MS,
  pollOutcome: process.env.RECORDER_POLL_OUTCOME || null,
});

if (result.ackedDirty) await writeAcked(result.acked);
await writeAlarms(result.alarms);

const inActions = Boolean(process.env.GITHUB_ACTIONS);
for (const k of result.recovered) console.log(`health: recovered ${k}`);
for (const p of result.suppressed) {
  const a = result.alarms[p.key];
  const line = `${p.message} [known since ${a.first_failed_at}, last notified ${a.last_notified_at}]`;
  console.log(inActions ? `::warning::${line}` : `WARNING (suppressed): ${line}`);
}
if (result.exitCode) {
  console.error(`HEALTH CHECK FAILED at ${nowIso()}  (renotify window ${RENOTIFY_AFTER_MS / 3_600_000}h)`);
  for (const p of result.notify) console.error("  - " + p.message);
  process.exit(1);
}
console.log(
  result.problems.length
    ? `health: ${result.problems.length} known problem(s), all already notified — not re-failing`
    : "health: all sources fresh, no unacknowledged schema drift",
);
