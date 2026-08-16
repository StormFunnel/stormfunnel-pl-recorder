// One poll tick across all sources. Safe to run any time, any number of times:
// every write is append-only or an atomic state replace. Exit code is 0 for
// upstream trouble of any kind (fetch, parse, even an exception inside one
// source's processing) — check.js owns alarming via the staleness rule; a red
// run here would fire on every network blip and be impossible to dedupe.
// A non-zero exit means the tick itself could not run (broken repo, disk error).

import { pathToFileURL } from "node:url";
import { GONE_RETENTION_MS, KEYFRAME_MIN_GAP_MS, SOURCES } from "./config.js";
import { fetchSource } from "./lib/fetcher.js";
import { parseSource } from "./lib/parsers.js";
import { feedHash, sha256 } from "./lib/hash.js";
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

function freshSourceState() {
  return {
    ledger: emptySourceState(),
    last_feed_hash: null,
    schema: null,
    last_success: null,
    consecutive_failures: 0,
  };
}

/** One source, one tick. Mutates `s` (per-source state); returns a summary line. */
async function pollSource(source, s, { fetchImpl, now }) {
  const t = now();
  const fetched = await fetchSource(source, fetchImpl ? { fetchImpl } : {});
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
      hdr: fetched.headers && Object.keys(fetched.headers).length ? fetched.headers : undefined,
    });
    return `${source.key}: FAIL ${fetched.error} (${fetched.attempts} attempts)`;
  }

  let parsed;
  try {
    parsed = parseSource(source.key, fetched.body);
  } catch (err) {
    // A 200 that does not parse is a schema break, not a network blip. Keep the
    // body once per distinct body (a broken feed repeats identically every tick).
    s.consecutive_failures = (s.consecutive_failures ?? 0) + 1;
    const bodyHash = sha256(fetched.body);
    let snapshot = null;
    if (s.last_fail_body_hash !== bodyHash) {
      snapshot = await writeSnapshot(source.key, fetched.body, t).catch(() => null);
      s.last_fail_body_hash = bodyHash;
    }
    await appendPollLine(source.key, {
      t,
      ...provenance,
      ok: false,
      status: fetched.status,
      error: `parse: ${err.message}`,
      ms: fetched.ms,
      attempts: fetched.attempts,
      bytes: Buffer.byteLength(fetched.body, "utf8"),
      body_hash: bodyHash.slice(0, 16),
      snapshot,
      hdr: fetched.headers,
    });
    return `${source.key}: PARSE FAIL ${err.message} (${snapshot ? "snapshot kept" : "same body as before"})`;
  }
  s.last_fail_body_hash = null;

  const fh = feedHash(parsed.items);
  const changed = fh !== s.last_feed_hash;

  const drift = detectDrift(s.schema, parsed.envelope, { nItems: parsed.items.length });
  s.schema = drift.record;

  const { state: nextLedger, events } = updateLedger(s.ledger, parsed.items, t, {
    goneRetentionMs: GONE_RETENTION_MS,
  });
  s.ledger = nextLedger;
  const newContent = events.some((e) => e.ev === "appeared" || e.ev === "changed" || e.ev === "reappeared");

  // Snapshot policy (config.js): on-change; or daily keyframe + a keyframe when
  // new content arrived and the last one is > KEYFRAME_MIN_GAP_MS old; drift always.
  let snapshot = null;
  const day = t.slice(0, 10);
  const sinceLast = s.last_snapshot_t ? Date.parse(t) - Date.parse(s.last_snapshot_t) : Infinity;
  const wantSnapshot =
    drift.drifted ||
    (source.snapshot === "on-change" && changed) ||
    (source.snapshot === "daily" && (s.last_snapshot_day !== day || (newContent && sinceLast > KEYFRAME_MIN_GAP_MS)));
  if (wantSnapshot) {
    snapshot = await writeSnapshot(source.key, fetched.body, t);
    s.last_snapshot_day = day;
    s.last_snapshot_t = t;
  }

  await appendLedgerEvents(source.key, events);
  if (drift.drifted) {
    await appendLedgerEvents(source.key, [
      { t, ev: "schema_drift", id: null, alarm: true, diff: drift.diff, new_hash: drift.record.hash },
    ]);
  } else if (drift.removed) {
    // Keys present on the last non-empty poll but absent now. Informational:
    // optional keys (Meteoalarm `references`) come and go with the traffic.
    await appendLedgerEvents(source.key, [
      { t, ev: "schema_drift", id: null, alarm: false, removed: drift.removed, hash: drift.record.hash },
    ]);
  }

  if (source.items) {
    // every NEW (id, hash) version — a reappearance with the same hash is not new
    const fresh = new Map();
    for (const e of events) {
      if (e.ev === "appeared" || e.ev === "changed") fresh.set(e.id, true);
      else if (e.ev === "reappeared" && e.hash !== e.prev_hash) fresh.set(e.id, true);
    }
    const byId = new Map(parsed.items.map((i) => [i.id, i]));
    const lines = [...fresh.keys()].map((id) => {
      const it = byId.get(id);
      return { t, id, hash: it.hash, item: it.norm };
    });
    await appendItems(source.key, lines);
  }

  s.last_feed_hash = fh;
  s.last_success = t;
  s.consecutive_failures = 0;
  s.n_items = parsed.items.length;
  s.zero_since = parsed.items.length === 0 ? (s.zero_since ?? t) : null;

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
    hdr: fetched.headers,
    meta: parsed.meta,
  });

  return `${source.key}: ok ${parsed.items.length} items, ${events.length} events${changed ? ", changed" : ", unchanged"}${snapshot ? ", snapshot" : ""}${drift.drifted ? ", SCHEMA DRIFT" : ""}`;
}

