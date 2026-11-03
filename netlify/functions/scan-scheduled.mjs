// Every 4 hours: hand the work to the background function (scheduled functions only get 30s).
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  await fetch(`${base}/.netlify/functions/scan-background`, { method: "POST", headers: { "x-scan-trigger": "schedule" } });
  return new Response("ok");
};

export const config = { schedule: "0 */4 * * *" };
