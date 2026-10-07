// Shared slide position for the presenter view on another device.
//
//   GET  /.netlify/functions/position?key=KEY          -> { cur, step, at }
//   POST /.netlify/functions/position { key, cur, step } -> stores and echoes { cur, step, at }
//
// KEY must equal the DECK_KEY environment variable. Without a match every call is 401.
// The deck in drive mode (/?drive=KEY) POSTs on each change; /notes/ polls with GET.

import { getStore } from "@netlify/blobs";

export const deps = { getStore };

const STORE = "deck";
const KEY = "position";
const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const store = () => deps.getStore({ name: STORE, consistency: "strong" });
const index = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

export default async (req) => {
  const secret = process.env.DECK_KEY;

  if (req.method === "GET") {
    const key = new URL(req.url).searchParams.get("key");
    if (!secret || key !== secret) return reply(401, { error: "key" });
    const pos = (await store().get(KEY, { type: "json" })) || { cur: 0, step: 0, at: null };
    return reply(200, pos);
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return reply(400, { error: "json" });
    }
    if (!secret || !body || body.key !== secret) return reply(401, { error: "key" });
    const cur = index(body.cur);
    const step = index(body.step);
    if (cur === null || step === null) return reply(400, { error: "cur and step must be non-negative integers" });
    const pos = { cur, step, at: Date.now() };
    await store().setJSON(KEY, pos);
    return reply(200, pos);
  }

  return reply(405, { error: "method" });
};
