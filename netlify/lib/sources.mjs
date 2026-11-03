// Where the scanner looks. Add or remove sources here.

const gnews = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// FootballScoop has no RSS feed, so we read its listing pages and pull article links.
export const SCOOP_PAGES = [
  "https://www.footballscoop.com/",
  "https://www.footballscoop.com/team/jobs-scoop/feed?page=0",
  "https://www.footballscoop.com/team/jobs-scoop/feed?page=1",
  "https://www.footballscoop.com/team/jobs-scoop/feed?page=2",
  "https://www.footballscoop.com/team/jobs-scoop/feed?page=3",
  "https://www.footballscoop.com/team/scoop/feed?page=0",
  "https://www.footballscoop.com/team/scoop/feed?page=1",
];

export const RSS_FEEDS = [
  { name: "ESPN College Football", url: "https://www.espn.com/espn/rss/ncf/news" },
  { name: "ESPN NFL", url: "https://www.espn.com/espn/rss/nfl/news" },
  { name: "Google News · FootballScoop", url: gnews("site:footballscoop.com when:7d") },
  { name: "Google News · 247Sports", url: gnews("site:247sports.com coach (hired OR fired OR coordinator OR retire) when:7d") },
  { name: "Google News · On3", url: gnews("site:on3.com coach (hired OR fired OR coordinator OR retire) when:7d") },
  { name: "Google News · Coordinators", url: gnews('football ("offensive coordinator" OR "defensive coordinator" OR "special teams coordinator") when:7d') },
  { name: "Google News · Head coach changes", url: gnews('football "head coach" (fired OR "parted ways" OR hired OR named OR resigns) when:7d') },
  { name: "Google News · Assistants", url: gnews('football coach ("named" OR "hired" OR "joins staff") (assistant OR "position coach" OR "line coach") when:7d') },
  { name: "Google News · Retirements", url: gnews("football coach (retires OR retirement OR \"steps down\") when:7d") },
  { name: "Google News · NFL staff", url: gnews("NFL (coach OR coordinator) (fired OR hired OR interim OR \"parted ways\") when:7d") },
  { name: "Google News · CFL staff", url: gnews("CFL coach (hired OR fired OR coordinator) when:10d") },
  { name: "Google News · School releases", url: gnews('football "announced" ("defensive coordinator" OR "offensive coordinator" OR "head coach") athletics when:7d') },
];

// Cheap filter before any article is fetched or sent to Claude.
export const MOVE_WORDS =
  /coach|coordinator|hire|hiring|fire[ds]?\b|parted ways|resign|retire|promot|named|interim|staff|joins|join |lands|tabbed|candidate|interview|dismiss|let go|steps? down|stepping down|out at|passed away|dies|died|\(\d{4}-\d{4}\)|tapped|elevat|reassign|leaving|departs|move[sd]? on/i;
