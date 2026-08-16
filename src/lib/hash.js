import { createHash } from "node:crypto";

/** Canonical JSON: keys sorted recursively, no whitespace. Arrays keep order. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Hash of one item's canonical JSON — the "content hash" of a warning version. */
export function itemHash(item) {
  return sha256(canonicalJson(item));
}

/**
 * Order-independent hash of a whole feed: sha256 over the sorted list of
 * "id:hash" pairs. Two polls whose item sets are identical hash identically
 * regardless of item order or of feed-level noise (Atom <updated>).
 */
export function feedHash(items) {
  const pairs = items.map((it) => `${it.id}:${it.hash}`).sort();
  return sha256(pairs.join("\n"));
}
