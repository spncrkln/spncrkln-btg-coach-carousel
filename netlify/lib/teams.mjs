// Team logo directory built from ESPN's public team lists, cached for a week.
import { getJSON, setJSON } from "./store.mjs";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/football";

async function teams(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const j = await r.json();
  return (j.sports?.[0]?.leagues?.[0]?.teams || []).map((x) => x.team);
}

function slim(t, league, div) {
  const logo = (t.logos || []).find((l) => (l.rel || []).includes("default"))?.href || t.logos?.[0]?.href || null;
  const dark = (t.logos || []).find((l) => (l.rel || []).includes("dark"))?.href || null;
  return {
    id: t.id, league, div, logo, dark, color: t.color ? "#" + t.color : null,
    label: league === "NFL" ? t.displayName : t.location || t.shortDisplayName,
    // NFL: skip the bare city ("Pittsburgh") so it never steals a college lookup.
    names: (league === "NFL"
      ? [t.displayName, t.name, t.shortDisplayName, t.abbreviation]
      : [t.location, t.shortDisplayName, t.displayName, t.nickname]).filter(Boolean),
  };
}

export async function getTeams() {
  const cached = await getJSON("teams", null);
  if (cached && Date.now() - Date.parse(cached.builtAt) < 7 * 864e5) return cached;
  const [all, fbs, fcs, nfl] = await Promise.all([
    teams(`${BASE}/college-football/teams?limit=1000`),
    teams(`${BASE}/college-football/teams?groups=80&limit=300`).catch(() => []),
    teams(`${BASE}/college-football/teams?groups=81&limit=300`).catch(() => []),
    teams(`${BASE}/nfl/teams`),
  ]);
  const fbsIds = new Set(fbs.map((t) => t.id)), fcsIds = new Set(fcs.map((t) => t.id));
  const list = [
    ...nfl.map((t) => slim(t, "NFL", "NFL")),
    ...all.filter((t) => t.isActive !== false).map((t) => slim(t, "NCAA", fbsIds.has(t.id) ? "FBS" : fcsIds.has(t.id) ? "FCS" : "Other")),
  ];
  const out = { builtAt: new Date().toISOString(), teams: list };
  await setJSON("teams", out);
  return out;
}
