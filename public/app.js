/* BTG Coach Carousel — dashboard */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const TYPE_COLOR = {
  Hired: "--hired", Promoted: "--promoted", "Title Change": "--title", Interim: "--interim", Fired: "--fired",
  Resigned: "--resigned", Retired: "--retired", Departed: "--departed", "Passed Away": "--passed",
};
const cvar = (t) => `var(${TYPE_COLOR[t] || "--muted"})`;

const S = {
  moves: [], meta: {}, roster: { coaches: [] }, types: [], teams: null,
  q: "", typeOn: new Set(), level: "", status: "active", sort: "date-desc",
  view: localGet("view") || "cards",
};
function localGet(k) { try { return localStorage.getItem("btgcc:" + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem("btgcc:" + k, v); } catch {} }

/* ---------- team logos ---------- */
const norm = (s) => " " + String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/&amp;|&/g, " and ").replace(/[’'`ʻ‘]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " ";
const ALIAS = {
  "unc": "north carolina", "north carolina state": "nc state", "pitt": "pittsburgh", "southern california": "usc",
  "miami fl": "miami", "miami florida": "miami", "miami ohio": "miami oh", "connecticut": "uconn", "umass": "massachusetts",
  "fiu": "florida international", "fau": "florida atlantic", "central florida": "ucf", "louisiana state": "lsu",
  "brigham young": "byu", "texas christian": "tcu", "southern methodist": "smu", "army west point": "army",
  "west point": "army", "naval academy": "navy", "wvu": "west virginia", "ole miss": "ole miss", "mississippi": "ole miss",
  "louisiana lafayette": "louisiana", "ul lafayette": "louisiana", "louisiana monroe": "ul monroe", "ulm": "ul monroe",
  "southern mississippi": "southern miss", "app state": "appalachian state", "sam houston state": "sam houston",
  "cal": "california", "cal berkeley": "california", "berkeley": "california", "uc berkeley": "california",
  "virginia military institute": "vmi", "north carolina central": "nc central", "nccu": "nc central",
  "north carolina a and t": "north carolina a and t", "nc a and t": "north carolina a and t", "ut martin": "ut martin",
  "tennessee martin": "ut martin", "uta": "ut arlington", "utep": "utep", "uab": "uab", "utsa": "utsa", "unlv": "unlv",
  "nevada las vegas": "unlv", "hawaii": "hawaii", "texas am": "texas a and m", "tamu": "texas a and m",
  "penn st": "penn state", "ohio st": "ohio state", "virginia tech hokies": "virginia tech",
  "oak": "las vegas raiders", "oakland raiders": "las vegas raiders", "sd": "los angeles chargers", "san diego chargers": "los angeles chargers",
  "stl": "los angeles rams", "st louis rams": "los angeles rams", "was": "washington commanders", "redskins": "washington commanders",
  "washington redskins": "washington commanders", "washington football team": "washington commanders", "jac": "jax",
  "arz": "ari", "houston oilers": "tennessee titans", "baltimore colts": "indianapolis colts",
};
let TEAM_MAP = null;
function buildTeamMap(teams) {
  const rank = { NFL: 4, FBS: 3, FCS: 2, Other: 1 };
  const m = new Map();
  for (const t of teams) for (const n of t.names) {
    const k = norm(n).trim(); if (!k) continue;
    const ex = m.get(k);
    if (!ex || rank[t.div] > rank[ex.div]) m.set(k, t);
  }
  TEAM_MAP = m;
}
const teamCache = new Map();
function findTeam(name) {
  if (!name || !TEAM_MAP) return null;
  if (teamCache.has(name)) return teamCache.get(name);
  const base = norm(name.replace(/\(([^)]*)\)/g, " $1 ")).trim();
  const tries = [base, ALIAS[base]];
  let s = base.replace(/\b(the|university|univ|of|college)\b/g, " ").replace(/\s+/g, " ").trim();
  tries.push(s, ALIAS[s]);
  if (/^st /.test(s)) tries.push(s.replace(/^st /, "saint "), s.replace(/^st /, "st "));
  if (/ st$/.test(s)) tries.push(s.replace(/ st$/, " state"));
  tries.push(base.split(" ").slice(0, -1).join(" ")); // drop a trailing nickname like "Florida State Seminoles"
  let hit = null;
  for (const k of tries) if (k && TEAM_MAP.has(k)) { hit = TEAM_MAP.get(k); break; }
  teamCache.set(name, hit);
  return hit;
}
function hashColor(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return `hsl(${Math.abs(h) % 360} 35% 38%)`; }
function initials(s) {
  const w = String(s).replace(/\(.*?\)/g, "").split(/[\s/-]+/).filter((x) => x && !/^(of|the|and|&|university|college)$/i.test(x));
  return (w.length === 1 ? w[0].slice(0, 3) : w.slice(0, 3).map((x) => x[0]).join("")).toUpperCase();
}
function logo(name, cls = "logo") {
  if (!name) return `<div class="mono none">${cls === "logo" ? "No team" : "—"}</div>`;
  const t = findTeam(name);
  const isDark = matchMedia("(prefers-color-scheme: dark)").matches;
  if (t && t.logo) {
    const src = isDark && t.dark ? t.dark : t.logo;
    return cls === "logo"
      ? `<div class="logo"><img src="${esc(src)}" alt="${esc(t.label)}" loading="lazy" onerror="this.parentNode.outerHTML='${esc(monoHtml(name, t.color))}'"></div>`
      : `<img src="${esc(src)}" alt="" loading="lazy">`;
  }
  return monoHtml(name, t?.color);
}
function monoHtml(name, color) { return `<div class="mono" style="background:${color || hashColor(name)}">${esc(initials(name))}</div>`; }
function levelOf(m) {
  const t = findTeam(m.to_team) || findTeam(m.from_team);
  return t ? t.div : "Other";
}

/* ---------- data ---------- */
async function api(path, opts = {}) {
  const r = await fetch("/api/" + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
async function load() {
  const st = await api("state");
  S.moves = st.moves; S.meta = st.meta || {}; S.roster = st.roster; S.types = st.moveTypes; S.sources = st.sources; S.hasKey = st.hasKey;
  S.byRow = new Map(S.roster.coaches.map((c) => [c.row, c]));
  render();
  return st;
}
async function loadTeams() {
  try { const t = await api("teams"); S.teams = t.teams; buildTeamMap(t.teams); teamCache.clear(); render(); }
  catch (e) { console.warn("Logos unavailable:", e.message); }
}

/* ---------- filtering / sorting ---------- */
function filtered() {
  const q = norm(S.q).trim();
  let list = S.moves.filter((m) => {
    if (S.status === "active" && m.status === "dismissed") return false;
    if (S.status && S.status !== "active" && m.status !== S.status) return false;
    if (S.typeOn.size && !S.typeOn.has(m.move_type)) return false;
    if (S.level && levelOf(m) !== S.level) return false;
    if (q) {
      if (/^\d+$/.test(q)) return String(m.row) === q;
      const hay = norm([m.coach_name, m.from_team, m.to_team, m.from_title, m.to_title, m.summary, m.move_type].join(" "));
      if (!q.split(" ").every((w) => hay.includes(" " + w) )) return false;
    }
    return true;
  });
  const [key, dir] = S.sort.split("-");
  const sgn = dir === "asc" ? 1 : -1;
  const val = {
    date: (m) => m.effective_date || m.found_at || "", name: (m) => (m.coach_name || "").split(" ").slice(-1)[0] + " " + m.coach_name,
    row: (m) => m.row ?? 1e9, from: (m) => m.from_team || "~", to: (m) => m.to_team || "~", type: (m) => m.move_type,
    title: (m) => m.to_title || m.from_title || "~",
  }[key];
  list.sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return c * sgn || String(b.found_at).localeCompare(String(a.found_at));
  });
  return list;
}

/* ---------- render ---------- */
const fmtDate = (d) => { if (!d) return ""; const x = new Date(d.length === 10 ? d + "T12:00:00" : d); return x.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };
const fmtTime = (d) => new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function nextScheduled() { const d = new Date(); d.setUTCMinutes(0, 0, 0); d.setUTCHours(Math.floor(d.getUTCHours() / 4) * 4 + 4); return d; }

function render() {
  renderHeader(); renderStats(); renderChips(); renderList(); renderLog();
}
function renderHeader() {
  const r = S.roster;
  $("#rosterLine").innerHTML = `Watching <b>${r.count?.toLocaleString() || 0}</b> coaches from <b>${esc(r.source)}</b> · tracker updated ${fmtDate(r.updatedAt)}`;
  const sc = S.meta.scanning, last = S.meta.lastScan;
  let html = "";
  if (sc) html = `<span class="live">Scanning…</span> ${esc(sc.stage || "")}`;
  else if (last) html = `Last scan ${fmtTime(last.finishedAt || last.startedAt)} · ${last.newMoves} new<br>Next auto scan ~${fmtTime(nextScheduled())}`;
  else html = `No scans yet<br>Next auto scan ~${fmtTime(nextScheduled())}`;
  $("#scanStatus").innerHTML = html;
  $("#scanBtn").disabled = !!sc;
  const b = $("#banner");
  if (S.hasKey === false) { b.hidden = false; b.innerHTML = `<b>Almost ready.</b> Add <code>BTG_CAROUSEL_ANTHROPIC_API_KEY</code> in Netlify → Site configuration → Environment variables, then redeploy. Scans can't read articles until it's set.`; }
  else b.hidden = true;
}
function renderStats() {
  const act = S.moves.filter((m) => m.status !== "dismissed");
  const week = Date.now() - 7 * 864e5;
  const c = (f) => act.filter(f).length;
  const items = [
    ["Moves tracked", act.length, () => { S.typeOn.clear(); S.status = "active"; }],
    ["Last 7 days", c((m) => Date.parse(m.found_at) > week), () => { S.sort = "date-desc"; }],
    ["Needs review", c((m) => m.status === "new"), () => { S.status = "new"; }],
    ["Hired", c((m) => m.move_type === "Hired"), () => { S.typeOn = new Set(["Hired"]); }],
    ["Fired / out", c((m) => ["Fired", "Resigned", "Departed"].includes(m.move_type)), () => { S.typeOn = new Set(["Fired", "Resigned", "Departed"]); }],
    ["Coaches moved", new Set(act.map((m) => m.row || m.coach_name)).size, null],
  ];
  $("#stats").innerHTML = items.map(([l, v], i) => `<div class="stat" data-i="${i}"><b>${v}</b><span>${l}</span></div>`).join("");
  $("#stats").querySelectorAll(".stat").forEach((el) => el.onclick = () => { const f = items[el.dataset.i][2]; if (f) { f(); syncControls(); render(); } });
}
function renderChips() {
  $("#typeChips").innerHTML = S.types.map((t) => `<button class="chip ${S.typeOn.has(t) ? "on" : ""}" data-t="${esc(t)}"><i style="background:${cvar(t)}"></i>${esc(t)}</button>`).join("");
  $("#typeChips").querySelectorAll(".chip").forEach((el) => el.onclick = () => { const t = el.dataset.t; S.typeOn.has(t) ? S.typeOn.delete(t) : S.typeOn.add(t); render(); });
}
const ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M13 6l6 6-6 6"/></svg>`;
const srcA = (s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener"><em>${esc(s.source || "Source")}</em><span>${esc(s.title || s.url)}</span></a>`;
function srcLinks(m) {
  const all = m.sources || [];
  if (!all.length) return `<span class="ttl">No source link</span>`;
  const shown = all.slice(0, 2).map(srcA).join("");
  const total = Math.max(m.source_count || 0, all.length);
  if (all.length <= 2) return shown;
  return `${shown}<details class="more"><summary>+ ${total - 2} more source${total - 2 === 1 ? "" : "s"}</summary>${all.slice(2).map(srcA).join("")}${total > all.length ? `<span class="ttl">Showing the first ${all.length} of ${total}.</span>` : ""}</details>`;
}
function card(m) {
  const toLabel = m.to_team || ({ Retired: "Retired", Fired: "Out", Resigned: "Out", Departed: "Out", "Passed Away": "In memoriam" }[m.move_type] || "TBD");
  const toLogo = m.to_team ? logo(m.to_team) : `<div class="mono none">—</div>`;
  const tracker = m.row && S.byRow.get(m.row);
  return `<article class="card ${m.status}" style="--c:${cvar(m.move_type)}">
    <div class="bar"></div>
    <div class="head">
      <div><button class="coach" data-row="${m.row ?? ""}" data-name="${esc(m.coach_name)}">${esc(m.coach_name)}</button>
        <div class="rowtag">${m.row ? `Tracker <b>row ${m.row}</b>` : "Not linked to a row"}${tracker?.current ? ` · listed at ${esc(tracker.current)}` : ""}</div></div>
      <div class="badges"><span class="type">${esc(m.move_type)}</span><span class="cert ${esc(m.certainty)}">${esc(m.certainty)}</span></div>
    </div>
    <div class="flow">
      <div class="side">${logo(m.from_team)}<div class="team">${esc(m.from_team || "Unknown")}</div><div class="ttl">${esc(m.from_title || "")}</div></div>
      <div class="arrow">${ARROW}</div>
      <div class="side">${toLogo}<div class="team">${esc(m.to_team || toLabel)}</div><div class="ttl">${esc(m.to_title || "")}</div></div>
    </div>
    ${m.summary ? `<div class="summary">${esc(m.summary)}</div>` : ""}
    ${m.origin === "scan" ? `<div class="match"><span class="lvl ${esc(m.match_confidence)}">${esc(m.match_confidence)} match</span> · ${esc(m.match_reason)}</div>` : ""}
    <div class="srcs">${srcLinks(m)}</div>
    <div class="foot"><span>${fmtDate(m.effective_date)}${m.status === "confirmed" ? " · ✓ Confirmed" : m.status === "new" ? " · Needs review" : " · Dismissed"}</span>
      <span class="btns">${m.status !== "confirmed" ? `<button class="btn small" data-act="confirmed" data-id="${m.id}">Confirm</button>` : ""}
      ${m.status !== "dismissed" ? `<button class="btn small" data-act="dismissed" data-id="${m.id}" title="Wrong person or not a real move">Dismiss</button>` : `<button class="btn small" data-act="new" data-id="${m.id}">Restore</button>`}
      <button class="btn small" data-act="delete" data-id="${m.id}" title="Delete">✕</button></span></div>
  </article>`;
}
function table(list) {
  const cols = [["name", "Coach"], ["row", "Row"], ["type", "Move"], ["from", "From"], ["to", "To"], ["title", "New title"], ["date", "Date"]];
  const [k, d] = S.sort.split("-");
  const mini = (n) => n ? `<div class="mini">${logo(n, "mini")}<span>${esc(n)}</span></div>` : "—";
  return `<div class="tablewrap"><table><thead><tr>${cols.map(([c, l]) => `<th data-sort="${c}" class="${k === c ? "sorted " + d : ""}">${l}</th>`).join("")}<th>Source</th><th>Status</th></tr></thead><tbody>
  ${list.map((m) => `<tr class="${m.status}" style="--c:${cvar(m.move_type)}">
    <td><a href="#" class="coachlink" data-row="${m.row ?? ""}" data-name="${esc(m.coach_name)}"><b>${esc(m.coach_name)}</b></a></td>
    <td>${m.row ?? "—"}</td><td><span class="pill">${esc(m.move_type)}</span><br><small>${esc(m.certainty)}</small></td>
    <td>${mini(m.from_team)}<small>${esc(m.from_title || "")}</small></td><td>${mini(m.to_team)}</td>
    <td>${esc(m.to_title || "")}</td><td>${fmtDate(m.effective_date)}</td>
    <td>${(m.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.source || "link")}</a>`).join("<br>")}</td>
    <td>${m.status === "new" ? `<button class="btn small" data-act="confirmed" data-id="${m.id}">Confirm</button>` : esc(m.status)}</td></tr>`).join("")}
  </tbody></table></div>`;
}
function renderList() {
  const list = filtered();
  const el = $("#list");
  if (!S.moves.length) {
    el.innerHTML = `<div class="empty"><h3>No moves logged yet</h3><p>The first automatic scan runs within four hours, or hit <b>Scan now</b>. Moves show up here as Claude matches news to coaches in your tracker.</p></div>`;
  } else if (!list.length) {
    el.innerHTML = `<div class="empty"><h3>Nothing matches</h3><p>Try clearing the search or filters.</p></div>`;
  } else el.innerHTML = S.view === "table" ? table(list) : `<div class="grid">${list.map(card).join("")}</div>`;
  el.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => act(b.dataset.id, b.dataset.act));
  el.querySelectorAll(".coach, .coachlink").forEach((b) => b.onclick = (e) => { e.preventDefault(); openCoach(b.dataset.row, b.dataset.name); });
  el.querySelectorAll("th[data-sort]").forEach((th) => th.onclick = () => {
    const [k, d] = S.sort.split("-"); const c = th.dataset.sort;
    S.sort = `${c}-${k === c && d === "asc" ? "desc" : "asc"}`; syncControls(); renderList();
  });
}
function renderLog() {
  const runs = S.meta.runs || [];
  const srcs = S.sources || { footballscoop: [], feeds: [] };
  $("#logBody").innerHTML = `
    <p>Scans run automatically about every 4 hours. There's no cap on how many articles Claude reads: if one run can't finish within Netlify's 15-minute limit, it saves its progress and starts a follow-up run. Each one reads FootballScoop's homepage and Jobs Scoop pages, ESPN's college and NFL feeds, and Google News searches covering 247Sports, On3, school press releases, NFL and CFL staff news. Only articles that mention a coach from your tracker by name are sent to Claude.</p>
    <ul>${[...srcs.footballscoop.map((u) => "FootballScoop · " + u.replace("https://www.footballscoop.com", "")), ...srcs.feeds].map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
    ${runs[0]?.nameSearch ? `<p>${esc(runs[0].nameSearch)}. Every coach in the tracker is also searched by name on a rotating basis, so a full pass of all ${S.roster.count?.toLocaleString() || ""} names takes about three scans.${runs[0].skippedOld ? ` Last scan skipped ${runs[0].skippedOld} move(s) your tracker already reflects.` : ""}</p>` : ""}
    ${runs.length ? `<table><thead><tr><th>Started</th><th>Trigger</th><th>Headlines</th><th>New</th><th>Coaching</th><th>Tracker names</th><th>Claude reads</th><th>New moves</th><th>Carried to next run</th><th>Issues</th></tr></thead><tbody>
    ${runs.map((r) => `<tr><td>${fmtTime(r.startedAt)}</td><td>${esc(r.trigger)}${r.chain ? ` (part ${r.chain + 1})` : ""}</td><td>${r.collected}</td><td>${r.newItems}</td><td>${r.relevant}</td><td>${r.withCandidates}</td><td>${r.claudeCalls}</td><td>${r.newMoves}</td><td>${r.remaining ?? 0}</td>
    <td>${r.errors?.length ? `<details><summary>${r.errors.length}</summary>${r.errors.map((e) => `<div>${esc(e)}</div>`).join("")}</details>` : "—"}</td></tr>`).join("")}</tbody></table>` : "<p>No scans have run yet.</p>"}`;
}

/* ---------- coach dialog ---------- */
function openCoach(row, name) {
  const c = row ? S.byRow.get(Number(row)) : null;
  const moves = S.moves.filter((m) => (row && m.row === Number(row)) || (!row && m.coach_name === name))
    .sort((a, b) => String(b.effective_date).localeCompare(String(a.effective_date)));
  const kv = c ? [["Tracker row", c.row], ["Listed current team", c.current || "None"], ["Most recent title", c.title], ["Colleges coached", c.colleges], ["NFL teams", c.nflTeams], ["Years coaching", c.years], ["Alma mater", c.alma]]
    .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("") : "<dt>Tracker</dt><dd>Not linked to a row</dd>";
  $("#coachBody").innerHTML = `<button class="close" onclick="this.closest('dialog').close()">×</button>
    <h2>${esc(c ? `${c.first} ${c.last}` : name)}</h2><dl class="kv">${kv}</dl>
    <h3>Moves logged (${moves.length})</h3>
    <div class="timeline">${moves.map((m) => `<div style="--c:${cvar(m.move_type)}"><b>${esc(m.move_type)}</b> · ${esc(m.from_team || "?")} → ${esc(m.to_team || "—")}${m.to_title ? `, ${esc(m.to_title)}` : ""}
      <small>${fmtDate(m.effective_date)} · ${esc(m.certainty)} · ${(m.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.source)}</a>`).join(", ")}</small></div>`).join("") || "<div>None yet.</div>"}</div>`;
  $("#coachDlg").showModal();
}
$("#coachDlg").addEventListener("click", (e) => { if (e.target.id === "coachDlg") e.target.close(); });

/* ---------- actions ---------- */
async function act(id, a) {
  try {
    if (a === "delete") { if (!confirm("Delete this move permanently?")) return; await api("moves/" + id, { method: "DELETE" }); S.moves = S.moves.filter((m) => m.id !== id); }
    else { await api("moves/" + id, { method: "PATCH", body: JSON.stringify({ status: a }) }); S.moves.find((m) => m.id === id).status = a; }
    render();
  } catch (e) { alert(e.message); }
}

let pollTimer = null;
function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => { const st = await load().catch(() => null); if (st?.meta?.scanning) poll(); }, 6000);
}
$("#scanBtn").onclick = async () => {
  const b = $("#scanBtn"); b.disabled = true;
  try {
    const r = await api("scan", { method: "POST" });
    $("#scanStatus").innerHTML = r.ok ? `<span class="live">Scan started…</span>` : esc(r.message);
    if (r.ok) { setTimeout(() => load().then(poll), 2500); } else b.disabled = false;
  } catch (e) { $("#scanStatus").textContent = e.message; b.disabled = false; }
};

