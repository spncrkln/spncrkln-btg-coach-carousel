import { getRoster, getMoves, setMoves, getMeta, setJSON } from "../lib/store.mjs";
import { getTeams } from "../lib/teams.mjs";
import { MOVE_TYPES } from "../lib/claude.mjs";
import { SCOOP_PAGES, RSS_FEEDS } from "../lib/sources.mjs";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = req.method;
  try {
    if (path === "state" && method === "GET") {
      const [moves, meta, roster] = await Promise.all([getMoves(), getMeta(), getRoster()]);
      return json({
        moves, meta, moveTypes: MOVE_TYPES,
        roster: { updatedAt: roster.updatedAt, source: roster.source, count: roster.coaches.length, coaches: roster.coaches },
        sources: { footballscoop: SCOOP_PAGES, feeds: RSS_FEEDS.map((f) => f.name) },
        hasKey: !!process.env.BTG_CAROUSEL_ANTHROPIC_API_KEY,
      });
    }

    if (path === "teams" && method === "GET") return json(await getTeams());

    if (path === "roster" && method === "POST") {
      const body = await req.json();
      if (!Array.isArray(body.coaches) || body.coaches.length < 10) return json({ error: "No coaches found in that file" }, 400);
      const coaches = body.coaches.map((c) => ({
        row: Number(c.row), first: String(c.first || ""), last: String(c.last || ""), alma: String(c.alma || ""),
        current: String(c.current || ""), colleges: String(c.colleges || ""), title: String(c.title || ""),
        years: String(c.years || ""), nfl: !!c.nfl, nflTeams: String(c.nflTeams || ""), nflYears: String(c.nflYears || ""),
      }));
      await setJSON("roster", { updatedAt: new Date().toISOString(), source: body.fileName || "Uploaded tracker", coaches });
      return json({ ok: true, count: coaches.length });
    }

    if (path === "scan" && method === "POST") {
      const meta = await getMeta();
      if (meta.scanning && Date.now() - Date.parse(meta.scanning.startedAt) < 14.5 * 60e3) return json({ ok: false, message: "A scan is already running." });
      const last = meta.lastScan?.startedAt ? Date.parse(meta.lastScan.startedAt) : 0;
      const wait = Math.ceil((last + 2 * 60e3 - Date.now()) / 60e3);
      if (wait > 0) return json({ ok: false, message: `Last scan was just run. Try again in ${wait} min.` });
      await fetch(`${url.origin}/.netlify/functions/scan-background`, { method: "POST", headers: { "x-scan-trigger": "manual" } });
      return json({ ok: true, message: "Scan started." });
    }

    if (path === "moves" && method === "POST") {
      const b = await req.json();
      if (!b.coach_name || !MOVE_TYPES.includes(b.move_type)) return json({ error: "Coach and move type are required" }, 400);
      const moves = await getMoves();
      const now = new Date().toISOString();
      const m = {
        id: "x" + Date.now().toString(36), row: b.row ? Number(b.row) : null, coach_name: b.coach_name, move_type: b.move_type,
        certainty: b.certainty || "reported", from_team: b.from_team || null, from_title: b.from_title || null,
        to_team: b.to_team || null, to_title: b.to_title || null, effective_date: b.effective_date || now.slice(0, 10),
        summary: b.summary || "", match_confidence: "high", match_reason: "Logged manually",
        status: "confirmed", origin: "manual",
        sources: b.source_url ? [{ url: b.source_url, title: b.source_title || b.source_url, source: b.source_name || "Manual entry", date: b.effective_date || null }] : [],
        found_at: now, updated_at: now,
      };
      moves.push(m);
      await setMoves(moves);
      return json({ ok: true, move: m });
    }

    const mm = path.match(/^moves\/([\w-]+)$/);
    if (mm && (method === "PATCH" || method === "DELETE")) {
      const moves = await getMoves();
      const i = moves.findIndex((x) => x.id === mm[1]);
      if (i < 0) return json({ error: "Move not found" }, 404);
      if (method === "DELETE") moves.splice(i, 1);
      else {
        const b = await req.json();
        const editable = ["status", "row", "coach_name", "move_type", "certainty", "from_team", "from_title", "to_team", "to_title", "effective_date", "summary", "note"];
        for (const k of editable) if (k in b) moves[i][k] = k === "row" && b[k] !== null ? Number(b[k]) : b[k];
        moves[i].updated_at = new Date().toISOString();
      }
      await setMoves(moves);
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};

export const config = { path: "/api/*" };
