// GET /.well-known/nostr.json  (mapped via a rewrite in vercel.json)
//
// Spec: https://github.com/nostr-protocol/nips/blob/master/05.md
//
// If ?name=alice is present, returns just that name's mapping (fast path,
// one KV read). If absent, returns the full registry (uses the names-index
// set + MGET, still cheap for a few thousand names).
import {
  kv,
  normalizeName, keyName, NAMES_INDEX, json, badRequest,
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return badRequest(res, 'GET only');

  const raw = req.query && req.query.name;

  if (raw) {
    const name = normalizeName(raw);
    if (!name) return json(res, 200, { names: {} });
    const rec = await kv.get(keyName(name));
    if (!rec) return json(res, 200, { names: {} });
    return json(res, 200, { names: { [name]: rec.pubkey } });
  }

  // Full dump. This is O(N) — fine at our scale; if it ever grows we can
  // paginate or serve the static snapshot instead.
  const names = await kv.smembers(NAMES_INDEX);
  if (!names || names.length === 0) return json(res, 200, { names: {} });

  const keys = names.map((n) => keyName(n));
  const records = await kv.mget(...keys);
  const out = {};
  names.forEach((n, i) => {
    if (records[i] && records[i].pubkey) out[n] = records[i].pubkey;
  });
  return json(res, 200, { names: out });
}
