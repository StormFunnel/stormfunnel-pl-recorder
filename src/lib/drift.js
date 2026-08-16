// Schema-drift detection: the envelope (top-level shape + union of item keys)
// of each source is canonicalized and hashed. A hash change means the feed's
// shape moved under us — worth an alarm even when polling still "works",
// because parsers silently dropping a renamed field is the failure mode that
// costs a month of data.

import { canonicalJson, sha256 } from "./hash.js";

export function envelopeHash(envelope) {
  return sha256(canonicalJson(envelope));
}

/**
 * PURE. prev: { hash, envelope } | undefined. Returns
 * { drifted, record } where record is the new stored value.
 */
export function detectDrift(prev, envelope) {
  const hash = envelopeHash(envelope);
  if (!prev) return { drifted: false, first: true, record: { hash, envelope } };
  if (prev.hash === hash) return { drifted: false, first: false, record: prev };
  return {
    drifted: true,
    first: false,
    record: { hash, envelope },
    diff: diffEnvelopes(prev.envelope, envelope),
  };
}

/** Human-readable added/removed keys per envelope field. */
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
