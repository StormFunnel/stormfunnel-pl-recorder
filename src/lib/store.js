// Filesystem layout + IO. Everything under ROOT:
//   state/recorder-state.json                     mutable working state (one file, unchanged on unchanged polls)
//   state/acknowledged-schemas.json               schema baseline per source (check.js)
//   data/polls/<source>/YYYY-MM.ndjson            one line per poll per source (always)
//   data/items/<source>/YYYY-MM.ndjson            every new (id,hash) version, normalized item (IMGW sources)
//   data/snapshots/YYYY/MM/DD/<source>-<ts>.json.gz  full raw body per policy (on-change | daily keyframe)
//   ledger/<source>.ndjson                        append-only observation events
//   heartbeat.json                                last successful poll per source (for check.js and humans)

import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { ROOT } from "../config.js";

const j = (...p) => path.join(ROOT, ...p);

export async function readState() {
  try {
    return JSON.parse(await fs.readFile(j("state", "recorder-state.json"), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { sources: {} };
    throw err;
  }
}

export async function writeState(state) {
  await fs.mkdir(j("state"), { recursive: true });
  const tmp = j("state", "recorder-state.json.tmp");
  await fs.writeFile(tmp, JSON.stringify(state, null, 1), "utf8");
  await fs.rename(tmp, j("state", "recorder-state.json"));
}

export async function appendPollLine(sourceKey, line) {
  const d = new Date(line.t);
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const dir = j("data", "polls", sourceKey);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${month}.ndjson`), JSON.stringify(line) + "\n", "utf8");
}

/** New (id, hash) versions with their normalized item, monthly NDJSON. */
export async function appendItems(sourceKey, lines) {
  if (!lines.length) return;
  const d = new Date(lines[0].t);
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const dir = j("data", "items", sourceKey);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${month}.ndjson`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

export async function appendLedgerEvents(sourceKey, events) {
  if (!events.length) return;
  await fs.mkdir(j("ledger"), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.appendFile(j("ledger", `${sourceKey}.ndjson`), lines, "utf8");
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

export async function writeHeartbeat(heartbeat) {
  await fs.writeFile(j("heartbeat.json"), JSON.stringify(heartbeat, null, 1) + "\n", "utf8");
}

export async function readHeartbeat() {
  try {
    return JSON.parse(await fs.readFile(j("heartbeat.json"), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function readLedger(sourceKey) {
  try {
    const text = await fs.readFile(j("ledger", `${sourceKey}.ndjson`), "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** All poll-log lines for a source, oldest first. */
export async function readPollLog(sourceKey) {
  const dir = j("data", "polls", sourceKey);
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
