// Vercel Cron: nightly dump of the NIP-05 registry to a static JSON blob.
//
// Two modes:
//   1. If SNAPSHOT_PUSH_TOKEN is set (a GitHub PAT with `repo` scope on
//      satoshipuzzles/nostr-onchain-site), commit `data/nip05-snapshot.json`
//      to `main`. That gives us a public, git-history audit trail.
//   2. If SNAPSHOT_PUSH_TOKEN is unset, just log the JSON so a human can copy
//      it. Useful during setup / debugging.
//
// Auth: Vercel injects CRON_SECRET; we compare Bearer <secret>.
import { kv, keyName, NAMES_INDEX } from '../nip05/_lib.js';

const OWNER = 'satoshipuzzles';
const REPO = 'nostr-onchain-site';
const BRANCH = 'main';
const PATH = 'data/nip05-snapshot.json';

export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    res.status(401).send('unauthorized');
    return;
  }

  const names = (await kv.smembers(NAMES_INDEX)) || [];
  const keys = names.map((n) => keyName(n));
  const records = keys.length ? await kv.mget(...keys) : [];
  const map = {};
  names.forEach((n, i) => {
    if (records[i] && records[i].pubkey) map[n] = records[i].pubkey;
  });

  const snapshot = {
    generated_at: new Date().toISOString(),
    count: Object.keys(map).length,
    names: map,
  };
  const content = JSON.stringify(snapshot, null, 2) + '\n';

  const token = process.env.SNAPSHOT_PUSH_TOKEN;
  if (!token) {
    console.log('[nip05-snapshot] no SNAPSHOT_PUSH_TOKEN set; snapshot not committed:');
    console.log(content);
    res.status(200).json({ ok: true, committed: false, count: snapshot.count });
    return;
  }

  // Commit via GitHub Contents API: get current file SHA, then PUT with new
  // content. If the file doesn't exist yet, PUT without an sha.
  const base = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nostr-onchain-snapshot-bot',
  };

  let sha;
  try {
    const g = await fetch(`${base}?ref=${BRANCH}`, { headers });
    if (g.ok) {
      const j = await g.json();
      sha = j.sha;
    }
  } catch (e) {
    // Missing file is fine; other errors we surface below.
  }

  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const put = await fetch(base, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `chore(nip05): nightly snapshot (${snapshot.count} names)`,
      content: b64,
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!put.ok) {
    const text = await put.text().catch(() => '');
    console.error('[nip05-snapshot] GitHub commit failed:', put.status, text);
    res.status(500).json({ ok: false, error: `github ${put.status}` });
    return;
  }

  res.status(200).json({ ok: true, committed: true, count: snapshot.count });
}
