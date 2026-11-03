import { SCOOP_PAGES, RSS_FEEDS, MOVE_WORDS, NAMES_PER_QUERY, NAME_QUERIES_PER_SCAN, nameQuery } from "./sources.mjs";
import { buildNameIndex, findCandidates, norm } from "./names.mjs";
import { extractMoves } from "./claude.mjs";
import { getRoster, getMoves, setMoves, getMeta, setMeta, getJSON, setJSON } from "./store.mjs";

const UA = "Mozilla/5.0 (compatible; BTGCoachCarousel/1.0)";
// No cap on how many articles Claude reads. Netlify stops any single background run at 15 min,
// so each run works for up to ~12 min, saves as it goes, then hands leftovers to a fresh run.
const TIME_BUDGET_MS = 12 * 60e3;
const SAVE_EVERY = 8;          // checkpoint moves + seen list every N Claude reads
const CONCURRENCY = 6;
const MAX_CHAIN = 25;          // follow-up runs allowed for one scan (~5 hours of reading)

async function get(url, ms = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

export function decode(s = "") {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
const strip = (s = "") => decode(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? decode(m[1]).trim() : ""; };

function unwrapLink(u) {
  // Bing wraps article links in a click-tracker; pull out the real URL.
  const m = u.match(/[?&]url=([^&]+)/);
  if (m && /bing\.com/.test(u)) { try { return decodeURIComponent(m[1]); } catch {} }
  return u;
}

export function parseRss(xml, feedName) {
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const it = m[0];
    let title = strip(tag(it, "title"));
    const link = tag(it, "link") || (it.match(/<guid[^>]*>([^<]+)</i) || [])[1] || "";
    const src = strip(tag(it, "source") || tag(it, "News:Source"));
    if (src && title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
    const pub = tag(it, "pubDate");
    items.push({
      url: unwrapLink(link.trim()), title, source: src || feedName, agg: /news\.google\.com|bing\.com/.test(link),
      date: pub ? new Date(pub).toISOString().slice(0, 10) : null,
      text: `${title}. ${strip(tag(it, "description"))}`.slice(0, 2000),
      needsBody: false,
    });
  }
  return items;
}

export function parseScoopListing(html) {
  const out = new Map();
  for (const m of html.matchAll(/href="((?:https:\/\/www\.footballscoop\.com)?\/(20\d\d)\/(\d\d)\/(\d\d)\/([a-z0-9-]+))"/gi)) {
    const path = m[1].replace("https://www.footballscoop.com", "");
    const url = "https://www.footballscoop.com" + path;
    if (out.has(url)) continue;
    out.set(url, {
      url, source: "FootballScoop", date: `${m[2]}-${m[3]}-${m[4]}`,
      title: m[5].replace(/-/g, " "), text: m[5].replace(/-/g, " "), needsBody: true,
    });
  }
  return [...out.values()];
}

export function parseScoopArticle(html) {
  const og = (p) => (html.match(new RegExp(`<meta[^>]+property="${p}"[^>]+content="([^"]*)"`, "i")) || [])[1];
  const title = decode(og("og:title") || (html.match(/<title>([^<]*)/i) || [])[1] || "");
  const pub = og("article:published_time");
  let body = "";
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  const scope = art ? art[0] : html;
  const ps = [...scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => strip(m[1])).filter((p) => p.length > 30);
  body = ps.join("\n");
  if (body.length < 200) body = strip(scope).slice(0, 30000);
  return { title: title.replace(/\s*[-|]\s*FootballScoop.*$/i, ""), date: pub ? pub.slice(0, 10) : null, text: `${title}\n${body}` };
}

// Aggregator items (Google/Bing) are keyed by headline so the same story from both engines is read once.
const keyFor = (it) => it.agg ? "t:" + norm(it.title).trim() : "u:" + it.url;

async function pool(tasks, n) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k]().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); } }));
  return out;
}

