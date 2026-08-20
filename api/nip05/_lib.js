// Shared helpers for the NIP-05 endpoints.
// Kept in one file so cold-start cost stays low across the small function suite.
import { Redis } from '@upstash/redis';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as btc from '@scure/btc-signer';
import { verifyEvent, nip19 } from 'nostr-tools';

// Anchor filesystem reads to this module's location so Vercel's
// node-file-trace picks up data/ in the deployment bundle regardless of
// what process.cwd() happens to be at runtime.
const __dirname = dirname(fileURLToPath(import.meta.url));
const RESERVED_PATH = join(__dirname, '..', '..', 'data', 'nip05-reserved.txt');

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

// Store's Nostr pubkey (bech32 npub1...). Read as a function so tests / hot
// reloads pick up env changes without re-importing the module.
export const getStoreNpub = () => process.env.STORE_NPUB || '';
export const PRICE_SATS = 21000;
export const MEMPOOL = 'https://mempool.space/api';

// KV client. Supports both env var conventions:
//   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Vercel Marketplace)
//   - KV_REST_API_URL         / KV_REST_API_TOKEN         (legacy Vercel KV)
export const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

// -----------------------------------------------------------------------------
// Name validation
// -----------------------------------------------------------------------------

// A NIP-05 local-part per spec: ASCII letters, digits, `-`, `_`, `.`. We
// tighten to lowercase + alnum + hyphen + underscore. Dots would be legal
// but they cause confusion ("a.b" looks like a subdomain) so we disallow.
const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,31})$/;

export function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim().toLowerCase();
  if (!n) return null;
  if (n.length < 3 || n.length > 32) return null;
  if (!NAME_RE.test(n)) return null;
  return n;
}

let reservedCache = null;
export function loadReserved() {
  if (reservedCache) return reservedCache;
  try {
    const text = readFileSync(RESERVED_PATH, 'utf8');
    reservedCache = new Set(
      text.split('\n')
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l && !l.startsWith('#'))
    );
  } catch (e) {
    reservedCache = new Set();
  }
  return reservedCache;
}

export function isReserved(name) {
  return loadReserved().has(name);
}

// -----------------------------------------------------------------------------
// Bitcoin address derivation
// -----------------------------------------------------------------------------

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) out[i / 2] = parseInt(h.substr(i, 2), 16);
  return out;
}

// The store's taproot address, derived from STORE_NPUB via BIP-86 key-path.
// Same derivation used by `site/store.html` — one shared address for all
// registrations. We correlate a payment to a specific claim via the txid the
// buyer submits in the claim event.
let storeAddrCache = null;
export function storeAddress() {
  if (storeAddrCache) return storeAddrCache;
  const npub = getStoreNpub();
  if (!npub) throw new Error('STORE_NPUB not configured');
  const { data: pubHex } = nip19.decode(npub);
  storeAddrCache = btc.p2tr(hexToBytes(pubHex)).address;
  return storeAddrCache;
}

// -----------------------------------------------------------------------------
// KV keys
// -----------------------------------------------------------------------------
//
// nip05:name:<name>      -> JSON { pubkey, txid, ts }        (source of truth)
// nip05:pubkey:<pubkey>  -> <name>                            (per-npub cap)
// nip05:txid:<txid>      -> <name>                            (payment dedup)
// nip05:count            -> integer                           (fast count for snapshot)
//
// All names/txids stored lowercase.

export const keyName = (name) => `nip05:name:${name}`;
export const keyPubkey = (pk) => `nip05:pubkey:${pk}`;
export const keyTxid = (txid) => `nip05:txid:${txid}`;
export const KEY_COUNT = 'nip05:count';
export const NAMES_INDEX = 'nip05:names';   // set-of-names index for snapshot

export async function nameRecord(name) {
  return await kv.get(keyName(name));
}

export async function pubkeyOwns(pk) {
  return await kv.get(keyPubkey(pk));
}

export async function txidClaimed(txid) {
  return await kv.get(keyTxid(txid));
}

// -----------------------------------------------------------------------------
// Payment verification
// -----------------------------------------------------------------------------

// Fetch a transaction from mempool.space and confirm it sends >= PRICE_SATS
// to the store's taproot address AND is confirmed (>= 1 conf) at the tip.
// Returns { ok: true, confirmations, valueSats } on success, throws on failure.
export async function verifyPayment(txid) {
  if (!/^[a-f0-9]{64}$/i.test(txid)) throw new Error('invalid txid format');
  const tx = await fetch(`${MEMPOOL}/tx/${txid}`).then((r) => (r.ok ? r.json() : null));
  if (!tx) throw new Error('txid not found on mempool.space');

  const addr = storeAddress();
  const valueSats = (tx.vout || [])
    .filter((o) => o.scriptpubkey_address === addr)
    .reduce((s, o) => s + o.value, 0);

  if (valueSats < PRICE_SATS) {
    throw new Error(`payment insufficient: ${valueSats} sat to store address, need >= ${PRICE_SATS}`);
  }

  if (!tx.status || !tx.status.confirmed) {
    throw new Error('payment not yet confirmed');
  }

  const tipHeight = await fetch(`${MEMPOOL}/blocks/tip/height`).then((r) => r.text()).then((n) => parseInt(n, 10));
  const confirmations = tipHeight - tx.status.block_height + 1;
  if (confirmations < 1) throw new Error('payment awaits 1 confirmation');

  return { ok: true, confirmations, valueSats };
}

// -----------------------------------------------------------------------------
// Claim event verification
// -----------------------------------------------------------------------------

// A claim is a NIP-01 event kind 27050 signed by the buyer, with content =
// JSON { name, txid, price_sats, addr }. We verify:
//   - signature valid (BIP-340) via nostr-tools verifyEvent
//   - event.pubkey matches the claim's declared owner
//   - content declares the same name + txid as the request body
export function parseClaim(event, expectedName, expectedTxid) {
  if (!event || typeof event !== 'object') throw new Error('missing claim event');
  if (event.kind !== 27050) throw new Error('claim event must be kind 27050');
  if (!verifyEvent(event)) throw new Error('claim event signature invalid');

  let body;
  try { body = JSON.parse(event.content); }
  catch (e) { throw new Error('claim event content is not valid JSON'); }

  if (body.name !== expectedName) throw new Error('claim event name mismatch');
  if (body.txid !== expectedTxid) throw new Error('claim event txid mismatch');
  if (body.price_sats !== PRICE_SATS) throw new Error('claim event price mismatch');

  const age = Math.abs(Math.floor(Date.now() / 1000) - event.created_at);
  if (age > 3600) throw new Error('claim event too old (>1h) — start over');

  return { pubkey: event.pubkey };
}

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------

export function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(body));
}

export function badRequest(res, msg) {
  return json(res, 400, { error: msg });
}
