# BTG Coach Carousel

Tracks job changes (hires, firings, promotions, title changes, retirements, and more) for every coach in the **Coaches** tab of `Hargrave_Outreach_Tracker.xlsx`, for *Beyond the Grave*.

## How it works

1. **Every 4 hours** (`netlify/functions/scan-scheduled.mjs`), or when you press **Scan now**, a background function (`scan-background.mjs`, up to 15 min) starts a scan.
2. It collects headlines from FootballScoop (homepage and Jobs Scoop pages), ESPN's college and NFL RSS feeds, and Google News searches covering 247Sports, On3, school press releases, and NFL and CFL staff news. Edit the list in `netlify/lib/sources.mjs`.
3. Headlines that aren't about coaching are dropped. FootballScoop articles are opened in full, and only articles that mention a tracker coach by name (nicknames included, e.g. Mike/Michael) move on.
4. Claude reads each of those articles, along with the matching coaches' tracker history, and returns structured moves with a match-confidence explanation. Same-name players and administrators are rejected.
5. Moves are saved permanently in Netlify Blobs. When a move is already on file, new articles get added to it as extra sources.

## Environment variables (Netlify → Site configuration → Environment variables)

| Name | Required | Notes |
| --- | --- | --- |
| `BTG_CAROUSEL_ANTHROPIC_API_KEY` | Yes | Anthropic API key used only by this tool |
| `BTG_CAROUSEL_MODEL` | No | Defaults to `claude-sonnet-5-5` |

## Updating the coach list

Click **Upload tracker .xlsx** and pick the latest tracker. The file is parsed in your browser. Only names, teams, titles, and coaching history are sent to the site; phone numbers, emails, and notes are never uploaded. Row numbers then match the file you uploaded. Until the first upload, the tool uses the built-in copy in `netlify/lib/roster-seed.mjs`.

## Data

All state is stored in the Netlify Blobs store `carousel`, under these keys: `moves`, `roster`, `meta` (scan history), `seen` (articles already read, kept 60 days), `backlog` (articles a run ran out of time for), and `teams` (ESPN logo directory, refreshed weekly).
