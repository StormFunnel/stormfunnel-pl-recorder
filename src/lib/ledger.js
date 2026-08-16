// The observation ledger — the derived record that makes the analysis
// questions answerable without reparsing raw snapshots.
//
// updateLedger is PURE: (previous per-source state, parsed items, poll time)
// -> { state, events }. The caller persists state and appends events.
//
// Event vocabulary (one NDJSON line each):
//   appeared     id seen for the first time ever
//   reappeared   id seen again after having disappeared (flap / re-listing)
//   changed      same id, different content hash (mutation in place)
//   disappeared  id present last poll, absent this poll
//
// Disappearance classification happens at report time, not here: for
// meteoalarm sources a Cancel message referencing the id may arrive in the
// SAME source or the sibling source, and the ledger of one source cannot see
// the other. The event carries everything needed to classify later
// (last summary incl. valid_to, msg_type).
//
// STATE MUST NOT CHANGE ON AN UNCHANGED POLL. The state file is committed
// every tick; a per-id `last_seen` would touch every entry 144x/day and turn
// a 1 MB JSON into ~10 MB/day of git deltas. So an active id carries no
// last_seen — it is implied by `last_poll_t` (an active id was seen at the
// last successful poll), and is materialized only on the disappearance event.

import { canonicalJson, sha256 } from "./hash.js";

/** Per-top-level-key short hashes of the normalized item — lets a "changed"
 *  event name WHICH fields moved without storing the item itself. */
export function keyHashes(norm) {
  if (!norm || typeof norm !== "object") return {};
  const out = {};
  for (const k of Object.keys(norm).sort()) out[k] = sha256(canonicalJson(norm[k])).slice(0, 12);
  return out;
}

export function changedKeys(prevHashes = {}, nextHashes = {}) {
  const keys = new Set([...Object.keys(prevHashes), ...Object.keys(nextHashes)]);
  return [...keys].filter((k) => prevHashes[k] !== nextHashes[k]).sort();
}

export function emptySourceState() {
  return { active: {}, gone: {}, last_poll_t: null };
}

/**
 * @param {object} state     per-source state from emptySourceState()
 * @param {Array}  items     parsed items [{id, hash, summary}]
 * @param {string} nowIso    poll timestamp (actual, not scheduled)
 * @param {object} opts      { goneRetentionMs }
 */
export function updateLedger(state, items, nowIso, opts = {}) {
  const goneRetentionMs = opts.goneRetentionMs ?? 14 * 24 * 60 * 60 * 1000;
  const events = [];
  const next = {
    active: { ...state.active },
    gone: { ...state.gone },
    last_poll_t: nowIso,
  };
  const prevPollT = state.last_poll_t ?? null;
  // First poll ever for this source: everything "appears" at once, but those
  // warnings pre-date the recorder. Flag them so latency stats can skip them.
  const backfill = prevPollT === null;
  const seenNow = new Set();

  for (const item of items) {
    if (seenNow.has(item.id)) continue; // duplicate id within one poll: first wins
    seenNow.add(item.id);
    const prev = next.active[item.id];
    if (!prev) {
      const past = next.gone[item.id];
      const ev = past ? "reappeared" : "appeared";
      events.push({
        t: nowIso,
        ev,
        id: item.id,
        hash: item.hash,
        ...(past ? { gone_at: past.gone_at, prev_hash: past.hash } : {}),
        ...(backfill ? { backfill: true } : {}),
        summary: item.summary,
      });
      next.active[item.id] = {
        first_seen: past?.first_seen ?? nowIso,
        hash: item.hash,
        key_hashes: keyHashes(item.norm),
        changes: past?.changes ?? 0,
        published: item.summary?.published ?? null,
        valid_to: item.summary?.valid_to ?? null,
        msg_type: item.summary?.msg_type ?? null,
        event: item.summary?.event ?? null,
        level: item.summary?.level ?? null,
        n_areas: item.summary?.n_areas ?? null,
      };
      delete next.gone[item.id];
    } else if (prev.hash !== item.hash) {
      const kh = keyHashes(item.norm);
      events.push({
        t: nowIso,
        ev: "changed",
        id: item.id,
        hash: item.hash,
        prev_hash: prev.hash,
        changed_keys: changedKeys(prev.key_hashes, kh),
        summary: item.summary,
      });
      next.active[item.id] = {
        ...prev,
        hash: item.hash,
        key_hashes: kh,
        changes: (prev.changes ?? 0) + 1,
        valid_to: item.summary?.valid_to ?? prev.valid_to,
        msg_type: item.summary?.msg_type ?? prev.msg_type,
        level: item.summary?.level ?? prev.level,
        n_areas: item.summary?.n_areas ?? prev.n_areas,
      };
    }
    // unchanged: no state write at all (see header)
  }

  for (const [id, prev] of Object.entries(state.active)) {
    if (seenNow.has(id)) continue;
    const lastSeen = prevPollT ?? prev.first_seen;
    events.push({
      t: nowIso,
      ev: "disappeared",
      id,
      hash: prev.hash,
      first_seen: prev.first_seen,
      last_seen: lastSeen,
      changes: prev.changes ?? 0,
      published: prev.published ?? null,
      valid_to: prev.valid_to ?? null,
      msg_type: prev.msg_type ?? null,
      event: prev.event ?? null,
      level: prev.level ?? null,
      n_areas: prev.n_areas ?? null,
    });
    next.gone[id] = { ...prev, last_seen: lastSeen, gone_at: nowIso };
    delete next.active[id];
  }

  // prune the gone map so state stays bounded
  const cutoff = Date.parse(nowIso) - goneRetentionMs;
  for (const [id, g] of Object.entries(next.gone)) {
    if (Date.parse(g.gone_at) < cutoff) delete next.gone[id];
  }

  return { state: next, events };
}
