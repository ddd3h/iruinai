const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, Client } = require('./helpers');
const { sha256, hashPassword } = require('../lib/secrets');
const { STAMP_IDS } = require('../lib/stamps');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const withToken = (token) => ({ headers: { authorization: `Bearer ${token}` } });

test('GET /api/docs: ログインなしで読める。{BASE} はアクセス先の URL になる', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const r = await new Client(srv.base).get('/api/docs');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  assert.ok(!r.text.includes('{BASE}'), '{BASE} が残っている');
  assert.ok(r.text.includes(`${srv.base}/api/stays`), 'アクセス先の URL が入っていない');
  assert.match(r.text, /Authorization: Bearer/);
});

test('GET /api/docs: PUBLIC_URL があればそれを使う（末尾の / は落とす）', async (t) => {
  const srv = await startServer({ PUBLIC_URL: 'https://room.example.com/' });
  t.after(() => srv.stop());
  const r = await new Client(srv.base).get('/api/docs');
  assert.ok(r.text.includes('https://room.example.com/api/stays'));
  assert.ok(!r.text.includes('https://room.example.com//'));
  assert.ok(!r.text.includes(srv.base));
});

test('合言葉あり: /api/docs は API トークンだけで読める。トークンなしは 401', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  const token = 'iruinai_' + 'y'.repeat(43);
  const db = srv.openDb();
  const personId = Number(db.prepare("INSERT INTO people (name) VALUES ('T')").run().lastInsertRowid);
  const userId = Number(db.prepare('INSERT INTO users (email, password_hash, person_id, created_at) VALUES (?, ?, ?, ?)')
    .run('t@example.com', hashPassword('password123'), personId, Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, kind, created_at) VALUES (?, ?, ?, 'api', ?)")
    .run(sha256(token), userId, Date.now() + 86400000, Date.now());
  db.close();

  const anon = new Client(srv.base);
  const no = await anon.get('/api/docs');
  assert.equal(no.status, 401);
  const ok = await anon.request('GET', '/api/docs', undefined, withToken(token));
  assert.equal(ok.status, 200);
  assert.ok(ok.text.includes(`${srv.base}/api/stays`));
});

// API を足したのにドキュメントを忘れると、ここで落ちる
test('ドキュメントに、トークンで使えるすべての API が載っている', () => {
  const doc = read('lib/api-doc.md');
  const routes = [];
  for (const m of read('server.js').matchAll(/\bapp\.(get|post|put|delete)\('(\/api\/[^']+)'/g)) routes.push([m[1], m[2]]);
  for (const m of read('lib/reactions.js').matchAll(/\brouter\.(get|post|put|delete)\('([^']+)'/g)) routes.push([m[1], '/api' + m[2]]);
  routes.push(['get', '/api/me'], ['get', '/api/docs']);
  assert.ok(routes.length >= 25, `ルートの取り出しに失敗している（${routes.length} 件）`);
  const headings = new Set(doc.split('\n').filter((l) => l.startsWith('### ')).map((l) => l.slice(4).trim()));
  const missing = routes.map(([m, p]) => `${m.toUpperCase()} ${p}`).filter((h) => !headings.has(h));
  assert.deepEqual(missing, [], `api-doc.md に見出しがない: ${missing.join(', ')}`);
});

test('ドキュメントに、すべてのスタンプ ID と、トークンでできないことが書いてある', () => {
  const doc = read('lib/api-doc.md');
  for (const id of STAMP_IDS) assert.ok(doc.includes(`\`${id}\``), `スタンプ ${id} がない`);
  for (const p of ['/api/auth', '/api/me/withdraw', '/api/me/token']) assert.ok(doc.includes(p), `${p} への言及がない`);
  assert.match(doc, /1週間/);
});
