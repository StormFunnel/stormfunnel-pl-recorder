import { fileURLToPath } from "node:url";

// Source registry. Every URL below was fetched live on 2026-08-15 (all 200).
// Keep the `key` stable forever: it is the namespace of every ledger line,
// state file and data path. Renaming a key orphans its history.
//
// Storage policy per source (the growth math is in README.md):
//   snapshot: "on-change" — full raw body (gzip) every time the feed hash moves.
//             Right for the small IMGW feeds (1–8 KB gz) which have NO retention:
//             a warning withdrawn within a day would otherwise be lost.
//   snapshot: "daily"     — full raw body once per UTC day (first changed poll),
//             plus on parse failure / schema drift. Right for the Meteoalarm
//             feeds (23–29 KB gz) which keep records ~5 days: every record is
//             present in several daily keyframes, so this is still lossless.
//   items: true           — additionally append every new (id, hash) version as
//             one NDJSON line with the normalized item. IMGW only: the raw
//             Polish text of every version is what the future adapter parses.

export const SOURCES = [
  {
    key: "imgw-meteo",
    url: "https://danepubliczne.imgw.pl/api/data/warningsmeteo",
    format: "json",
    documented: true,
    snapshot: "on-change",
    items: true,
    note: "IMGW-PIB public API, current meteorological warnings, per-powiat TERYT list.",
  },
  {
    key: "imgw-hydro",
    url: "https://danepubliczne.imgw.pl/api/data/warningshydro",
    format: "json",
    documented: true,
    snapshot: "on-change",
    items: true,
    note: "IMGW-PIB public API, current hydrological warnings (catchment-coded). Rows carry NO id — recorder synthesizes one (see parsers.js).",
  },
  {
    key: "imgw-osmet",
    url: "https://meteo.imgw.pl/api/meteo/messages/v1/osmet/latest/osmet-teryt",
    format: "json",
    documented: false,
    snapshot: "on-change",
    items: true,
    note: "Undocumented endpoint behind meteo.imgw.pl map. Adds PhenomenonCode, EN text, SMS copy, teryt->id reverse map. May vanish without notice.",
  },
  {
    key: "meteoalarm-json",
    url: "https://feeds.meteoalarm.org/api/v1/warnings/feeds-poland",
    format: "json",
    documented: true,
    snapshot: "daily",
    items: false,
    note: "Meteoalarm hub API: full CAP 1.2 as JSON, one record per (warning x EMMA area), keeps expired records ~5 days, carries msgType/references.",
  },
  {
    key: "meteoalarm-atom",
    url: "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-poland",
    format: "atom",
    documented: true,
    snapshot: "daily",
    items: false,
    note: "Meteoalarm legacy Atom feed (WebSub hub advertised). One entry per (warning x EMMA area); summary fields only.",
  },
];

export const CONTACT = process.env.RECORDER_CONTACT?.trim() || "ops@example.invalid";
export const REPO_URL =
  process.env.RECORDER_REPO_URL?.trim() || "https://github.com/<org>/stormfunnel-pl-recorder";
export const USER_AGENT = `stormfunnel-pl-recorder/0.1 (+${REPO_URL}; contact: ${CONTACT})`;

// Fetch policy — one source failing must never block another.
export const FETCH_ATTEMPTS = 3;
export const FETCH_TIMEOUT_MS = 20_000;
export const FETCH_BACKOFF_MS = [2_000, 5_000];

// Health policy (src/check.js, src/lib/health.js).
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // no successful poll for 2 h -> alarm
export const RENOTIFY_AFTER_MS = 6 * 60 * 60 * 1000; // re-fail the workflow at most every 6 h per alarm key
export const ZERO_ITEMS_AFTER_MS = 12 * 60 * 60 * 1000; // 0 items for 12 h while the sibling has items -> alarm
export const GONE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // remember disappeared ids for flap detection
// Sources that describe the same warnings through different feeds. Used by the
// zero-items rule: one of them empty for hours while the other is not is a
// silent parser break (a calm day empties both).
export const SIBLINGS = [
  ["imgw-meteo", "imgw-osmet"],
  ["meteoalarm-json", "meteoalarm-atom"],
];

// Snapshot policy for "daily" sources: besides the first poll of each UTC day,
// take a keyframe when new/changed records arrived and the last one is older
// than this — otherwise a record that appears after the day's keyframe and
// drops before the next one has no raw CAP captured.
export const KEYFRAME_MIN_GAP_MS = 6 * 60 * 60 * 1000;

export const ROOT = process.env.RECORDER_ROOT?.trim() || fileURLToPath(new URL("..", import.meta.url));
