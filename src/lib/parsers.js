// One parser per source. Each returns:
//   { items: [{ id, hash, norm, summary }], envelope, malformed, meta? }
// - meta     optional publisher-side timestamps (osmet program.LastChange, Atom
//            feed <updated>) — recorded on the poll line so latency can be split
//            into "publisher generated" vs "we fetched".
// - id       stable identity of the warning within the source (synthesized for imgw-hydro)
// - norm     the item as served, with ORDER-NORMALIZED arrays where the feed is
//            known to shuffle them (imgw teryt / kod_zlewni). Hash input.
// - hash     content hash of `norm` (canonical JSON)
// - summary  normalized, source-agnostic view used by the ledger and the report
// - envelope description of the top-level shape, used for schema-drift detection
//
// The summary shape (all times ISO UTC or null):
//   { event, level, valid_from, valid_to, published, msg_type, areas[], n_areas,
//     imgw_id, refs[], office, comment }

import { canonicalJson, itemHash, sha256 } from "./hash.js";
import { warsawToUtcIso, isoToUtcIso } from "./time.js";

const str = (v) => (typeof v === "string" ? v : v == null ? null : String(v));

export function parseSource(key, body) {
  switch (key) {
    case "imgw-meteo":
      return parseImgwMeteo(body);
    case "imgw-hydro":
      return parseImgwHydro(body);
    case "imgw-osmet":
      return parseImgwOsmet(body);
    case "meteoalarm-json":
      return parseMeteoalarmJson(body);
    case "meteoalarm-atom":
      return parseMeteoalarmAtom(body);
    default:
      throw new Error(`no parser for source ${key}`);
  }
}

function parseJson(body) {
  const data = JSON.parse(body);
  return data;
}

// ---------------------------------------------------------------- imgw-meteo
export function parseImgwMeteo(body) {
  const data = parseJson(body);
  if (!Array.isArray(data)) throw new Error("imgw-meteo: top level is not an array");
  const items = [];
  let malformed = 0;
  for (const raw of data) {
    const id = str(raw?.id);
    if (!id) {
      malformed += 1;
      continue;
    }
    const teryt = Array.isArray(raw.teryt) ? raw.teryt.map(String) : [];
    // IMGW serves `teryt` (and the row list) in NON-DETERMINISTIC order —
    // measured 2026-08-16: two polls 40 s apart, same content, different order.
    // Hash a sorted copy so order noise is not counted as a mutation.
    const norm = { ...raw, teryt: [...teryt].sort() };
    items.push({
      id,
      hash: itemHash(norm),
      norm,
      summary: {
        event: str(raw.nazwa_zdarzenia),
        level: str(raw.stopien),
        valid_from: warsawToUtcIso(raw.obowiazuje_od),
        valid_to: warsawToUtcIso(raw.obowiazuje_do),
        published: warsawToUtcIso(raw.opublikowano),
        msg_type: null,
        areas: teryt,
        n_areas: teryt.length,
        imgw_id: id,
        refs: [],
        office: str(raw.biuro),
        comment: str(raw.komentarz),
      },
    });
  }
  return { items, malformed, envelope: { top: "array", item_keys: unionKeys(data) } };
}

// ---------------------------------------------------------------- imgw-hydro
/**
 * Hydro rows have no id. `numer` is per-office and (presumably) per-year, so the
 * synthesized id is  hydro:<year of opublikowano>:<numer>:<sha256(biuro)[0:8]>.
 * If IMGW re-issues the same numer with a new opublikowano the recorder sees a
 * "changed" event, which is exactly the observation we want.
 */
export function hydroId(raw) {
  const year = str(raw.opublikowano)?.slice(0, 4) ?? "0000";
  const office = sha256(str(raw.biuro) ?? "").slice(0, 8);
  return `hydro:${year}:${str(raw.numer) ?? "?"}:${office}`;
}

export function parseImgwHydro(body) {
  const data = parseJson(body);
  if (!Array.isArray(data)) throw new Error("imgw-hydro: top level is not an array");
  const items = [];
  let malformed = 0;
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || raw.numer == null) {
      malformed += 1;
      continue;
    }
    const areas = [];
    for (const o of Array.isArray(raw.obszary) ? raw.obszary : []) {
      for (const k of Array.isArray(o?.kod_zlewni) ? o.kod_zlewni : []) areas.push(String(k));
    }
    const norm = {
      ...raw,
      obszary: (Array.isArray(raw.obszary) ? raw.obszary : [])
        .map((o) => ({ ...o, kod_zlewni: [...(Array.isArray(o?.kod_zlewni) ? o.kod_zlewni : [])].sort() }))
        .sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1)),
    };
    items.push({
      id: hydroId(raw),
      hash: itemHash(norm),
      norm,
      summary: {
        event: str(raw.zdarzenie),
        level: str(raw["stopień"] ?? raw.stopien),
        valid_from: warsawToUtcIso(raw.data_od),
        valid_to: warsawToUtcIso(raw.data_do),
        published: warsawToUtcIso(raw.opublikowano),
        msg_type: null,
        areas,
        n_areas: areas.length,
        imgw_id: null,
        refs: [],
        office: str(raw.biuro),
        comment: str(raw.komentarz),
      },
    });
  }
  return { items, malformed, envelope: { top: "array", item_keys: unionKeys(data) } };
}

