const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, Client, registerUser } = require('./helpers');
const { sha256 } = require('../lib/secrets');

const PW = 'password123';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const stay = (person_id, extra = {}) => ({ person_id, start: '2030-01-05T09:00:00', end: '2030-01-05T18:00:00', note: '', ...extra });
const withToken = (token) => ({ headers: { authorization: `Bearer ${token}` } });

// A がログイン済み
async function setup(t, env = {}, opts = {}) {
  const srv = await startServer(env, opts);
  t.after(() => srv.stop());
  const a = await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  return { srv, a, A: a.user.person_id };
}
async function issue(c, password = PW) {
  const r = await c.post('/api/me/token', { password });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
}
const apiRows = (srv) => {
  const db = srv.openDb();
  const rows = db.prepare("SELECT * FROM sessions WHERE kind = 'api'").all();
  db.close();
  return rows;
};
// Bearer で /api/me を読み、見えるユーザー（なければ null）
const whoami = async (srv, token) => (await new Client(srv.base).request('GET', '/api/me', undefined, withToken(token))).json?.user ?? null;

test('古い sessions（列なし）から起動しても、列と索引が足される', async (t) => {
  const srv = await startServer({}, {
    seed(dir) {
      const db = new DatabaseSync(path.join(dir, 'app.db'));
      db.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL)');
      db.close();
    },
  });
  t.after(() => srv.stop());
  const db = srv.openDb();
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_sessions_api'").all();
  db.close();
  for (const c of ['kind', 'created_at', 'last_used_at']) assert.ok(cols.includes(c), c);
  assert.equal(idx.length, 1);
});

test('発行: 未ログインは 401。パスワードが違えば 400。合えばトークンが返る', async (t) => {
  const { srv, a } = await setup(t);
  assert.equal((await new Client(srv.base).post('/api/me/token', { password: PW })).status, 401);
  assert.equal((await a.post('/api/me/token', { password: 'wrong-wrong' })).status, 400);
  assert.equal((await a.post('/api/me/token', {})).status, 400);
  assert.equal(apiRows(srv).length, 0);

  const r = await a.post('/api/me/token', { password: PW });
  assert.equal(r.status, 200);
  assert.match(r.json.token, /^iruinai_[\w-]{43}$/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(Math.abs(r.json.expires_at - (Date.now() + 7 * DAY)) < 60 * 1000);
});

test('DB には、トークンの SHA-256 だけを置く。平文は置かない', async (t) => {
  const { srv, a } = await setup(t);
  const token = await issue(a);
  const rows = apiRows(srv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, sha256(token));
  assert.notEqual(rows[0].token_hash, token);
  assert.ok(!JSON.stringify(rows).includes(token));
});

test('状態: 本体は返さない。発行前は null', async (t) => {
  const { srv, a } = await setup(t);
  assert.equal((await new Client(srv.base).get('/api/me/token')).status, 401);
  assert.equal((await a.get('/api/me/token')).json.token, null);
  const token = await issue(a);
  const s = (await a.get('/api/me/token')).json.token;
  assert.deepEqual(Object.keys(s).sort(), ['created_at', 'expires_at', 'last_used_at']);
  assert.equal(s.last_used_at, null);
  assert.ok(!JSON.stringify(s).includes(token));
});

test('再発行: 古いトークンは消え、行は1つだけ', async (t) => {
  const { srv, a } = await setup(t);
  const t1 = await issue(a);
  const t2 = await issue(a);
  assert.notEqual(t1, t2);
  assert.equal(apiRows(srv).length, 1);
  assert.equal(apiRows(srv)[0].token_hash, sha256(t2));
});

test('再発行を同時に2つ送っても、500 にならず、行は1つ', async (t) => {
  const { srv, a } = await setup(t);
  const rs = await Promise.all([a.post('/api/me/token', { password: PW }), a.post('/api/me/token', { password: PW })]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200]);
  assert.equal(apiRows(srv).length, 1);
});

test('失効: 未ログインは 401。消したあとは null。なくても 200', async (t) => {
  const { srv, a } = await setup(t);
  assert.equal((await new Client(srv.base).del('/api/me/token')).status, 401);
  await issue(a);
  assert.equal((await a.del('/api/me/token')).status, 200);
  assert.equal(apiRows(srv).length, 0);
  assert.equal((await a.get('/api/me/token')).json.token, null);
  assert.equal((await a.del('/api/me/token')).status, 200);
});

test('パスワードを5回間違えると、発行は 429（正しいパスワードでも）', async (t) => {
  const { srv, a } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await a.post('/api/me/token', { password: 'wrong-wrong' })).status, 400);
  assert.equal((await a.post('/api/me/token', { password: PW })).status, 429);
  assert.equal(apiRows(srv).length, 0);
});

test('1アカウントに1つ: 別のアカウントのトークンは別々', async (t) => {
  const { srv, a } = await setup(t);
  const b = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B' } });
  await issue(a);
  await issue(b);
  assert.equal(apiRows(srv).length, 2);
  await b.del('/api/me/token');
  assert.equal(apiRows(srv).length, 1);
});

test('期限切れの行（掃除前）: 状態は null。再発行はできる', async (t) => {
  const { srv, a } = await setup(t, {}, { fakeClock: true });
  await issue(a);
  srv.advanceClock(7 * DAY + HOUR);
  assert.equal((await a.get('/api/me/token')).json.token, null);
  assert.ok(await issue(a));
  assert.equal(apiRows(srv).length, 1);
  assert.notEqual((await a.get('/api/me/token')).json.token, null);
});
