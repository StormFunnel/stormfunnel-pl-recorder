// Filesystem layout + IO. Everything under ROOT:
//   state/recorder-state.json                     mutable working state (one file, unchanged on unchanged polls)
//   state/acknowledged-schemas.json               schema baseline per source (check.js)
//   state/alarms.json                             health-alarm dedupe: problem key -> first/last notified (check.js)
//   data/polls/<source>/YYYY-MM.ndjson            one line per poll per source (always)
//   data/items/<source>/YYYY-MM.ndjson            every new (id,hash) version, normalized item (IMGW sources)
//   data/snapshots/YYYY/MM/DD/<source>-<ts>.json.gz  full raw body per policy (on-change | daily keyframe)
//   ledger/<source>/YYYY-MM.ndjson                append-only observation events (monthly: one file per
//                                                 source would cross GitHub's 100 MB push block in months)
//   heartbeat.json                                last successful poll per source (for check.js and humans)

import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { ROOT } from "../config.js";

const j = (...p) => path.join(ROOT, ...p);

function monthOf(tIso) {
  const d = new Date(tIso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function readJsonOr(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 1) + "\n", "utf8");
}

export async function readState() {
  return readJsonOr(j("state", "recorder-state.json"), { sources: {} });
}

export async function writeState(state) {
  await fs.mkdir(j("state"), { recursive: true });
  const tmp = j("state", "recorder-state.json.tmp");
  await fs.writeFile(tmp, JSON.stringify(state, null, 1), "utf8");
  await fs.rename(tmp, j("state", "recorder-state.json"));
}

export const readAcked = () => readJsonOr(j("state", "acknowledged-schemas.json"), {});
export const writeAcked = (acked) => writeJson(j("state", "acknowledged-schemas.json"), acked);
export const readAlarms = () => readJsonOr(j("state", "alarms.json"), {});
export const writeAlarms = (alarms) => writeJson(j("state", "alarms.json"), alarms);
export const readHeartbeat = () => readJsonOr(j("heartbeat.json"), null);
export const writeHeartbeat = (heartbeat) => writeJson(j("heartbeat.json"), heartbeat);

export async function appendPollLine(sourceKey, line) {
  const dir = j("data", "polls", sourceKey);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${monthOf(line.t)}.ndjson`), JSON.stringify(line) + "\n", "utf8");
}

/** New (id, hash) versions with their normalized item, monthly NDJSON. */
export async function appendItems(sourceKey, lines) {
  if (!lines.length) return;
  const dir = j("data", "items", sourceKey);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    path.join(dir, `${monthOf(lines[0].t)}.ndjson`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

/** Ledger events, monthly NDJSON per source. All events of one call share the poll time. */
export async function appendLedgerEvents(sourceKey, events) {
  if (!events.length) return;
  const dir = j("ledger", sourceKey);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    path.join(dir, `${monthOf(events[0].t)}.ndjson`),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

/** Full raw body, gzipped. Returns the repo-relative path written. */
export async function writeSnapshot(sourceKey, body, tIso) {
  const d = new Date(tIso);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const ts = tIso.replace(/[:.]/g, "").replace("T", "-").slice(0, 15) + "Z";
  const rel = path.join("data", "snapshots", yyyy, mm, dd, `${sourceKey}-${ts}.json.gz`);
  await fs.mkdir(path.dirname(j(rel)), { recursive: true });
  await fs.writeFile(j(rel), gzipSync(Buffer.from(body, "utf8"), { level: 9 }));
  return rel.split(path.sep).join("/");
}

/** All ledger events for a source, oldest first. */
export async function readLedger(sourceKey) {
  return readNdjsonDir(j("ledger", sourceKey));
}

/** All poll-log lines for a source, oldest first. */
export async function readPollLog(sourceKey) {
  return readNdjsonDir(j("data", "polls", sourceKey));
}

async function readNdjsonDir(dir) {
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".ndjson")).sort();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const f of files) {
    const text = await fs.readFile(path.join(dir, f), "utf8");
    for (const line of text.split("\n")) if (line) out.push(JSON.parse(line));
  }
  return out;
}