export async function collect(log, roster, meta) {
  const items = [];
  const jobs = [
    ...SCOOP_PAGES.map((u) => ({ name: `FootballScoop ${u.replace("https://www.footballscoop.com", "") || "/"}`, run: async () => parseScoopListing(await get(u)) })),
    ...RSS_FEEDS.map((f) => ({ name: f.name, run: async () => parseRss(await get(f.url), f.name) })),
  ];
  // Rotating name searches: a slice of the tracker each scan, wrapping around the whole list.
  const named = roster.filter((c) => c.first && c.last && c.first.length > 1 && c.last.length > 1 && !/[?]/.test(c.first + c.last));
  const batches = Math.ceil(named.length / NAMES_PER_QUERY);
  let cur = (meta.nameCursor || 0) % Math.max(batches, 1);
  const startCur = cur;
  for (let q = 0; q < Math.min(NAME_QUERIES_PER_SCAN, batches); q++) {
    const slice = named.slice(cur * NAMES_PER_QUERY, (cur + 1) * NAMES_PER_QUERY);
    const f = nameQuery(slice);
    jobs.push({ name: f.name, run: async () => parseRss(await get(f.url), f.name) });
    cur = (cur + 1) % batches;
  }
  meta.nameCursor = cur;
  log.nameSearch = `Coach-name searches covered tracker batch ${startCur + 1}–${((cur - 1 + batches) % batches) + 1} of ${batches}`;
  const res = await pool(jobs.map((j) => j.run), 8);
  res.forEach((r, k) => {
    const nm = jobs[k].name;
    if (r.ok) { items.push(...r.v); log.sources[nm] = (log.sources[nm] || 0) + r.v.length; }
    else log.errors.push(`${nm}: ${r.e?.message || r.e}`);
  });
  const uniq = new Map();
  for (const it of items) { if (!it.url) continue; const k = keyFor(it); if (!uniq.has(k)) uniq.set(k, { ...it, key: k }); }
  return [...uniq.values()];
}

// ---------- one card per real-world event ----------
const CAT = { Hired: "arrive", Promoted: "arrive", "Title Change": "arrive", Interim: "arrive",
  Fired: "exit", Resigned: "exit", Retired: "exit", Departed: "exit", "Passed Away": "death" };
const PREC = { Interim: 4, Promoted: 3, Hired: 2, "Title Change": 1, Fired: 4, Retired: 3, Resigned: 2, Departed: 1, "Passed Away": 1 };
const CERT_RANK = { rumored: 0, reported: 1, official: 2 };
const CONF_RANK = { low: 0, medium: 1, high: 2 };
const MAX_SOURCES = 40;
const t = (x) => norm(x || "").trim();
const sameTeam = (a, b) => { const x = t(a), y = t(b); return !x || !y || x === y || (` ${x} `).includes(` ${y} `) || (` ${y} `).includes(` ${x} `); };
const strictSame = (a, b) => !!t(a) && !!t(b) && sameTeam(a, b);
const days = (a, b) => Math.abs(Date.parse(a || 0) - Date.parse(b || 0)) / 864e5;

function sameEvent(a, b) {
  if (a.id === b.id) return true;
  const who = a.row && b.row ? a.row === b.row : t(a.coach_name) === t(b.coach_name);
  if (!who || CAT[a.move_type] !== CAT[b.move_type]) return false;
  const c = CAT[a.move_type];
  if (c === "death") return true;
  if (days(a.effective_date, b.effective_date) > 120) return false;
  return c === "arrive" ? sameTeam(a.to_team, b.to_team) : sameTeam(a.from_team, b.from_team);
}

function absorb(ex, m) {
  if ((PREC[m.move_type] || 0) > (PREC[ex.move_type] || 0)) ex.move_type = m.move_type;
  for (const s of m.sources || []) if (!ex.sources.some((x) => x.url === s.url)) { ex.sources.push(s); ex.source_count = (ex.source_count || ex.sources.length - 1) + 1; }
  ex.source_count = Math.max(ex.source_count || 0, ex.sources.length, (m.source_count || 0));
  if (ex.sources.length > MAX_SOURCES) ex.sources = ex.sources.slice(0, MAX_SOURCES);
  if ((CERT_RANK[m.certainty] ?? 1) > (CERT_RANK[ex.certainty] ?? 1)) ex.certainty = m.certainty;
  if ((CONF_RANK[m.match_confidence] ?? 1) > (CONF_RANK[ex.match_confidence] ?? 1)) { ex.match_confidence = m.match_confidence; ex.match_reason = m.match_reason; }
  for (const k of ["from_team", "from_title", "to_team", "to_title", "summary", "row"]) if (!ex[k] && m[k]) ex[k] = m[k];
  if (m.is_new_development) ex.is_new_development = true;
  if (m.effective_date && (!ex.effective_date || m.effective_date < ex.effective_date)) ex.effective_date = m.effective_date;
  if (ex.status !== "dismissed" && m.status === "confirmed") ex.status = "confirmed";
  ex.updated_at = new Date().toISOString();
}

