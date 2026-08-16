// Schema-drift detection.
//
// The envelope of a source is { top: <top-level shape>, <field>: [item keys]... }
// (see parsers.js). Naively hashing the current envelope alarms on NORMAL feed
// states: an empty feed has item_keys [] (calm day = red run every tick), and
// optional per-record keys (Meteoalarm `references` only on Update records)
// come and go with the traffic, so the hash oscillates and can never be acked.
//
// So the alarmed value is a MONOTONE union of everything ever seen:
//   record = { hash, seen, last }
//   seen   per field: `top` = last observed top shape; item-key fields = union
//          of every key ever observed (only grows)
//   last   the envelope as observed on the most recent poll with items
//   hash   sha256(canonical(seen)) — what check.js compares to the ack file
//
// drifted (alarm) fires only when
//   - the top-level shape changes (`top`), or a whole envelope field appears/vanishes, or
//   - a NEVER-SEEN item key appears (union grows).
// Item-key fields are ignored entirely when n_items === 0 (nothing to learn
// from an empty feed). Keys that are absent this poll but were present on the
// last non-empty poll are reported in `removed` (informational: caller writes
// a non-alarming ledger event) — the union keeps them, so the hash is stable.

import { canonicalJson, sha256 } from "./hash.js";

export const TOP_FIELD = "top";

export function envelopeHash(envelope) {
  return sha256(canonicalJson(envelope));
}

/**
 * PURE. prev: { hash, seen, last } | legacy { hash, envelope } | undefined.
 * @param {object} envelope  envelope from the parser
 * @param {{nItems?: number}} opts  number of parsed items this poll
 * @returns {{drifted:boolean, first:boolean, record:object, diff?:object, removed?:object}}
 */
export function detectDrift(prev, envelope, opts = {}) {
  const nItems = opts.nItems ?? null;
  const empty = nItems === 0;
  const cur = envelope ?? {};

  if (!prev) {
    // First observation is the baseline. An empty first poll still records the
    // (empty) item-key fields so the field set is known.
    const seen = cloneEnvelope(cur);
    return { drifted: false, first: true, record: { hash: envelopeHash(seen), seen, last: cloneEnvelope(cur) } };
  }

  const prevSeen = prev.seen ?? prev.envelope ?? {};
  const prevLast = prev.last ?? prev.envelope ?? {};
  const seen = cloneEnvelope(prevSeen);
  const last = cloneEnvelope(prevLast);
  const diff = {};
  const removed = {};

  const fields = new Set([...Object.keys(prevSeen), ...Object.keys(cur)]);
  for (const f of fields) {
    const inPrev = f in prevSeen;
    const inCur = f in cur;
    if (f === TOP_FIELD || !Array.isArray(cur[f] ?? prevSeen[f])) {
      // top-level shape / scalar field: exact comparison, always
      if (!inCur || !inPrev || canonicalJson(cur[f]) !== canonicalJson(prevSeen[f])) {
        diff[f] = {
          added: inCur ? [canonicalJson(cur[f])] : [],
          removed: inPrev ? [canonicalJson(prevSeen[f])] : [],
        };
        if (inCur) seen[f] = cloneValue(cur[f]);
        else delete seen[f];
      }
      if (inCur) last[f] = cloneValue(cur[f]);
      else delete last[f];
      continue;
    }
    // item-key field
    if (empty) continue; // nothing to learn from an empty feed
    if (!inCur) {
      diff[f] = { added: [], removed: [...toSet(prevSeen[f])] };
      delete seen[f];
      delete last[f];
      continue;
    }
    if (!inPrev) {
      diff[f] = { added: [...toSet(cur[f])], removed: [] };
      seen[f] = [...toSet(cur[f])].sort();
      last[f] = cloneValue(cur[f]);
      continue;
    }
    const seenSet = toSet(prevSeen[f]);
    const curSet = toSet(cur[f]);
    const lastSet = toSet(prevLast[f]);
    const added = [...curSet].filter((k) => !seenSet.has(k));
    if (added.length) {
      diff[f] = { added, removed: [] };
      seen[f] = [...new Set([...seenSet, ...curSet])].sort();
    }
    const gone = [...lastSet].filter((k) => !curSet.has(k));
    if (gone.length) removed[f] = gone;
    last[f] = cloneValue(cur[f]);
  }

  const drifted = Object.keys(diff).length > 0;
  const hash = drifted ? envelopeHash(seen) : prev.hash ?? envelopeHash(seen);
  const record = { hash, seen, last };
  const out = { drifted, first: false, record };
  if (drifted) out.diff = diff;
  if (Object.keys(removed).length) out.removed = removed;
  return out;
}

/** Human-readable added/removed keys per envelope field (plain set diff). */
export function diffEnvelopes(a, b) {
  const out = {};
  const fields = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const f of fields) {
    const av = toSet(a?.[f]);
    const bv = toSet(b?.[f]);
    const added = [...bv].filter((k) => !av.has(k));
    const removed = [...av].filter((k) => !bv.has(k));
    if (added.length || removed.length) out[f] = { added, removed };
  }
  return out;
}

function toSet(v) {
  if (Array.isArray(v)) return new Set(v.map(String));
  if (v == null) return new Set();
  return new Set([JSON.stringify(v)]);
}

function cloneValue(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function cloneEnvelope(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = Array.isArray(v) ? [...v.map(String)].sort() : cloneValue(v);
  return out;
}
