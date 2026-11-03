// Background function (runs up to 15 min). Started by the schedule or the Scan Now button.
import { runScan } from "../lib/scan.mjs";
import { getMeta } from "../lib/store.mjs";

const COOLDOWN_MIN = 10;

export default async (req) => {
  const trigger = req.headers.get("x-scan-trigger") || "manual";
  const meta = await getMeta();
  const last = meta.lastScan?.startedAt ? Date.parse(meta.lastScan.startedAt) : 0;
  if (trigger !== "schedule" && Date.now() - last < COOLDOWN_MIN * 60e3) return;
  await runScan(trigger);
};