/* ---------- xlsx upload (parsed in the browser; contact info never leaves your computer) ---------- */
$("#xlsxInput").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const lbl = $("#uploadLbl"); const old = lbl.firstChild.textContent; lbl.firstChild.textContent = "Reading…";
  try {
    const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
    const name = wb.SheetNames.find((n) => n.trim().toLowerCase() === "coaches");
    if (!name) throw new Error("Couldn't find a tab named Coaches in that file.");
    const ws = wb.Sheets[name]; const rng = XLSX.utils.decode_range(ws["!ref"]);
    const cell = (r, c) => { const v = ws[XLSX.utils.encode_cell({ r, c })]; const s = v ? String(v.w ?? v.v ?? "").trim() : ""; return /^(none|n\/a)$/i.test(s) ? "" : s; };
    const coaches = [];
    for (let r = 3; r <= rng.e.r; r++) { // Excel row 4 = index 3
      const first = cell(r, 0), last = cell(r, 1);
      if (!first && !last) continue;
      coaches.push({ row: r + 1, first, last, alma: cell(r, 4), current: cell(r, 5), colleges: cell(r, 7), title: cell(r, 8), years: cell(r, 10), nfl: cell(r, 11).toUpperCase() === "Y", nflTeams: cell(r, 12), nflYears: cell(r, 13) });
    }
    const res = await api("roster", { method: "POST", body: JSON.stringify({ fileName: f.name, coaches }) });
    await load();
    alert(`Tracker updated: ${res.count.toLocaleString()} coaches loaded from the Coaches tab. Row numbers now match ${f.name}.`);
  } catch (err) { alert(err.message); }
  lbl.firstChild.textContent = old; e.target.value = "";
};

