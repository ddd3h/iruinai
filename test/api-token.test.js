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

// ---- Bearer での認証 ----

test('Bearer: 本人として書ける。他人のものは 403', async (t) => {
  const { srv, a, A } = await setup(t);
  const b = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B' } });
  const token = await issue(a);
  const anon = new Client(srv.base);
  const call = (m, url, body) => anon.request(m, url, body, withToken(token));

  const made = await call('POST', '/api/stays', stay(A));
  assert.equal(made.status, 201);
  assert.equal((await call('PUT', `/api/stays/${made.json.id}`, { note: '更新' })).status, 200);
  assert.equal((await call('POST', '/api/stays', stay(b.user.person_id))).status, 403);
  assert.equal((await call('GET', '/api/stays?start=2030-01-01&end=2030-02-01')).status, 200);
  assert.equal((await call('DELETE', `/api/stays/${made.json.id}`)).status, 200);
  assert.equal((await call('GET', '/api/me')).json.user.email, 'a@example.com');
});

test('Bearer: 使うと last_used_at が入る', async (t) => {
  const { srv, a } = await setup(t);
  const token = await issue(a);
  assert.ok(await whoami(srv, token));
  assert.ok((await a.get('/api/me/token')).json.token.last_used_at > 0);
});

test('Bearer: 書式の崩れ・知らないトークン・別の方式は、未認証として扱う', async (t) => {
  const { srv, a, A } = await setup(t);
  const token = await issue(a);
  const anon = new Client(srv.base);
  const post = (authorization) => anon.request('POST', '/api/stays', stay(A), authorization === undefined ? {} : { headers: { authorization } });
  assert.equal((await post(undefined)).status, 401);
  assert.equal((await post('')).status, 401);
  assert.equal((await post(`Bearer  ${token}`)).status, 401); // 空白が2つ
  assert.equal((await post(`Bearer ${token} x`)).status, 401);
  assert.equal((await post(`Bearer ${'a'.repeat(201)}`)).status, 401);
  assert.equal((await post(`Basic ${token}`)).status, 401);
  assert.equal((await post(`Bearer ${token}x`)).status, 401);
  assert.equal((await post('Bearer iruinai_unknown')).status, 401);
  assert.equal((await post(`bearer ${token}`)).status, 201); // スキームは大文字小文字を区別しない
});

test('取り違え: Web セッションを Bearer に、API トークンを Cookie に入れても使えない', async (t) => {
  const { srv, a } = await setup(t);
  const token = await issue(a);
  assert.equal(await whoami(srv, a.jar.get('iruinai_session')), null);
  const anon = new Client(srv.base);
  const r = await anon.request('GET', '/api/me', undefined, { headers: { cookie: `iruinai_session=${token}` } });
  assert.equal(r.json.user, null);
});

test('期限: 使うたびに7日に延びる。使わず7日たつと無効', async (t) => {
  const { srv, a } = await setup(t, {}, { fakeClock: true });
  const token = await issue(a);
  srv.advanceClock(6 * DAY + 23 * HOUR);
  assert.ok(await whoami(srv, token)); // まだ使える（ここで7日に延びる）
  srv.advanceClock(6 * DAY + 23 * HOUR);
  assert.ok(await whoami(srv, token)); // 発行から14日近くたっても、使っていたので有効
  srv.advanceClock(7 * DAY + 60 * 1000);
  assert.equal(await whoami(srv, token), null);
  assert.equal((await a.get('/api/me/token')).json.token, null);
});

test('期限: 一度も使わなくても、発行から7日で無効', async (t) => {
  const { srv, a } = await setup(t, {}, { fakeClock: true });
  const token = await issue(a);
  srv.advanceClock(7 * DAY + 60 * 1000);
  assert.equal(await whoami(srv, token), null);
});

