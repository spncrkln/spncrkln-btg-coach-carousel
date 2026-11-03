// Name normalization + roster candidate detection.

const NICK_GROUPS = [
  ["michael", "mike", "mikey"], ["william", "bill", "billy", "will", "willie"],
  ["robert", "bob", "bobby", "rob", "robbie"], ["james", "jim", "jimmy", "jamie"],
  ["thomas", "tom", "tommy"], ["daniel", "dan", "danny"], ["david", "dave"],
  ["christopher", "chris"], ["joseph", "joe", "joey"], ["matthew", "matt"],
  ["steven", "steve", "stephen"], ["anthony", "tony"], ["edward", "ed", "eddie"],
  ["richard", "rick", "ricky", "rich", "dick"], ["jeffrey", "jeff", "jeffery"],
  ["gregory", "greg"], ["ronald", "ron", "ronnie"], ["donald", "don", "donnie"],
  ["kenneth", "ken", "kenny"], ["timothy", "tim", "timmy"], ["nicholas", "nick"],
  ["patrick", "pat"], ["samuel", "sam"], ["andrew", "andy", "drew"],
  ["benjamin", "ben"], ["charles", "charlie", "chuck"], ["jonathan", "jon", "john", "johnny"],
  ["zachary", "zach", "zack"], ["alexander", "alex"], ["lawrence", "larry"],
  ["gerald", "jerry"], ["frederick", "fred", "freddie"], ["joshua", "josh"],
  ["jacob", "jake"], ["terrence", "terry"], ["raymond", "ray"], ["leonard", "len", "lenny"],
  ["douglas", "doug"], ["philip", "phil", "phillip"], ["kevin", "kev"],
  ["randall", "randy"], ["gary"], ["eugene", "gene"], ["walter", "walt"],
  ["bradley", "brad"], ["frank", "francis"], ["harold", "harry"], ["vincent", "vince"],
  ["dwayne", "duane"], ["frederic", "fred"], ["cornelius", "neil"], ["theodore", "ted", "teddy"],
];
const NICK = new Map();
for (const g of NICK_GROUPS) for (const n of g) NICK.set(n, [...new Set([...(NICK.get(n) || []), ...g])]);

export function norm(s) {
  return " " + String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&amp;/g, " and ").replace(/&/g, " and ")
    .replace(/[’'`ʻ‘]/g, "")
    .replace(/\b([a-z])\.\s?([a-z])\.?/g, "$1$2") // A.J. -> aj
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim() + " ";
}

function cleanPart(s) {
  return norm(String(s || "").replace(/\(.*?\)/g, "").replace(/".*?"/g, "")).trim()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
}

export function nameVariants(first, last) {
  const f = cleanPart(first), l = cleanPart(last);
  if (!f || !l || f.length < 2 || l.length < 2) return [];
  const firsts = new Set([f, f.split(" ")[0], ...(NICK.get(f.split(" ")[0]) || [])]);
  const out = new Set();
  for (const fn of firsts) out.add(`${fn} ${l}`);
  return [...out];
}

// Build an index once per scan: variant -> [roster rows]
export function buildNameIndex(roster) {
  const idx = new Map();
  for (const c of roster) {
    for (const v of nameVariants(c.first, c.last)) {
      if (!idx.has(v)) idx.set(v, []);
      idx.get(v).push(c);
    }
  }
  return idx;
}

export function findCandidates(text, idx, limit = 40) {
  const t = norm(text);
  const hits = new Map();
  for (const [variant, coaches] of idx) {
    if (t.includes(" " + variant + " ")) for (const c of coaches) hits.set(c.row, c);
    if (hits.size >= limit) break;
  }
  return [...hits.values()];
}
