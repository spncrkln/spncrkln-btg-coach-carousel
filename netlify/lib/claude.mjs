// Claude reads one article and reports moves for the roster coaches it mentions.

export const MOVE_TYPES = [
  "Hired", "Promoted", "Title Change", "Interim", "Fired", "Resigned",
  "Retired", "Departed", "Passed Away",
];

const SYSTEM = `You track football coaching staff changes for a documentary research team.
You will get one news article and a short list of CANDIDATE coaches from the team's tracker (each with a tracker row number and their known career history).
Report ONLY job changes for those candidate coaches that the article actually describes. Ignore everyone else.
Do NOT report: coaches merely mentioned as candidates, finalists, interviewees, or "names to watch"; contract extensions; or past jobs mentioned only as career background (e.g. "Kiffin, who left Ole Miss for LSU last year").
Each real change should be reported ONCE per coach per article, using the single best move_type.

Rules:
- Use the career history to decide whether the person in the article is the same person as the candidate. A same-name player, athletic director, or unrelated person is NOT a match.
- move_type must be one of: ${MOVE_TYPES.join(", ")}.
  Hired = takes a new job at a new school/team. Promoted = moves up at the same school/team. Title Change = lateral change at the same place.
  Interim = named interim. Fired = fired/dismissed/"parted ways" by employer. Resigned = left by choice with no new job named.
  Retired = retiring. Departed = leaving, reason unclear (never use Departed if Fired/Resigned/Retired fits). Passed Away = died.
- certainty: "official" (school/team announced or confirmed), "reported" (credible media report), "rumored" (speculation, "expected to", candidate lists).
- Team names: plain school or pro team name, e.g. "Florida State", "Ole Miss", "Pittsburgh Steelers", "Toronto Argonauts". Use null if unknown.
- Titles: the job title as written, e.g. "Defensive Coordinator/Linebackers". Use null if unknown.
- effective_date: YYYY-MM-DD of when the change actually HAPPENED. If the article is recapping an older move, use that older date (estimate the month if needed), not the article date.
- is_new_development: true only if the change is the article's news (it just happened, or is being announced/reported now). false if the article only references it as history/background.
- summary: one plain sentence in your own words describing the move.
- match_confidence: "high", "medium" or "low", with match_reason citing what in the history lines up (or what's uncertain).

Respond with ONLY a JSON array (no prose, no code fences). Return [] if none of the candidates changed jobs in this article.
Each element: {"row":number,"coach_name":string,"move_type":string,"certainty":string,"from_team":string|null,"from_title":string|null,"to_team":string|null,"to_title":string|null,"effective_date":string|null,"is_new_development":boolean,"summary":string,"match_confidence":string,"match_reason":string}`;

function profile(c) {
  const parts = [`Row ${c.row}: ${c.first} ${c.last}`];
  if (c.current) parts.push(`current team: ${c.current}`);
  if (c.title) parts.push(`most recent title: ${c.title}`);
  if (c.colleges) parts.push(`colleges coached: ${c.colleges}`);
  if (c.nflTeams) parts.push(`NFL teams: ${c.nflTeams}`);
  if (c.alma) parts.push(`alma mater: ${c.alma}`);
  if (c.years) parts.push(`years coaching: ${c.years}`);
  return parts.join(" | ");
}

export async function extractMoves(article, candidates) {
  const key = process.env.BTG_CAROUSEL_ANTHROPIC_API_KEY;
  if (!key) throw new Error("BTG_CAROUSEL_ANTHROPIC_API_KEY is not set");
  const model = process.env.BTG_CAROUSEL_MODEL || "claude-sonnet-5-5";
  const user = `ARTICLE
Source: ${article.source}
Date: ${article.date || "unknown"}
Title: ${article.title}
URL: ${article.url}
Text:
${(article.text || article.title).slice(0, 30000)}

CANDIDATE COACHES
${candidates.map(profile).join("\n")}`;

  // Generous per-call timeout, with retries on rate limits, overloads, and network hiccups.
  let data, lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 180000);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ctl.signal,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 8000, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      });
      if (res.ok) { data = await res.json(); break; }
      const body = (await res.text()).slice(0, 300);
      lastErr = new Error(`Claude API ${res.status}: ${body}`);
      if (![408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) throw lastErr; // bad key, bad request: don't retry
      const ra = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, (ra > 0 ? ra * 1000 : 0) || 4000 * 2 ** attempt));
    } catch (e) {
      if (e === lastErr) throw e;
      lastErr = e.name === "AbortError" ? new Error("Claude API call timed out after 3 min") : e;
      await new Promise((r) => setTimeout(r, 4000 * 2 ** attempt));
    } finally { clearTimeout(t); }
  }
  if (!data) throw lastErr || new Error("Claude API failed");
  const text = (data.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  const rows = new Set(candidates.map((c) => c.row));
  return arr.filter((x) => x && rows.has(Number(x.row)) && MOVE_TYPES.includes(x.move_type));
}