test('トークンでできない操作は 403。GET /api/me は通る（末尾の / とクエリも）', async (t) => {
  const { srv, a } = await setup(t);
  const token = await issue(a);
  const anon = new Client(srv.base);
  for (const [m, url, body] of [
    ['POST', '/api/me/withdraw', { password: PW }],
    ['POST', '/api/me/token', { password: PW }],
    ['GET', '/api/me/token'],
    ['DELETE', '/api/me/token'],
    ['POST', '/api/auth/login', { email: 'a@example.com', password: PW }],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/forgot', { email: 'a@example.com' }],
  ]) {
    const r = await anon.request(m, url, body, withToken(token));
    assert.equal(r.status, 403, `${m} ${url}`);
    assert.equal(r.json.error, 'この操作は、トークンではできません');
  }
  for (const url of ['/api/me', '/api/me/', '/api/me?x=1']) {
    assert.equal((await anon.request('GET', url, undefined, withToken(token))).json.user.email, 'a@example.com', url);
  }
  assert.equal(apiRows(srv).length, 1); // 消えていない
});

test('失効・パスワード再設定・退会で使えなくなる。Cookie のログアウトでは消えない', async (t) => {
  const { srv, a } = await setup(t);
  const t1 = await issue(a);
  await a.post('/api/auth/logout');
  assert.ok(await whoami(srv, t1)); // ログアウトしても API トークンは残る

  const c = new Client(srv.base);
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: PW })).status, 200);
  assert.equal((await c.del('/api/me/token')).status, 200);
  assert.equal(await whoami(srv, t1), null); // 失効

  const t2 = await issue(c);
  assert.ok(await whoami(srv, t2));
  const mailsBefore = srv.mailCount('a@example.com');
  assert.equal((await new Client(srv.base).post('/api/auth/forgot', { email: 'a@example.com' })).status, 200);
  const mail = await srv.waitMail('a@example.com', mailsBefore + 1);
  const resetToken = mail.text.match(/reset\?token=([\w-]+)/)[1];
  assert.equal((await new Client(srv.base).post('/api/auth/reset', { token: resetToken, password: 'new-password-1' })).status, 200);
  assert.equal(await whoami(srv, t2), null); // 再設定で消える

  const d = new Client(srv.base);
  await d.post('/api/auth/login', { email: 'a@example.com', password: 'new-password-1' });
  const t3 = await issue(d, 'new-password-1');
  assert.ok(await whoami(srv, t3));
  assert.equal((await d.post('/api/me/withdraw', { password: 'new-password-1' })).status, 200);
  assert.equal(await whoami(srv, t3), null); // 退会で消える
});

test('合言葉あり: トークンは /api/* だけ通す。ページは通さない', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  // 合言葉の門の内側で登録できないので、ユーザーと API トークンの行を DB に直接入れる
  const { hashPassword } = require('../lib/secrets');
  const token = 'iruinai_' + 'x'.repeat(43);
  const db = srv.openDb();
  const personId = Number(db.prepare("INSERT INTO people (name) VALUES ('T')").run().lastInsertRowid);
  const userId = Number(db.prepare('INSERT INTO users (email, password_hash, person_id, created_at) VALUES (?, ?, ?, ?)')
    .run('t@example.com', hashPassword(PW), personId, Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, kind, created_at) VALUES (?, ?, ?, 'api', ?)")
    .run(sha256(token), userId, Date.now() + 7 * DAY, Date.now());
  db.close();

  const anon = new Client(srv.base);
  assert.equal((await anon.get('/api/stays')).status, 401); // トークンなし
  assert.equal((await anon.request('GET', '/api/stays', undefined, withToken('iruinai_wrong'))).status, 401);
  assert.equal((await anon.request('GET', '/api/stays', undefined, withToken(token))).status, 200);
  assert.equal((await anon.request('POST', '/api/stays', stay(personId), withToken(token))).status, 201);
  const page = await anon.request('GET', '/', undefined, withToken(token));
  assert.equal(page.status, 303); // ページは、合言葉の画面へ
});
