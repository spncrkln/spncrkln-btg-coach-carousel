import { SCOOP_PAGES, RSS_FEEDS, MOVE_WORDS } from "./sources.mjs";
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

export function parseRss(xml, feedName) {
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const it = m[0];
    let title = strip(tag(it, "title"));
    const link = tag(it, "link") || (it.match(/<guid[^>]*>([^<]+)</i) || [])[1] || "";
    const src = strip(tag(it, "source"));
    if (src && title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
    const pub = tag(it, "pubDate");
    items.push({
      url: link.trim(), title, source: src || feedName,
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

const keyFor = (it) => it.url.includes("news.google.com") ? "t:" + norm(it.title).trim() : "u:" + it.url;

export async function collect(log) {
  const items = [];
  const tasks = [
    ...SCOOP_PAGES.map(async (u) => { const h = await get(u); const r = parseScoopListing(h); log.sources[`FootballScoop ${u.replace("https://www.footballscoop.com", "") || "/"}`] = r.length; items.push(...r); }),
    ...RSS_FEEDS.map(async (f) => { const x = await get(f.url); const r = parseRss(x, f.name); log.sources[f.name] = r.length; items.push(...r); }),
  ];
  const results = await Promise.allSettled(tasks);
  results.forEach((r, i) => { if (r.status === "rejected") log.errors.push(`Source ${i + 1}: ${r.reason?.message || r.reason}`); });
  const uniq = new Map();
  for (const it of items) { if (!it.url) continue; const k = keyFor(it); if (!uniq.has(k)) uniq.set(k, { ...it, key: k }); }
  return [...uniq.values()];
}

function moveId(m) {
  const base = [m.row, m.move_type, norm(m.to_team || "").trim(), norm(m.from_team || "").trim()].join("|");
  let h = 0; for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0;
  return "m" + (h >>> 0).toString(36);
}
const CERT_RANK = { rumored: 0, reported: 1, official: 2 };
const CONF_RANK = { low: 0, medium: 1, high: 2 };

export function mergeMove(moves, raw, coach, article, now) {
  const m = {
    row: coach.row, coach_name: `${coach.first} ${coach.last}`.trim(),
    move_type: raw.move_type, certainty: raw.certainty || "reported",
    from_team: raw.from_team || (["Hired", "Fired", "Resigned", "Retired", "Departed", "Passed Away"].includes(raw.move_type) ? coach.current || null : null),
    from_title: raw.from_title || null, to_team: raw.to_team || null, to_title: raw.to_title || null,
    effective_date: raw.effective_date || article.date || now.slice(0, 10),
    summary: raw.summary || "", match_confidence: raw.match_confidence || "medium", match_reason: raw.match_reason || "",
  };
  if (["Promoted", "Title Change", "Interim"].includes(m.move_type) && !m.to_team) m.to_team = m.from_team || coach.current || null;
  const id = moveId(m);
  const src = { url: article.url, title: article.title, source: article.source, date: article.date };
  const ex = moves.find((x) => x.id === id);
  if (ex) {
    if (!ex.sources.some((s) => s.url === src.url)) ex.sources.push(src);
    if ((CERT_RANK[m.certainty] ?? 1) > (CERT_RANK[ex.certainty] ?? 1)) ex.certainty = m.certainty;
    if ((CONF_RANK[m.match_confidence] ?? 1) > (CONF_RANK[ex.match_confidence] ?? 1)) { ex.match_confidence = m.match_confidence; ex.match_reason = m.match_reason; }
    for (const k of ["from_title", "to_title", "from_team", "to_team"]) if (!ex[k] && m[k]) ex[k] = m[k];
    ex.updated_at = now;
    return false;
  }
  moves.push({ id, ...m, status: "new", origin: "scan", sources: [src], found_at: now, updated_at: now });
  return true;
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
    const all = await collect(log);
    log.collected = all.length;
    const keys = new Set();
    const fresh = [...backlog, ...all].filter((it) => !seen[it.key] && !keys.has(it.key) && keys.add(it.key));
    log.newItems = fresh.length;
    const relevant = fresh.filter((it) => MOVE_WORDS.test(it.title + " " + it.text));
    log.relevant = relevant.length;

    meta.scanning.stage = `Reading ${relevant.length} articles`; await setMeta(meta);
    const moves = await getMoves();
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
            if (mergeMove(moves, raw, coach, it, now)) log.newMoves++; else log.updatedMoves++;
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
    await Promise.all([setJSON("seen", seen), setMoves(moves), setJSON("backlog", left)]);
  } catch (e) {
    log.errors.push(e.message);
  }
  log.finishedAt = new Date().toISOString();
  log.errors = log.errors.slice(0, 40);
  const m2 = await getMeta();
  delete m2.scanning;
  m2.lastScan = log;
  m2.runs = [log, ...(m2.runs || [])].slice(0, 50);
  await setMeta(m2);
  log.continue = log.remaining > 0 && chain < MAX_CHAIN && !log.errors.some((e) => /API_KEY|Claude API 40[13]/.test(e));
  return log;
}