// ---------------------------------------------------------------- imgw-osmet
export function parseImgwOsmet(body) {
  const data = parseJson(body);
  if (!data || typeof data !== "object" || !data.warnings || typeof data.warnings !== "object") {
    throw new Error("imgw-osmet: missing warnings map");
  }
  // reverse the teryt -> [ids] map into id -> [teryt]
  const areasById = new Map();
  for (const [teryt, ids] of Object.entries(data.teryt ?? {})) {
    for (const id of Array.isArray(ids) ? ids : []) {
      if (!areasById.has(id)) areasById.set(id, []);
      areasById.get(id).push(String(teryt));
    }
  }
  const items = [];
  const warnings = data.warnings;
  for (const [id, raw] of Object.entries(warnings)) {
    const areas = (areasById.get(id) ?? []).sort();
    const norm = { ...raw, _teryt: areas };
    items.push({
      id,
      hash: itemHash(norm),
      norm,
      summary: {
        event: [str(raw.PhenomenonCode), str(raw.PhenomenonName)].filter(Boolean).join(":"),
        level: str(raw.Level),
        valid_from: isoToUtcIso(raw.LxValidFrom) ?? warsawToUtcIso(raw.ValidFrom),
        valid_to: isoToUtcIso(raw.LxValidTo) ?? warsawToUtcIso(raw.ValidTo),
        published: isoToUtcIso(raw.LxReleaseDateTime) ?? warsawToUtcIso(raw.ReleaseDateTime),
        msg_type: null,
        areas,
        n_areas: areas.length,
        imgw_id: id,
        refs: [],
        office: str(raw.Name2),
        comment: str(raw.Comments),
      },
    });
  }
  const program = data.program && typeof data.program === "object" ? data.program : {};
  return {
    items,
    malformed: 0,
    envelope: {
      top: Object.keys(data).sort(),
      item_keys: unionKeys(Object.values(warnings)),
    },
    meta: {
      upstream_t: isoToUtcIso(str(program.LxLastChange)) ?? isoToUtcIso(str(program.LastChange)) ?? null,
      upstream_export_t: isoToUtcIso(str(program.LxExportTime)) ?? null,
      upstream_unix: program.unixLastChange != null ? Number(program.unixLastChange) || null : null,
    },
  };
}

// ---------------------------------------------------------- meteoalarm-json
/** "2.49.0.0.616.0.PL.Sk20260815100248479.PL1061" -> "Sk20260815100248479" */
export function imgwIdFromCapIdentifier(identifier) {
  if (typeof identifier !== "string") return null;
  const parts = identifier.split(".");
  if (parts.length < 9) return null;
  const candidate = parts[7];
  return /^[A-Za-z]{2}\d{14,20}$/.test(candidate) ? candidate : null;
}

/** CAP references: "sender,identifier,sent" tuples separated by whitespace. */
export function parseCapReferences(refs) {
  if (typeof refs !== "string" || !refs.trim()) return [];
  return refs
    .trim()
    .split(/\s+/)
    .map((tuple) => tuple.split(",")[1])
    .filter(Boolean);
}

function awarenessLevel(info) {
  const p = (info?.parameter ?? []).find((x) => x?.valueName === "awareness_level");
  return p ? String(p.value) : null;
}

export function parseMeteoalarmJson(body) {
  const data = parseJson(body);
  if (!data || !Array.isArray(data.warnings)) throw new Error("meteoalarm-json: missing warnings array");
  const items = [];
  let malformed = 0;
  for (const rec of data.warnings) {
    const alert = rec?.alert;
    const id = str(alert?.identifier);
    if (!id) {
      malformed += 1;
      continue;
    }
    const infos = Array.isArray(alert.info) ? alert.info : [];
    const pl = infos.find((i) => String(i?.language ?? "").startsWith("pl")) ?? infos[0] ?? {};
    const en = infos.find((i) => String(i?.language ?? "").startsWith("en")) ?? null;
    const areas = [];
    for (const i of infos) {
      for (const a of Array.isArray(i?.area) ? i.area : []) {
        for (const g of Array.isArray(a?.geocode) ? a.geocode : []) {
          if (g?.valueName === "EMMA_ID" && g.value) areas.push(String(g.value));
        }
      }
    }
    const uniqAreas = [...new Set(areas)].sort();
    const norm = { uuid: rec.uuid ?? null, ...alert };
    items.push({
      id,
      hash: itemHash(norm),
      norm,
      summary: {
        event: str(en?.event ?? pl.event),
        level: awarenessLevel(pl),
        valid_from: isoToUtcIso(pl.onset ?? pl.effective),
        valid_to: isoToUtcIso(pl.expires),
        published: isoToUtcIso(alert.sent),
        msg_type: str(alert.msgType),
        areas: uniqAreas,
        n_areas: uniqAreas.length,
        imgw_id: imgwIdFromCapIdentifier(id),
        refs: parseCapReferences(alert.references),
        office: str(pl.senderName),
        comment: null,
        uuid: str(rec.uuid),
      },
    });
  }
  const alerts = data.warnings.map((r) => r?.alert).filter(Boolean);
  const infos = alerts.flatMap((a) => (Array.isArray(a.info) ? a.info : []));
  return {
    items,
    malformed,
    envelope: {
      top: Object.keys(data).sort(),
      record_keys: unionKeys(data.warnings),
      alert_keys: unionKeys(alerts),
      info_keys: unionKeys(infos),
    },
  };
}

