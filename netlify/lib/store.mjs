import { getStore } from "@netlify/blobs";
import SEED, { ROSTER_SEED_DATE } from "./roster-seed.mjs";

export const store = () => getStore({ name: "carousel", consistency: "strong" });

export async function getJSON(key, fallback) {
  const v = await store().get(key, { type: "json" });
  return v ?? fallback;
}
export async function setJSON(key, value) {
  await store().setJSON(key, value);
}

export async function getRoster() {
  const r = await getJSON("roster", null);
  if (r && Array.isArray(r.coaches) && r.coaches.length) return r;
  return { updatedAt: ROSTER_SEED_DATE, source: "Built-in copy of Hargrave_Outreach_Tracker.xlsx", coaches: SEED };
}

export const getMoves = () => getJSON("moves", []);
export const setMoves = (m) => setJSON("moves", m);
export const getMeta = () => getJSON("meta", { runs: [] });
export const setMeta = (m) => setJSON("meta", m);
