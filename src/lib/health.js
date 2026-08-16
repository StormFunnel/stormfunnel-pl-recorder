// Health rules + alarm dedupe. PURE: check.js feeds it the files, it returns
// what to write back and the exit code. Testable without a filesystem.
//
// Rules (a "problem" is keyed so it can be deduped across ticks):
//   heartbeat:missing        poll has never completed
//   <src>:never              source has no successful poll at all
//   <src>:stale              no successful poll for > staleAfterMs
//   <src>:drift:<hash12>     schema envelope hash != acknowledged hash
//   <src>:zero-items         source has served 0 items for > zeroItemsAfterMs while
//                            its sibling (config SIBLINGS) serves > 0 — a silent
//                            parser break looks exactly like a calm day otherwise
//   poll:crashed             the poll step itself threw (env from the workflow)
//
// Dedupe: alarms = { key: { first_failed_at, last_notified_at, message } }.
// A problem NOTIFIES (exit 1 -> red run -> GitHub email) only when it is new
// or its last notification is older than renotifyAfterMs; otherwise it is a
// ::warning:: annotation on a green run. Problems that cleared are dropped
// from alarms, so the next occurrence notifies again. GitHub itself does not
// suppress repeat failure mails, so without this a 12 h outage is 72 emails.

const SHORT = (h) => String(h ?? "").slice(0, 12);

export function evaluateHealth({
  now,
  heartbeat,
  state,
  acked = {},
  alarms = {},
  sources,
  siblings = [],
  staleAfterMs,
  renotifyAfterMs,
  zeroItemsAfterMs,
  pollOutcome = null,
}) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const problems = []; // { key, message }
  const nextAcked = { ...acked };
  let ackedDirty = false;

  if (pollOutcome === "failure") {
    problems.push({ key: "poll:crashed", message: "poll step failed (exception outside the per-source guard) — see the 'Poll all sources' step log" });
  }

  if (!heartbeat) {
    problems.push({ key: "heartbeat:missing", message: "no heartbeat.json — poll has never completed" });
  } else {
    for (const source of sources) {
      const hb = heartbeat.sources?.[source.key];
      if (!hb || !hb.last_success) {
        problems.push({ key: `${source.key}:never`, message: `${source.key}: never succeeded` });
        continue;
      }
      const age = nowMs - Date.parse(hb.last_success);
      if (age > staleAfterMs) {
        const hours = (age / 3_600_000).toFixed(1);
        problems.push({
          key: `${source.key}:stale`,
          message: `${source.key}: last successful poll ${hours}h ago (${hb.last_success}), ${hb.consecutive_failures ?? 0} consecutive failures`,
        });
      }
    }
    // Sibling rule: 0 items for a long time while the sibling has items.
    for (const [a, b] of siblings) {
      for (const [x, y] of [[a, b], [b, a]]) {
        const hx = heartbeat.sources?.[x];
        const hy = heartbeat.sources?.[y];
        if (!hx?.zero_since || !hy || !(hy.n_items > 0)) continue;
        const zeroFor = nowMs - Date.parse(hx.zero_since);
        if (zeroFor > zeroItemsAfterMs) {
          problems.push({
            key: `${x}:zero-items`,
            message: `${x}: 0 items for ${(zeroFor / 3_600_000).toFixed(1)}h while sibling ${y} serves ${hy.n_items} — parser silently broken? Check data/snapshots for ${x}.`,
          });
        }
      }
    }
  }

  // Schema drift: alarm until a human acknowledges by writing the new hash into
  // state/acknowledged-schemas.json (see RUNBOOK). First observation is the
  // baseline — auto-acknowledged so the alarm needs zero setup and fires only on change.
  for (const source of sources) {
    const s = state?.sources?.[source.key];
    if (!s?.schema?.hash) continue;
    const known = nextAcked[source.key];
    if (!known) {
      nextAcked[source.key] = s.schema.hash;
      ackedDirty = true;
    } else if (known !== s.schema.hash) {
      problems.push({
        key: `${source.key}:drift:${SHORT(s.schema.hash)}`,
        message: `${source.key}: SCHEMA DRIFT — envelope hash ${SHORT(s.schema.hash)} != acknowledged ${SHORT(known)}. Inspect the last schema_drift event in ledger/${source.key}/, then set state/acknowledged-schemas.json["${source.key}"] to the hash in heartbeat.json.`,
      });
    }
  }

  // Dedupe against the persisted alarm map.
  const nowIso = new Date(nowMs).toISOString();
  const nextAlarms = {};
  const notify = [];
  const suppressed = [];
  for (const p of problems) {
    const prev = alarms[p.key];
    const due = !prev || !prev.last_notified_at || nowMs - Date.parse(prev.last_notified_at) >= renotifyAfterMs;
    nextAlarms[p.key] = {
      first_failed_at: prev?.first_failed_at ?? nowIso,
      last_notified_at: due ? nowIso : prev.last_notified_at,
      notified: (prev?.notified ?? 0) + (due ? 1 : 0),
      message: p.message,
    };
    (due ? notify : suppressed).push(p);
  }
  const recovered = Object.keys(alarms).filter((k) => !nextAlarms[k]);

  return {
    problems,
    notify,
    suppressed,
    recovered,
    acked: nextAcked,
    ackedDirty,
    alarms: nextAlarms,
    exitCode: notify.length ? 1 : 0,
  };
}