// ---------------------------------------------------------- meteoalarm-atom
// Regex extraction on purpose: zero deps, and the entries are flat. The raw
// entry XML travels along in `raw.entry_xml`, so nothing is lost if the regexes
// miss a field that appears later.
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1].trim()) : null;
};
function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// <entry> may carry attributes (xmlns, xml:lang) — match the tag, not the literal.
const ENTRY_OPEN = /<entry(?:\s[^>]*)?>/;

export function stripAtomFeedNoise(xml) {
  // Feed-level <updated> is the fetch time; strip it before hashing the envelope.
  const head = xml.split(ENTRY_OPEN)[0];
  return head.replace(/<updated>[^<]*<\/updated>/, "<updated/>");
}

export function parseMeteoalarmAtom(body) {
  if (typeof body !== "string" || !body.includes("<feed")) throw new Error("meteoalarm-atom: not an Atom feed");
  const parts = body.split(ENTRY_OPEN);
  const entriesXml = parts.slice(1).map((e) => e.split("</entry>")[0]);
  const items = [];
  let malformed = 0;
  const seenTags = new Set();
  for (const entryXml of entriesXml) {
    const id = tag(entryXml, "cap:identifier");
    if (!id) {
      malformed += 1;
      continue;
    }
    for (const m of entryXml.matchAll(/<(cap:[a-zA-Z_]+|link|published|updated|id|title|author)[\s>/]/g)) seenTags.add(m[1]);
    const areas = [...entryXml.matchAll(/<cap:geocode>[\s\S]*?<value>([^<]+)<\/value>[\s\S]*?<\/cap:geocode>/g)]
      .map((m) => decodeXml(m[1].trim()))
      .sort();
    const capLink = entryXml.match(/<link[^>]*type="application\/cap\+xml"[^>]*href="([^"]+)"/)?.[1] ?? null;
    const raw = {
      identifier: id,
      event: tag(entryXml, "cap:event"),
      sent: tag(entryXml, "cap:sent"),
      expires: tag(entryXml, "cap:expires"),
      effective: tag(entryXml, "cap:effective"),
      onset: tag(entryXml, "cap:onset"),
      certainty: tag(entryXml, "cap:certainty"),
      severity: tag(entryXml, "cap:severity"),
      urgency: tag(entryXml, "cap:urgency"),
      scope: tag(entryXml, "cap:scope"),
      message_type: tag(entryXml, "cap:message_type"),
      status: tag(entryXml, "cap:status"),
      areaDesc: tag(entryXml, "cap:areaDesc"),
      geocodes: areas,
      cap_link: capLink,
      published: tag(entryXml, "published"),
      updated: tag(entryXml, "updated"),
      title: tag(entryXml, "title"),
      entry_xml: entryXml.trim(),
    };
    const { entry_xml, ...fields } = raw;
    const norm = { ...fields, entry_xml_hash: sha256(entry_xml.replace(/\s+/g, " ")).slice(0, 16) };
    items.push({
      id,
      hash: itemHash(norm),
      norm,
      summary: {
        event: raw.event,
        level: null,
        valid_from: isoToUtcIso(raw.onset ?? raw.effective),
        valid_to: isoToUtcIso(raw.expires),
        published: isoToUtcIso(raw.sent),
        msg_type: raw.message_type,
        areas,
        n_areas: areas.length,
        imgw_id: imgwIdFromCapIdentifier(id),
        refs: [],
        office: null,
        comment: null,
        uuid: capLink ? capLink.split("/").pop() : null,
      },
    });
  }
  const headTags = [...stripAtomFeedNoise(body).matchAll(/<([a-zA-Z:_]+)[\s>/]/g)].map((m) => m[1]);
  return {
    items,
    malformed,
    envelope: {
      top: [...new Set(headTags)].sort(),
      entry_tags: [...seenTags].sort(),
    },
    meta: { feed_updated: isoToUtcIso(tag(body.split(ENTRY_OPEN)[0], "updated")) },
  };
}

// ---------------------------------------------------------------- helpers
export function unionKeys(rows) {
  const keys = new Set();
  for (const r of rows ?? []) {
    if (r && typeof r === "object" && !Array.isArray(r)) for (const k of Object.keys(r)) keys.add(k);
  }
  return [...keys].sort();
}
