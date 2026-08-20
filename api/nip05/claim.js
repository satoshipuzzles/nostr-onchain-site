// POST /api/nip05/claim
// Body: { name, txid, event }
//   - name: requested identifier (validated)
//   - txid: 64-hex Bitcoin transaction that paid the store address
//   - event: signed NIP-01 event (kind 27050) authorizing the claim
//
// On success, provisions the name in KV atomically and returns
// {ok: true, nip05: 'name@nostronchain.com', pubkey: '<hex>'}.
//
// All failure modes are 4xx with {error: '<message>'}.

import {
  kv,
  normalizeName, isReserved, nameRecord, pubkeyOwns, txidClaimed,
  keyName, keyPubkey, keyTxid, KEY_COUNT, NAMES_INDEX,
  verifyPayment, parseClaim, json, badRequest, PRICE_SATS,
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return badRequest(res, 'POST only');

  let body;
  try { body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { return badRequest(res, 'invalid JSON body'); }

  const name = normalizeName(body.name);
  if (!name) return badRequest(res, 'invalid name');
  if (isReserved(name)) return badRequest(res, 'name is reserved');

  const txid = typeof body.txid === 'string' ? body.txid.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(txid)) return badRequest(res, 'invalid txid');

  const event = body.event;

  // Verify the claim event: signature + declared name/txid match request.
  let claim;
  try { claim = parseClaim(event, name, txid); }
  catch (e) { return badRequest(res, e.message); }
  const pubkey = claim.pubkey;

  // Availability re-check (racing another claim is possible before we
  // atomically commit; the setnx below is the actual guard).
  if (await nameRecord(name)) return badRequest(res, 'name just got taken');
  const already = await pubkeyOwns(pubkey);
  if (already) return badRequest(res, `pubkey already owns "${already}" — one name per key`);
  const dupTxid = await txidClaimed(txid);
  if (dupTxid) return badRequest(res, `txid already used for "${dupTxid}"`);

  // Verify the on-chain payment.
  let pay;
  try { pay = await verifyPayment(txid); }
  catch (e) { return badRequest(res, `payment check failed: ${e.message}`); }

  // Atomic provisioning: use `nx` (only if not exists) on the three uniqueness
  // keys. If any collides, we roll back. KV doesn't offer multi-key
  // transactions, so this is best-effort — the checks above make collisions
  // rare in practice.
  const record = {
    pubkey,
    txid,
    ts: Math.floor(Date.now() / 1000),
    value_sats: pay.valueSats,
    confirmations: pay.confirmations,
  };

  const okName = await kv.set(keyName(name), record, { nx: true });
  if (!okName) return badRequest(res, 'name just got taken');

  const okPk = await kv.set(keyPubkey(pubkey), name, { nx: true });
  if (!okPk) {
    await kv.del(keyName(name));
    return badRequest(res, 'pubkey just got another name — one per key');
  }

  const okTx = await kv.set(keyTxid(txid), name, { nx: true });
  if (!okTx) {
    await kv.del(keyName(name));
    await kv.del(keyPubkey(pubkey));
    return badRequest(res, 'txid just got used');
  }

  await Promise.all([
    kv.incr(KEY_COUNT),
    kv.sadd(NAMES_INDEX, name),
  ]);

  return json(res, 200, {
    ok: true,
    nip05: `${name}@nostronchain.com`,
    pubkey,
    ts: record.ts,
  });
}
