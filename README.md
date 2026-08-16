# stormfunnel-pl-recorder

Append-only recorder for Polish weather warnings. Polls IMGW-PIB and Meteoalarm every 10 minutes from a GitHub Actions cron, commits the raw captures plus a per-warning observation ledger back into this repo, and alarms (workflow failure → GitHub email) when a source goes stale or its schema drifts.

Two reasons it exists:

1. **History.** No machine-readable archive of Polish warnings exists publicly (IMGW's archive is monthly ZIPs of PDFs). Every day of recording is a day of calibration data the StormFunnel-PL port will not otherwise have.
2. **Feed behaviour measurement.** The ingest design for the PL port hinges on questions the documentation does not answer: are warning ids stable or do rows mutate in place; is a withdrawn warning cancelled explicitly or does it silently vanish; how long after `opublikowano` does a warning appear in each feed; how big are blanket warnings; how many powiats are covered; does the field set drift. The ledger is built to answer those without reparsing snapshots.

Zero dependencies. Zero build step. Node 20+. Runs identically on a laptop and on `ubuntu-latest`.

## Sources (all fetched live 2026-08-15/16, all HTTP 200)

| key | URL | what | policy |
|---|---|---|---|
| `imgw-meteo` | `https://danepubliczne.imgw.pl/api/data/warningsmeteo` | Documented IMGW public API. Current meteo warnings, one row per warning with `id`, `stopien` 1–3, validity, free text `tresc`, `teryt[]` (4-digit powiat codes). Times are Europe/Warsaw wall clock without offset. | snapshot on-change, items |
| `imgw-hydro` | `https://danepubliczne.imgw.pl/api/data/warningshydro` | Documented IMGW public API. Hydro warnings (drought/flood), catchment-coded (`kod_zlewni`). **Rows have no id** — the recorder synthesizes `hydro:<year>:<numer>:<sha(biuro)[0:8]>`. | snapshot on-change, items |
| `imgw-osmet` | `https://meteo.imgw.pl/api/meteo/messages/v1/osmet/latest/osmet-teryt` | **Undocumented** endpoint behind the official map. Same ids as `imgw-meteo`, adds `PhenomenonCode`, `Level`, English text, SMS copy, `Rcb` flag, and a `teryt -> [ids]` reverse map. May vanish without notice; recorded because it is what an ingest would want to use. | snapshot on-change, items |
| `meteoalarm-json` | `https://feeds.meteoalarm.org/api/v1/warnings/feeds-poland` | Meteoalarm hub API, full CAP 1.2 as JSON. One record per (warning × EMMA_ID area) — a 7-warning IMGW list is ~350 records. Carries `msgType` (Alert/Update/Cancel) and `references`. Retains expired records ~5 days. CAP identifier embeds the IMGW id: `2.49.0.0.616.0.PL.<imgw id>.<EMMA_ID>`. | snapshot daily keyframe |
| `meteoalarm-atom` | `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-poland` | Meteoalarm legacy Atom feed (advertises a WebSub hub). Same per-area entries as the JSON API but summary fields only (`cap:event/sent/expires/message_type/identifier` + link to per-warning CAP XML). **Answers 406 to `Accept: application/atom+xml`; needs `*/*` in Accept.** | snapshot daily keyframe |

Facts learned while wiring, worth knowing before designing the adapter:

- IMGW `warningsmeteo` returns rows and `teryt[]` in **non-deterministic order** (two polls 40 s apart, identical content, shuffled). The recorder hashes an order-normalized copy; an ingest must too, or every poll looks like a mutation.
- Meteoalarm `awareness_level` is 1–4 (green…red): IMGW `stopien 1` == Meteoalarm `2; yellow`.
- IMGW updates appear to mint a **new id** (Meteoalarm `Update` records reference the previous identifier, e.g. `Sk20260815100238357` supersedes `Gd20260814094133267`). Whether the old id disappears from `warningsmeteo` immediately, and whether anything marks it as superseded there, is exactly what the ledger will show.
- Meteoalarm marine warnings use numeric ids (`260811032920`) not Biuro-prefixed ones; `imgw_id` join is null for those.

## Layout

```
src/
  config.js            source registry, storage policy per source, User-Agent, thresholds
  poll.js              one tick: fetch → parse → hash → ledger → snapshot → state → heartbeat
  check.js             health gate: stale > 2 h / schema drift / 0 items vs sibling / poll crash → exit 1, deduped (lib/health.js)
  report.js            per-source stats from the ledger + poll log
  lib/                 pure functions: hash, time (Warsaw→UTC), parsers, ledger, drift, health, fetcher, store
test/                  node:test suites: pure functions over fixtures/, fetcher with injected fetch, health dedupe, end-to-end poll ticks under a scratch RECORDER_ROOT
fixtures/              one live capture per source (2026-08-15) — the test oracle
.github/workflows/poll.yml
data/
  polls/<source>/YYYY-MM.ndjson          1 line per poll per source, ALWAYS (timing, status, bytes, hash, changed?, events, hdr{date,etag,age,cache…}, meta{publisher timestamps})
  items/<source>/YYYY-MM.ndjson          every new (id, hash) version with the normalized item — IMGW sources
  snapshots/YYYY/MM/DD/<source>-<ts>.json.gz   full raw body per policy
ledger/<source>/YYYY-MM.ndjson           observation events (below), monthly files
state/recorder-state.json                working state; unchanged polls change only 2 timestamps per source
state/acknowledged-schemas.json          schema baseline per source (auto-seeded on first run)
state/alarms.json                        health-alarm dedupe map (problem key → first/last notified)
heartbeat.json                           last successful poll per source
```

## Data model

**Item identity.** `id` = the feed's own id (`imgw-meteo`, `imgw-osmet`: IMGW id; Meteoalarm: CAP identifier; `imgw-hydro`: synthesized). `hash` = sha256 of the canonical JSON of the item with known-unstable arrays sorted (`teryt`, `kod_zlewni`). Feed hash = sha256 over sorted `id:hash` pairs, so item order never counts as a change.

**Ledger events** (`ledger/<source>/YYYY-MM.ndjson`, one JSON per line, all times UTC ISO):

| ev | when | payload |
|---|---|---|
| `appeared` | id seen for the first time ever | `id, hash, summary` |
| `reappeared` | id seen again after a `disappeared` | + `gone_at, prev_hash` |
| `changed` | same id, new hash | `prev_hash, hash, changed_keys[], summary` |
| `disappeared` | id present at previous successful poll, absent now | `first_seen, last_seen, changes, published, valid_to, msg_type, event, level, n_areas` |
| `schema_drift` | `alarm:true`: top-level shape changed or a never-seen item key appeared → `diff {field: {added[], removed[]}}, new_hash`. `alarm:false`: keys present on the last non-empty poll are absent now (optional keys such as Meteoalarm `references` come and go with the traffic) → `removed {field: [keys]}`. An empty feed teaches nothing and writes neither. |

`summary` is source-agnostic: `{event, level, valid_from, valid_to, published, msg_type, areas[], n_areas, imgw_id, refs[], office, comment}`.

**How the questions map to the ledger**

- *id stability / mutation*: `changed` events and `changed_keys` (which top-level fields moved).
- *cancel vs silent disappearance*: a CAP `Cancel` is a NEW record whose `references` name the cancelled identifier (the cancelled record's own `msg_type` stays `Alert`), so `report.js` joins `summary.refs` of every appeared/changed record onto disappeared ids: referenced by a `Cancel` → cancelled, by an `Update` → superseded, `valid_to <= t` → expired, reappeared within ≤ 2 polls → flap, none of those → **silent** (still valid, just gone).
- *update latency*: `appeared.t - summary.published` per source (upper bound = poll interval + feed delay), and `imgw-meteo` vs `meteoalarm-json` first-seen delta on the same `imgw_id`.
- *blanket duration / size*: `disappeared.last_seen - first_seen`; `n_areas` distribution.
- *powiat coverage*: union of `summary.areas` over `imgw-meteo` appeared events.
- *field-set drift*: `schema_drift` events + `state/acknowledged-schemas.json`. The acked hash is over the monotone union of keys ever seen per source, so it moves only when something NEW shows up.
- *cron drift / uptime*: `data/polls/*` gaps, `ok`, `ms`, `attempts`.
- *latency below the poll interval*: every poll line keeps the response `Date`/`Last-Modified`/`ETag`/`Cache-Control`/`Age`/`X-Cache`/`CF-Cache-Status` headers (`hdr`) and, where the publisher states it, its own generation time (`meta.upstream_t` = osmet `program.LxLastChange`, `meta.feed_updated` = Atom feed `<updated>`) — publisher time vs cache time vs our fetch time are three different columns.

`npm run report` prints all of the above per source.

## Storage policy and growth math

Measured 2026-08-16 (7 IMGW meteo warnings, 93 hydro, 352 Meteoalarm records):

| artefact | size |
|---|---|
| poll-log line | ~175 B / source / poll |
| snapshot (gzip) | imgw-meteo 1.1 KB, imgw-osmet 1.9 KB, imgw-hydro 8.3 KB, meteoalarm-json 28.7 KB, meteoalarm-atom 23.3 KB |
| ledger event | imgw-meteo/osmet ~0.7 KB, hydro ~0.85 KB, meteoalarm-json ~0.6 KB, atom ~0.53 KB |
| item line (IMGW) | meteo 0.8 KB, osmet 1.3 KB, hydro 1.3 KB |
| state file | ~0.75 MB for 810 active ids; unchanged poll = 10-line diff |

Policy decisions:

- **Poll log always** (144 polls/day × 5 × 175 B ≈ 126 KB/day text). This is the "unchanged marker" and the cron-drift evidence in one line.
- **IMGW sources: snapshot on every feed change + item deltas.** They have no retention (a warning withdrawn within a day would be lost otherwise) and they are tiny.
- **Meteoalarm sources: one gzip keyframe on the first poll of each UTC day** (unconditionally), plus a keyframe when new/changed records arrived and the last keyframe is > 6 h old, plus on drift/parse failure. Their ~5-day retention means every record lands in several keyframes; the 6 h rule closes the gap for a record that appears after the day's keyframe and drops before the next. Worst case ~4 × 29 KB/day/source instead of 30–100 on-change blobs (0.3–1 GB/year).
- **Parse failures snapshot once per distinct body** (hash-deduped) — a broken feed repeats identically every tick.
- **State never carries per-id `last_seen`** — it would rewrite every entry each poll and cost ~10 MB/day in git deltas. `last_seen` is derived from the previous poll time on disappearance.

Daily volume with W = IMGW meteo warnings issued per day and A ≈ 25 areas per warning (observed median 11, max 102):

| | typical (W≈10) | stormy summer day (W≈60) |
|---|---|---|
| polls | 126 KB | 126 KB |
| imgw-meteo + osmet (snapshots + items + ledger) | ~90 KB | ~500 KB |
| imgw-hydro | ~20 KB | ~50 KB |
| meteoalarm-json (keyframe + ledger 2·W·A × 0.6 KB) | ~330 KB | ~1.8 MB |
| meteoalarm-atom (keyframe + ledger 2·W·A × 0.53 KB) | ~290 KB | ~1.6 MB |
| **text before git compression** | **~0.9 MB/day** | **~4.5 MB/day** |
| packed (NDJSON compresses ~6–8×, .gz stored as-is) | ~0.2 MB/day | ~0.9 MB/day |
| **per year** | **~75 MB** | **~330 MB** |

Well under GitHub's 1 GB recommendation for the foreseeable horizon. The ledger is split per month (`ledger/<source>/YYYY-MM.ndjson`) because a single `meteoalarm-json` ledger file at ~0.3–1.8 MB/day would cross GitHub's 100 MB per-file push block within 2–10 months and every push would fail from then on. Escape valves, in order: drop `meteoalarm-atom` from `SOURCES` (−40 % of ledger; the JSON API is a superset), then squash `data/` monthly into a release asset.

Commits: 144/day ≈ 52 k/year (heartbeat + poll log change every tick). Checkout cost: HEAD carries every snapshot and the state file, ~100–200 MB after 6 months at depth 1 — fine, `timeout-minutes: 15` covers it. Actions minutes: 144 × 1 billed minute ≈ 4 300/month — **free only on a public repo** (private Free plan = 2 000 min/month; a private repo needs `*/30`). See RUNBOOK.

## Running locally

```
npm test        # 66 tests, node:test, fixtures/ + injected fetch + scratch RECORDER_ROOT
npm run poll    # one tick, read-only GETs, writes data/ ledger/ state/ heartbeat.json
npm run check   # exit 1 on a NEW alarm (stale > 2 h, schema drift, 0 items vs sibling, poll crash); known alarms = warning
npm run report  # stats
```

Env (all optional): `RECORDER_CONTACT` (email in User-Agent; default `ops@example.invalid` — set it), `RECORDER_REPO_URL`, `RECORDER_ROOT` (write elsewhere than the repo).

## How the workflow works

`.github/workflows/poll.yml`, cron `*/10 * * * *` + manual `workflow_dispatch`, `concurrency` group so ticks queue instead of overlapping:

1. checkout (depth 1) → setup-node 20 → `node src/poll.js` (`continue-on-error`: whatever it wrote is still committed; a crash reaches check.js as `RECORDER_POLL_OUTCOME=failure`)
2. `node src/check.js` with `continue-on-error` — the data of a sick tick is still committed
3. `git add data ledger state heartbeat.json`, commit `poll <ts>`, push with a 3× rebase-retry
4. if step 2 failed → `exit 1` so the run is red

GitHub facts baked in: minimum cron interval is 5 min; schedules are best-effort (late by minutes under load, especially at :00 — the poll log records actual time, `npm run report` shows the gap distribution); scheduled workflows are auto-disabled after 60 days without repository activity (our commits count, but if pushes ever break for 60 days a human re-enables it in the Actions tab); the schedule runs the file on the default branch only.

## What the alarms mean

**Dedupe first.** GitHub emails on *every* failed run, not only the first of a series — a 12 h outage would be 72 emails and the mailbox filter that follows would kill the alarm for good. So `check.js` keeps `state/alarms.json` (`{problemKey: {first_failed_at, last_notified_at, notified, message}}`, committed with the tick) and fails the run only when a problem is **new** or was last notified more than **6 h** ago (`RENOTIFY_AFTER_MS`); a problem that is still present but already notified is a `::warning::` annotation on a green run. A problem that clears is dropped from the map, so its next occurrence emails again. Expect: 1 email when it starts, 1 every 6 h while it lasts, nothing when it ends.

A red run = one of (problem key in brackets):

- **`<source>: last successful poll N h ago`** [`<src>:stale`] — every attempt for > 2 h failed (HTTP error, timeout, or 200 that does not parse). Look at `data/polls/<source>/` for `error`. If it is a parse error there is a snapshot next to it: the shape changed. If it is IMGW 5xx for hours: their problem, the alarm will clear itself.
- **`<source>: SCHEMA DRIFT`** [`<src>:drift:<hash>`] — the top-level shape changed or an item key never seen before appeared. The last `schema_drift` line with `alarm:true` in `ledger/<source>/` has the diff. Decide whether the parser needs a change; then set `state/acknowledged-schemas.json[<source>]` to the hash in `heartbeat.json` (GitHub web editor is fine) and commit. Keys merely *absent* (an empty feed, no `Update` records today) never alarm.
- **`<source>: 0 items for N h while sibling <src> serves M`** [`<src>:zero-items`] — one of `imgw-meteo`/`imgw-osmet` or `meteoalarm-json`/`meteoalarm-atom` has been empty for > 12 h while its sibling is not: a 200 that parses to nothing (renamed root key, `<entry xmlns=…>`) looks exactly like a calm day otherwise. Compare the latest snapshots.
- **`poll step failed`** [`poll:crashed`] — `poll.js` threw outside the per-source guard (state file unreadable, disk). See the step log.

`poll.js` itself never fails the run for upstream trouble: a tick where every source failed is logged and the 2 h rule decides.

Notification path: GitHub → the *actor* of the scheduled run — the author of the commit that last touched the cron line in `poll.yml` — gets an email on workflow failure (Settings → Notifications → Actions, "failed workflows only" is the default). That author email must be a verified address on the account (RUNBOOK step 2), or the emails go to nobody. No secrets, no webhooks.

## Attribution

Data: IMGW-PIB (danepubliczne.imgw.pl) and EUMETNET Meteoalarm. See `LICENSE-NOTES.md`.
