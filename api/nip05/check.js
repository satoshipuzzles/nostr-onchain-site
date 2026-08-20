// GET /api/nip05/check?name=alice
// Returns {name, available, reason?} — the reason is present when unavailable.
import {
  normalizeName, isReserved, nameRecord, json, badRequest, PRICE_SATS,
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return badRequest(res, 'GET only');
  const raw = req.query && req.query.name;
  const name = normalizeName(raw);
  if (!name) {
    return json(res, 200, {
      name: (raw || '').toString(),
      available: false,
      reason: 'invalid: 3-32 chars, a-z 0-9 - _ only, must start alphanumeric',
    });
  }
  if (isReserved(name)) {
    return json(res, 200, { name, available: false, reason: 'reserved' });
  }
  const rec = await nameRecord(name);
  if (rec) {
    return json(res, 200, { name, available: false, reason: 'taken' });
  }
  return json(res, 200, { name, available: true, price_sats: PRICE_SATS });
}
