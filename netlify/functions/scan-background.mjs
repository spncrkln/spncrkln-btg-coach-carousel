// Background function (up to 15 min per run). Started by the schedule, the Scan Now button,
// or by itself when a scan has more articles left than one run could read.
import { runScan } from "../lib/scan.mjs";
import { getMeta } from "../lib/store.mjs";

const COOLDOWN_MIN = 2;

export default async (req) => {
  const trigger = req.headers.get("x-scan-trigger") || "manual";
  const chain = Number(req.headers.get("x-scan-chain") || 0);
  if (trigger === "manual") {
    const meta = await getMeta();
    const last = meta.lastScan?.startedAt ? Date.parse(meta.lastScan.startedAt) : 0;
    if (Date.now() - last < COOLDOWN_MIN * 60e3) return;
  }
  const log = await runScan(trigger, { chain });
  if (log?.continue) {
    const base = process.env.URL || new URL(req.url).origin;
    await fetch(`${base}/.netlify/functions/scan-background`, {
      method: "POST", headers: { "x-scan-trigger": "continuation", "x-scan-chain": String(chain + 1) },
    }).catch(() => {});
  }
};