/**
 * @param {{fetchImpl?: Function, now?: () => string, sources?: Array}} opts  test seams
 */
export async function pollOnce(opts = {}) {
  const sources = opts.sources ?? SOURCES;
  const now = opts.now ?? nowIso;
  const state = await readState();
  state.sources ??= {};
  const heartbeat = { updated: now(), sources: {} };
  const summaryLines = [];
  let anySuccess = false;
  let anyException = false;

  for (const source of sources) {
    const s = (state.sources[source.key] ??= freshSourceState());
    try {
      const line = await pollSource(source, s, { fetchImpl: opts.fetchImpl, now });
      if (line.includes(": ok ")) anySuccess = true;
      summaryLines.push(line);
    } catch (err) {
      // One source's exception (parser TypeError on an unexpected shape, disk
      // error on its files) must not abort the tick for the other four.
      anyException = true;
      s.consecutive_failures = (s.consecutive_failures ?? 0) + 1;
      const t = now();
      await appendPollLine(source.key, {
        t,
        ...provenance,
        ok: false,
        status: null,
        error: `exception: ${err?.stack ?? err}`.slice(0, 2000),
      }).catch(() => {});
      summaryLines.push(`${source.key}: EXCEPTION ${err?.message ?? err}`);
    }
  }

  for (const source of sources) {
    const s = state.sources[source.key];
    heartbeat.sources[source.key] = {
      last_success: s?.last_success ?? null,
      consecutive_failures: s?.consecutive_failures ?? 0,
      active_ids: s ? Object.keys(s.ledger.active).length : 0,
      n_items: s?.n_items ?? null,
      zero_since: s?.zero_since ?? null,
      schema_hash: s?.schema?.hash ?? null,
    };
  }

  await writeState(state);
  await writeHeartbeat(heartbeat);
  return { anySuccess, anyException, summaryLines };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { anySuccess, anyException, summaryLines } = await pollOnce();
  for (const line of summaryLines) console.log(line);
  if (!anySuccess) console.error("poll: every source failed this tick (not fatal — the 2 h staleness rule decides)");
  if (anyException) console.error("poll: at least one source threw — see the poll log lines with error \"exception: ...\"");
}
