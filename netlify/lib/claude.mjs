// Claude reads articles and reports moves for the roster coaches they mention.
// Two passes: extractMoves() reads each article; verifyMove() is a skeptical second read
// that every NEW card must pass before it's created.

export const MOVE_TYPES = [
  "Hired", "Promoted", "Title Change", "Interim", "Fired", "Resigned",
  "Retired", "Departed", "Passed Away",
];

const EXTRACT_SYSTEM = `You track football coaching staff changes for a documentary research team.
You will get one news article and a short list of CANDIDATE coaches from the team's tracker (each with a tracker row number, their known career history, and any moves ALREADY LOGGED for them).
Report ONLY job changes for those candidate coaches that have ACTUALLY HAPPENED or been officially announced/credibly reported as done. Ignore everyone else.

Never report:
- Speculation, predictions, rumors, "hot seat" talk, "could/should/might/expected to/likely to", candidate lists, finalists, interviews, "names to watch", mock hiring lists, or opinion pieces about who a school should hire or fire.
- Contract extensions or raises.
- Past jobs mentioned only as career background (e.g. "Kiffin, who left Ole Miss for LSU last year").
- Moves where the article does not name the coach's specific new school or team. A roundup like "ranking the new coordinators" or "assistants on the move" only counts if it explicitly names where THIS coach went; never use a generic phrase as a team.

Rules:
- Use the career history to decide whether the person in the article is the same person as the candidate. A same-name player, athletic director, or unrelated person is NOT a match.
- move_type must be one of: ${MOVE_TYPES.join(", ")}.
  Hired = takes a new job at a new school/team. Promoted = moves up at the same school/team. Title Change = lateral change at the same place.
  Interim = named interim. Fired = fired/dismissed/"parted ways" by employer. Resigned = left by choice with no new job named.
  Retired = retiring. Departed = leaving, reason unclear (never use Departed if Fired/Resigned/Retired fits). Passed Away = died.
- certainty: "official" (school/team announced or confirmed) or "reported" (a credible outlet reports it as done or agreed, e.g. "X is hiring Y, sources say"). If it is any less certain than that, do not report it at all.
- Team names: the specific school or pro team, e.g. "Florida State", "Ole Miss", "Pittsburgh Steelers", "Toronto Argonauts". Use null only for from_team when unknown.
- Titles: the job title as written, e.g. "Defensive Coordinator/Linebackers". Use null if unknown.
- effective_date: YYYY-MM-DD of when the change actually HAPPENED. If the article is recapping an older move, use that older date (estimate the month if needed), not the article date.
- is_new_development: true only if the change is the article's news (it just happened, or is being announced/reported now). false if the article only references it as history/background.
- same_as: if the move is the SAME real-world event as one listed under "already logged" for that coach (even if worded differently, e.g. "fired" vs "parted ways" vs "out"), put that logged id here. Otherwise null.
- summary: one plain sentence in your own words describing the move.
- match_confidence: "high", "medium" or "low", with match_reason citing what in the history lines up (or what's uncertain).

Respond with ONLY a JSON array (no prose, no code fences). Return [] if none of the candidates changed jobs in this article.
Each element: {"row":number,"coach_name":string,"move_type":string,"certainty":string,"from_team":string|null,"from_title":string|null,"to_team":string|null,"to_title":string|null,"effective_date":string|null,"is_new_development":boolean,"same_as":string|null,"summary":string,"match_confidence":string,"match_reason":string}`;

const VERIFY_SYSTEM = `You are a skeptical fact-checker for a football coaching-move tracker. Another reader proposed that an article reports a coaching move. Your job is to reject anything that is not a real, completed (or officially announced / credibly reported as agreed) job change for this specific coach.

Reject (verdict "reject") if ANY of these are true:
- It is speculation, prediction, rumor, hot-seat talk, a candidate/finalist/interview list, an opinion about who should be hired/fired, or uses language like could/should/might/expected/likely/potential/in the mix.
- The article only mentions the move as background history, not as its news.
- The destination is generic or missing for a Hired move (e.g. "new coordinator", "another program"), or the article never names this coach's specific new team.
- The person in the article is probably not the same coach as the tracker profile.
- The move type, teams, or titles are wrong in a way you can't fix from the article.

Otherwise verdict "accept", and fix any field that's wrong using only what the article says.
Respond with ONLY JSON: {"verdict":"accept"|"reject","reason":string,"move_type":string,"from_team":string|null,"from_title":string|null,"to_team":string|null,"to_title":string|null,"certainty":"official"|"reported"}`;