/* ---------- manual add ---------- */
$("#addBtn").onclick = () => {
  $("#addType").innerHTML = S.types.map((t) => `<option>${esc(t)}</option>`).join("");
  $("#coachList").innerHTML = S.roster.coaches.filter((c) => c.first && c.last).map((c) => `<option value="${esc(c.first + " " + c.last)}">Row ${c.row} · ${esc(c.current || "no team")}</option>`).join("");
  $("#addForm").reset(); $("#addForm").effective_date.value = new Date().toISOString().slice(0, 10);
  $("#addDlg").showModal();
};
$("#addForm").coach_name.addEventListener("change", (e) => {
  const v = norm(e.target.value);
  const c = S.roster.coaches.find((x) => norm(x.first + " " + x.last) === v);
  if (c) { const f = $("#addForm"); f.row.value = c.row; if (!f.from_team.value) f.from_team.value = c.current; if (!f.from_title.value) f.from_title.value = c.title; }
});
$("#addForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try { await api("moves", { method: "POST", body: JSON.stringify(body) }); $("#addDlg").close(); await load(); }
  catch (err) { alert(err.message); }
});

/* ---------- controls ---------- */
function syncControls() {
  $("#q").value = S.q; $("#level").value = S.level; $("#status").value = S.status; $("#sort").value = S.sort;
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.view === S.view));
}
$("#q").oninput = (e) => { S.q = e.target.value; renderList(); };
$("#level").onchange = (e) => { S.level = e.target.value; renderList(); };
$("#status").onchange = (e) => { S.status = e.target.value; renderList(); };
$("#sort").onchange = (e) => { S.sort = e.target.value; renderList(); };
document.querySelectorAll(".seg button").forEach((b) => b.onclick = () => { S.view = b.dataset.view; localSet("view", S.view); syncControls(); renderList(); });

syncControls();
load().then((st) => { if (st.meta?.scanning) poll(); }).catch((e) => { $("#list").innerHTML = `<div class="empty"><h3>Couldn't load</h3><p>${esc(e.message)}</p></div>`; });
loadTeams();
