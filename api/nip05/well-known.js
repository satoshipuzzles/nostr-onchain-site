// GET /.well-known/nostr.json  (mapped via a rewrite in vercel.json)
//
// Spec: https://github.com/nostr-protocol/nips/blob/master/05.md
//
// If ?name=alice is present, returns just that name's mapping (fast path,
// one KV read). If absent, returns the full registry (uses the names-index
// set + MGET, still cheap for a few thousand names).
import {
  kv, getStoreNpub,
  normalizeName, keyName, NAMES_INDEX, json, badRequest,
} from './_lib.js';
import { nip19 } from 'nostr-tools';

// Operator-owned names, served straight from config — not claimable, not in
// KV, cannot drift. `_` makes the bare domain (nostronchain.com) resolve to
// the store per NIP-05's root-name convention.
function builtinNames() {
  const npub = getStoreNpub();
  if (!npub) return {};
  try {
    const { data: pubkey } = nip19.decode(npub);
    return { store: pubkey, _: pubkey };
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return badRequest(res, 'GET only');

  const raw = req.query && req.query.name;
  const builtin = builtinNames();

  if (raw) {
    const name = normalizeName(raw) || (raw === '_' ? '_' : null);
    if (!name) return json(res, 200, { names: {} });
    if (builtin[name]) return json(res, 200, { names: { [name]: builtin[name] } });
    const rec = await kv.get(keyName(name));
    if (!rec) return json(res, 200, { names: {} });
    return json(res, 200, { names: { [name]: rec.pubkey } });
  }

  // Full dump. This is O(N) — fine at our scale; if it ever grows we can
  // paginate or serve the static snapshot instead.
  const names = await kv.smembers(NAMES_INDEX);
  if (!names || names.length === 0) return json(res, 200, { names: builtin });

  const keys = names.map((n) => keyName(n));
  const records = await kv.mget(...keys);
  const out = { ...builtin };  // operator names always present, never overridable
  names.forEach((n, i) => {
    if (records[i] && records[i].pubkey && !builtin[n]) out[n] = records[i].pubkey;
  });
  return json(res, 200, { names: out });
}
