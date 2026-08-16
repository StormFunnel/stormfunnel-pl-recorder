// One poll tick across all sources. Safe to run any time, any number of times:
// every write is append-only or an atomic state replace. Exit code 0 even when
// some sources fail (check.js owns alarming); exit 1 only when NOTHING could
// be recorded at all (broken repo, disk error).

import { GONE_RETENTION_MS, SOURCES } from "./config.js";
import { fetchSource } from "./lib/fetcher.js";
import { parseSource } from "./lib/parsers.js";
import { feedHash } from "./lib/hash.js";
import { updateLedger, emptySourceState } from "./lib/ledger.js";
import { detectDrift } from "./lib/drift.js";
import { nowIso } from "./lib/time.js";
import {
  appendItems,
  appendLedgerEvents,
  appendPollLine,
  readState,
  writeHeartbeat,
  writeSnapshot,
  writeState,
} from "./lib/store.js";

// GH Actions cron is best-effort: a "*/10" schedule fires late (minutes) under
// load and GitHub does not expose the intended slot. We record the ACTUAL time
// plus run provenance; report.js derives cadence/drift from the gaps.
const provenance = {
  run_id: process.env.GITHUB_RUN_ID || null,
  trigger: process.env.GITHUB_EVENT_NAME || (process.env.CI ? "ci" : "local"),
};

export async function pollOnce() {
  const state = await readState();
  state.sources ??= {};
  const heartbeat = { updated: nowIso(), sources: {} };
  const summaryLines = [];
  let anySuccess = false;

  for (const source of SOURCES) {
    const t = nowIso();
    const s = (state.sources[source.key] ??= {
      ledger: emptySourceState(),
      last_feed_hash: null,
      schema: null,
      last_success: null,
      consecutive_failures: 0,
    });

    const fetched = await fetchSource(source);
    if (!fetched.ok) {
      s.consecutive_failures = (s.consecutive_failures ?? 0) + 1;
      await appendPollLine(source.key, {
        t,
        ...provenance,
        ok: false,
        status: fetched.status,
        error: fetched.error,
        ms: fetched.ms,
        attempts: fetched.attempts,
      });
      summaryLines.push(`${source.key}: FAIL ${fetched.error} (${fetched.attempts} attempts)`);
      continue;
    }

    let parsed;
    try {
      parsed = parseSource(source.key, fetched.body);
    } catch (err) {
      // A 200 that does not parse is a schema break, not a network blip.
      s.consecutive_failures = (s.consecutive_failures ?? 0) + 1;
      const snapshot = await writeSnapshot(source.key, fetched.body, t).catch(() => null);
      await appendPollLine(source.key, {
        t,
        ...provenance,
        ok: false,
        status: fetched.status,
        error: `parse: ${err.message}`,
        ms: fetched.ms,
        snapshot,
      });
      summaryLines.push(`${source.key}: PARSE FAIL ${err.message} (snapshot kept)`);
      continue;
    }

    const fh = feedHash(parsed.items);
    const changed = fh !== s.last_feed_hash;

    const drift = detectDrift(s.schema, parsed.envelope);
    s.schema = drift.record;

    // Snapshot policy (config.js): on-change, or daily keyframe; drift always.
    let snapshot = null;
    const day = t.slice(0, 10);
    const wantSnapshot =
      drift.drifted ||
      (changed && (source.snapshot === "on-change" || s.last_snapshot_day !== day));
    if (wantSnapshot) {
      snapshot = await writeSnapshot(source.key, fetched.body, t);
      s.last_snapshot_day = day;
    }

    const { state: nextLedger, events } = updateLedger(s.ledger, parsed.items, t, {
      goneRetentionMs: GONE_RETENTION_MS,
    });
    s.ledger = nextLedger;
    await appendLedgerEvents(source.key, events);
    if (drift.drifted) {
      await appendLedgerEvents(source.key, [
        { t, ev: "schema_drift", id: null, diff: drift.diff, new_hash: drift.record.hash },
      ]);
    }

    if (source.items) {
      const fresh = new Set(
        events.filter((e) => e.ev === "appeared" || e.ev === "reappeared" || e.ev === "changed").map((e) => e.id),
      );
      const byId = new Map(parsed.items.map((i) => [i.id, i]));
      const lines = [...fresh].map((id) => {
        const it = byId.get(id);
        return { t, id, hash: it.hash, item: it.norm };
      });
      await appendItems(source.key, lines);
    }

    s.last_feed_hash = fh;
    s.last_success = t;
    s.consecutive_failures = 0;

    await appendPollLine(source.key, {
      t,
      ...provenance,
      ok: true,
      status: fetched.status,
      ms: fetched.ms,
      attempts: fetched.attempts,
      bytes: Buffer.byteLength(fetched.body, "utf8"),
      n_items: parsed.items.length,
      malformed: parsed.malformed,
      feed_hash: fh,
      changed,
      snapshot,
      events: events.length,
      drift: drift.drifted || undefined,
    });

    anySuccess = true;
    summaryLines.push(
      `${source.key}: ok ${parsed.items.length} items, ${events.length} events${changed ? ", snapshot" : ", unchanged"}${drift.drifted ? ", SCHEMA DRIFT" : ""}`,
    );
  }

  for (const source of SOURCES) {
    const s = state.sources[source.key];
    heartbeat.sources[source.key] = {
      last_success: s?.last_success ?? null,
      consecutive_failures: s?.consecutive_failures ?? 0,
      active_ids: s ? Object.keys(s.ledger.active).length : 0,
      schema_hash: s?.schema?.hash ?? null,
    };
  }

  await writeState(state);
  await writeHeartbeat(heartbeat);
  return { anySuccess, summaryLines };
}

const { anySuccess, summaryLines } = await pollOnce();
for (const line of summaryLines) console.log(line);
if (!anySuccess) {
  console.error("poll: every source failed this tick");
  process.exitCode = 1;
}
