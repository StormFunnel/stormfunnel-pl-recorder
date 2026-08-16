// Health gate — run AFTER poll in the workflow. Exits 1 (fails the workflow,
// which makes GitHub email the repo owner) when:
//   - any source has had no successful poll for > STALE_AFTER_MS (2 h), or
//   - a schema drift event was recorded since the last acknowledged hash.
//
// Anti-spam: an alarm that already fired keeps the workflow failing, but the
// point is the FIRST email; GitHub only notifies on the first failure of a
// series by default, which is exactly the behavior we want. Re-notification
// beyond that is RENOTIFY_AFTER_MS's problem only if we later add a custom
// notifier.

import { RENOTIFY_AFTER_MS, SOURCES, STALE_AFTER_MS } from "./config.js";
import { readHeartbeat, readState } from "./lib/store.js";
import { nowIso } from "./lib/time.js";

const now = Date.now();
const heartbeat = await readHeartbeat();
const state = await readState();
const problems = [];

if (!heartbeat) {
  problems.push("no heartbeat.json — poll has never completed");
} else {
  for (const source of SOURCES) {
    const hb = heartbeat.sources?.[source.key];
    if (!hb || !hb.last_success) {
      problems.push(`${source.key}: never succeeded`);
      continue;
    }
    const age = now - Date.parse(hb.last_success);
    if (age > STALE_AFTER_MS) {
      const hours = (age / 3_600_000).toFixed(1);
      problems.push(
        `${source.key}: last successful poll ${hours}h ago (${hb.last_success}), ${hb.consecutive_failures} consecutive failures`,
      );
    }
  }
}

// Schema drift: alarm until a human acknowledges by writing the new hash into
// state/acknowledged-schemas.json (see RUNBOOK).
import { promises as fs } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
const ackedPath = path.join(ROOT, "state", "acknowledged-schemas.json");
let acked = {};
try {
  acked = JSON.parse(await fs.readFile(ackedPath, "utf8"));
} catch {
  acked = {};
}
let ackedDirty = false;
for (const source of SOURCES) {
  const s = state.sources?.[source.key];
  if (!s?.schema?.hash) continue;
  const known = acked[source.key];
  if (!known) {
    // First observation is the baseline — auto-acknowledge so the drift alarm
    // needs zero manual setup and fires only on CHANGE.
    acked[source.key] = s.schema.hash;
    ackedDirty = true;
  } else if (known !== s.schema.hash) {
    problems.push(
      `${source.key}: SCHEMA DRIFT — envelope hash ${s.schema.hash.slice(0, 12)} != acknowledged ${String(known).slice(0, 12)}. Inspect ledger/${source.key}.ndjson for the schema_drift event, then update state/acknowledged-schemas.json.`,
    );
  }
}
if (ackedDirty) {
  await fs.mkdir(path.dirname(ackedPath), { recursive: true });
  await fs.writeFile(ackedPath, JSON.stringify(acked, null, 1) + "\n", "utf8");
}

if (problems.length) {
  console.error(`HEALTH CHECK FAILED at ${nowIso()}  (renotify window ${RENOTIFY_AFTER_MS / 3_600_000}h)`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("health: all sources fresh, no unacknowledged schema drift");