// True when the tracker already shows the result of this move (i.e. it's old news to Spencer).
export function alreadyInTracker(m, coach) {
  if (!coach) return false;
  const c = CAT[m.move_type];
  if (c === "death" || m.move_type === "Interim") return false;
  if (c === "arrive") {
    if (m.move_type === "Hired") return strictSame(m.to_team, coach.current) || (strictSame(m.from_team, m.to_team) && strictSame(m.to_team, coach.current));
    return strictSame(m.to_team, coach.current) && (!t(m.to_title) || t(m.to_title) === t(coach.title));
  }
  // exit: tracker already has them out of coaching, or already somewhere else
  return !t(coach.current) || (!!t(m.from_team) && !sameTeam(m.from_team, coach.current));
}
const isRecent = (m) => Date.now() - Date.parse(m.effective_date || 0) < 30 * 864e5;
// Fixed floor (not a rolling window): moves that happened before this date are pre-tracking history.
// Change it with the BTG_CAROUSEL_SINCE env var (YYYY-MM-DD). Article publish dates are never limited.
const SINCE = () => process.env.BTG_CAROUSEL_SINCE || "2026-09-01";
export const keepMove = (m, coach) =>
  (m.move_type === "Passed Away" || !m.effective_date || m.effective_date >= SINCE()) &&
  (!alreadyInTracker(m, coach) || (m.is_new_development === true && isRecent(m)));

function newId(m) {
  const base = [m.row, m.move_type, t(m.to_team), t(m.from_team), m.effective_date].join("|");
  let h = 0; for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0;
  return "m" + (h >>> 0).toString(36);
}

// Returns "new", "merged" or "skipped".
export function mergeMove(moves, raw, coach, article, now) {
  const m = {
    row: coach.row, coach_name: `${coach.first} ${coach.last}`.trim(),
    move_type: raw.move_type, certainty: raw.certainty || "reported",
    from_team: raw.from_team || (CAT[raw.move_type] !== "arrive" || raw.move_type === "Hired" ? coach.current || null : null),
    from_title: raw.from_title || null, to_team: raw.to_team || null, to_title: raw.to_title || null,
    effective_date: raw.effective_date || article.date || now.slice(0, 10),
    is_new_development: raw.is_new_development === true,
    summary: raw.summary || "", match_confidence: raw.match_confidence || "medium", match_reason: raw.match_reason || "",
    status: "new", origin: "scan", found_at: now, updated_at: now,
    sources: [{ url: article.url, title: article.title, source: article.source, date: article.date }], source_count: 1,
  };
  if (["Promoted", "Title Change", "Interim"].includes(m.move_type) && !m.to_team) m.to_team = m.from_team || coach.current || null;
  if (m.move_type === "Hired" && strictSame(m.from_team, m.to_team)) m.move_type = "Title Change";
  if (CAT[m.move_type] === "death") m.to_team = null;
  m.id = newId(m);
  const ex = moves.find((x) => sameEvent(x, m));
  if (ex) { absorb(ex, m); return "merged"; }
  if (!keepMove(m, coach)) return "skipped";
  moves.push(m);
  return "new";
}

// Cleans the whole saved list: drops retired move types, merges duplicates, removes old news.
export function cleanMoves(moves, roster) {
  const byRow = new Map(roster.map((c) => [c.row, c]));
  const sorted = [...moves].filter((m) => CAT[m.move_type]).sort((a, b) => String(a.found_at).localeCompare(String(b.found_at)));
  const out = [];
  for (const m of sorted) {
    const mm = { ...m, sources: [...(m.sources || [])] };
    if (mm.move_type === "Hired" && strictSame(mm.from_team, mm.to_team)) mm.move_type = "Title Change";
    const ex = out.find((x) => sameEvent(x, mm));
    if (ex) { absorb(ex, mm); continue; }
    if (mm.origin === "scan" && !keepMove(mm, byRow.get(mm.row))) continue;
    out.push(mm);
  }
  return out;
}

