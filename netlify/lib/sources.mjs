// Where the scanner looks. Add or remove sources here.
// No date windows are applied anywhere: old news is filtered out after Claude reads it
// (see "already in tracker" logic in scan.mjs), never by limiting what gets pulled.

const gnews = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
const bing = (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&count=100`;

// FootballScoop has no RSS feed, so we read its listing pages and pull article links.
export const SCOOP_PAGES = [
  "https://www.footballscoop.com/",
  ...[0, 1, 2, 3, 4, 5].map((p) => `https://www.footballscoop.com/team/jobs-scoop/feed?page=${p}`),
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => `https://www.footballscoop.com/team/scoop/feed?page=${p}`),
  // Carousel Scoop: FootballScoop's coaching-carousel hub (hires, firings, searches, plus its carousel table).
  ...[0, 1, 2, 3, 4, 5].map((p) => `https://www.footballscoop.com/team/carousel-scoop/feed?page=${p}`),
];

const BROAD = [
  ["FootballScoop", "site:footballscoop.com"],
  ["247Sports", "site:247sports.com coach (hired OR fired OR coordinator OR retire OR dies)"],
  ["On3", "site:on3.com coach (hired OR fired OR coordinator OR retire OR dies)"],
  ["Coordinators", 'football ("offensive coordinator" OR "defensive coordinator" OR "special teams coordinator") (hired OR named OR fired)'],
  ["Head coach changes", 'football "head coach" (fired OR "parted ways" OR hired OR named OR resigns)'],
  ["Assistants", 'football coach ("named" OR "hired" OR "joins staff") (assistant OR "position coach" OR "line coach")'],
  ["Retirements", 'football coach (retires OR retirement OR "steps down")'],
  ["Deaths", 'former football coach (dies OR died OR "passed away" OR obituary)'],
  ["NFL staff", 'NFL (coach OR coordinator) (fired OR hired OR interim OR "parted ways")'],
  ["CFL staff", "CFL coach (hired OR fired OR coordinator)"],
  ["School releases", 'football "announced" ("defensive coordinator" OR "offensive coordinator" OR "head coach") athletics'],
];

export const RSS_FEEDS = [
  { name: "ESPN College Football", url: "https://www.espn.com/espn/rss/ncf/news" },
  { name: "ESPN NFL", url: "https://www.espn.com/espn/rss/nfl/news" },
  ...BROAD.map(([n, q]) => ({ name: `Google News · ${n}`, url: gnews(q) })),
  ...BROAD.map(([n, q]) => ({ name: `Bing News · ${n}`, url: bing(q.replace(/site:(\S+)/, "site:$1")) })),
];

// Targeted searches by coach name: every coach in the tracker gets searched by name,
// a slice per scan, cycling through the whole list (about every 12 hours).
export const NAMES_PER_QUERY = 8;
export const NAME_QUERIES_PER_SCAN = 80;
export function nameQuery(coaches) {
  const names = coaches.map((c) => `"${c.first.replace(/"/g, "")} ${c.last.replace(/"/g, "")}"`).join(" OR ");
  return { name: "Google News · Coach names", url: gnews(`(${names}) coach`) };
}

// Cheap filter before any article is fetched or sent to Claude.
export const MOVE_WORDS =
  /coach|coordinator|hire|hiring|fire[ds]?\b|parted ways|resign|retire|promot|named|interim|staff|joins|join |lands|tabbed|interview|dismiss|let go|steps? down|stepping down|out at|passed away|dies|died|death|dead at|obituar|funeral|memorial|mourn|\(\d{4}-\d{4}\)|tapped|elevat|reassign|leaving|departs|move[sd]? on/i;