function profile(c, logged = []) {
  const parts = [`Row ${c.row}: ${c.first} ${c.last}`];
  if (c.current) parts.push(`current team: ${c.current}`);
  if (c.title) parts.push(`most recent title: ${c.title}`);
  if (c.colleges) parts.push(`colleges coached: ${c.colleges}`);
  if (c.nflTeams) parts.push(`NFL teams: ${c.nflTeams}`);
  if (c.alma) parts.push(`alma mater: ${c.alma}`);
  if (c.years) parts.push(`years coaching: ${c.years}`);
  let s = parts.join(" | ");
  if (logged.length) s += "\n   already logged: " + logged.map((m) =>
    `[${m.id}] ${m.move_type} ${m.from_team || "?"} -> ${m.to_team || "-"}${m.to_title ? ` (${m.to_title})` : ""}, first reported ${m.first_reported || m.effective_date}`).join("; ");
  return s;
}

function articleBlock(article) {
  return `ARTICLE
Source: ${article.source}
Date: ${article.date || "unknown"}
Title: ${article.title}
URL: ${article.url}
Text:
${(article.text || article.title).slice(0, 30000)}`;
}

async function callClaude(system, user, maxTokens) {
  const key = process.env.BTG_CAROUSEL_ANTHROPIC_API_KEY;
  if (!key) throw new Error("BTG_CAROUSEL_ANTHROPIC_API_KEY is not set");
  const model = process.env.BTG_CAROUSEL_MODEL || "claude-sonnet-5-5";
  // Generous per-call timeout, with retries on rate limits, overloads, and network hiccups.
  let data, lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 180000);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ctl.signal,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
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
  return (data.content || []).map((b) => b.text || "").join("");
}

// loggedFor(row) -> existing cards for that coach, so Claude can say "same event".
export async function extractMoves(article, candidates, loggedFor = () => []) {
  const user = `${articleBlock(article)}

CANDIDATE COACHES
${candidates.map((c) => profile(c, loggedFor(c.row))).join("\n")}`;
  const text = await callClaude(EXTRACT_SYSTEM, user, 8000);
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  const rows = new Set(candidates.map((c) => c.row));
  return arr.filter((x) => x && rows.has(Number(x.row)) && MOVE_TYPES.includes(x.move_type) && x.certainty !== "rumored");
}

// Second, skeptical read before a brand-new card is created. Returns {verdict, reason, ...fixes}.
export async function verifyMove(article, move, coach) {
  const user = `${articleBlock(article)}

TRACKER PROFILE
${profile(coach)}

PROPOSED MOVE
${JSON.stringify({ move_type: move.move_type, from_team: move.from_team, from_title: move.from_title, to_team: move.to_team, to_title: move.to_title, certainty: move.certainty, summary: move.summary })}`;
  const text = await callClaude(VERIFY_SYSTEM, user, 1500);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { verdict: "reject", reason: "No verdict returned" };
  try { return JSON.parse(m[0]); } catch { return { verdict: "reject", reason: "Unreadable verdict" }; }
}

// Re-check an existing card from its headlines only (used once to clean up cards made under older rules).
export async function recheckCard(move, coach) {
  const heads = (move.sources || []).slice(0, 12).map((s) => `- ${s.date || ""} ${s.source || ""}: ${s.title || ""}`).join("\n");
  const user = `HEADLINES THAT PRODUCED THIS CARD
${heads}

TRACKER PROFILE
${coach ? profile(coach) : move.coach_name}

PROPOSED MOVE
${JSON.stringify({ move_type: move.move_type, from_team: move.from_team, to_team: move.to_team, to_title: move.to_title, certainty: move.certainty, summary: move.summary })}

You only have headlines, not full articles. Reject only if the headlines make it clear this is speculation/prediction/hot-seat/candidate talk, a generic destination, or background history. If the headlines plausibly report a real move, accept.`;
  const text = await callClaude(VERIFY_SYSTEM, user, 800);
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : { verdict: "accept" }; } catch { return { verdict: "accept" }; }
}