// Full scan: gather headlines, keep coaching-related ones, find roster names, ask Claude, save moves.
// opts.chain = how many follow-up runs came before this one.
export async function runScan(trigger = "manual", opts = {}) {
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const chain = opts.chain || 0;
  const meta = await getMeta();
  if (meta.scanning && Date.now() - Date.parse(meta.scanning.startedAt) < 14.5 * 60e3) return { skipped: "A scan is already running" };
  meta.scanning = { startedAt, trigger, chain, stage: chain ? `Continuing (part ${chain + 1})` : "Collecting headlines" };
  await setMeta(meta);

  const log = { startedAt, trigger, chain, sources: {}, errors: [], collected: 0, newItems: 0, relevant: 0, withCandidates: 0, claudeCalls: 0, newMoves: 0, updatedMoves: 0, remaining: 0 };
  try {
    const roster = (await getRoster()).coaches;
    const idx = buildNameIndex(roster);
    const seen = await getJSON("seen", {});
    // Leftovers from an earlier run that ran out of time are read first, then fresh headlines.
    const backlog = await getJSON("backlog", []);
    // Follow-up runs only work through the backlog; the first run of a scan collects fresh headlines.
    const all = chain ? [] : await collect(log, roster, meta);
    if (!chain) await setMeta({ ...(await getMeta()), nameCursor: meta.nameCursor, scanning: meta.scanning });
    log.collected = all.length;
    const keys = new Set();
    const fresh = [...backlog, ...all].filter((it) => !seen[it.key] && !keys.has(it.key) && keys.add(it.key));
    log.newItems = fresh.length;
    const relevant = fresh.filter((it) => MOVE_WORDS.test(it.title + " " + it.text));
    log.relevant = relevant.length;

    meta.scanning.stage = `Reading ${relevant.length} articles`; await setMeta(meta);
    let moves = await getMoves();
    const now = new Date().toISOString();
    let saving = Promise.resolve();
    const checkpoint = () => (saving = saving.then(() => Promise.all([setMoves(moves), setJSON("seen", seen)])).catch((e) => log.errors.push("Save: " + e.message)));

    let i = 0, stopped = false;
    const worker = async () => {
      while (i < relevant.length && !stopped) {
        if (Date.now() - t0 > TIME_BUDGET_MS) { stopped = true; break; }
        const it = relevant[i++];
        try {
          if (it.needsBody) {
            const a = parseScoopArticle(await get(it.url));
            it.title = a.title || it.title; it.text = a.text || it.text; it.date = a.date || it.date; it.needsBody = false;
          }
          const cands = findCandidates(it.title + "\n" + it.text, idx);
          if (!cands.length) { seen[it.key] = now; continue; }
          log.withCandidates++;
          log.claudeCalls++;
          const found = await extractMoves(it, cands);
          for (const raw of found) {
            const coach = cands.find((c) => c.row === Number(raw.row));
            if (!coach) continue;
            const r = mergeMove(moves, raw, coach, it, now);
            if (r === "new") log.newMoves++; else if (r === "merged") log.updatedMoves++; else log.skippedOld = (log.skippedOld || 0) + 1;
          }
          seen[it.key] = now;
          if (log.claudeCalls % SAVE_EVERY === 0) checkpoint();
        } catch (e) {
          log.errors.push(`${it.title.slice(0, 60)}: ${e.message}`);
          if (/API_KEY|Claude API 40[13]/.test(e.message)) { stopped = true; }
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await saving;

    // Irrelevant headlines are marked seen; unread relevant ones become the backlog for the next run.
    for (const it of fresh) if (!relevant.includes(it)) seen[it.key] = now;
    const left = relevant.filter((it) => !seen[it.key]).slice(0, 2000)
      .map(({ url, title, source, date, text, needsBody, key }) => ({ url, title, source, date, text: (text || "").slice(0, 30000), needsBody, key }));
    log.remaining = left.length;
    const cutoff = Date.now() - 60 * 864e5;
    for (const k of Object.keys(seen)) if (Date.parse(seen[k]) < cutoff) delete seen[k];
    moves = cleanMoves(moves, roster);
    await Promise.all([setJSON("seen", seen), setMoves(moves), setJSON("backlog", left)]);
  } catch (e) {
    log.errors.push(e.message);
  }
  log.finishedAt = new Date().toISOString();
  log.errors = log.errors.slice(0, 40);
  const m2 = await getMeta();
  delete m2.scanning;
  if (meta.nameCursor !== undefined) m2.nameCursor = meta.nameCursor;
  m2.lastScan = log;
  m2.runs = [log, ...(m2.runs || [])].slice(0, 50);
  await setMeta(m2);
  log.continue = log.remaining > 0 && chain < MAX_CHAIN && !log.errors.some((e) => /API_KEY|Claude API 40[13]/.test(e));
  return log;
}
