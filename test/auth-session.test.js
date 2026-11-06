const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, registerUser, waitFor } = require('./helpers');
const { hashPassword } = require('../lib/secrets');

const resetUrlOf = (mail) => mail.text.match(/(https?:\/\/\S+\/reset\?token=[\w-]+)/)[1];

test('ログイン: メールの大文字小文字・空白は無視。PW が違えば 400', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: ' Alice@Example.COM ', password: 'password123', person: { new_name: 'アリス' } });

  const c = new Client(srv.base);
  const wrong = await c.post('/api/auth/login', { email: 'alice@example.com', password: 'nope-nope' });
  assert.equal(wrong.status, 400);
  assert.equal((await c.get('/api/me')).json.user, null);

  const ok = await c.post('/api/auth/login', { email: '  ALICE@example.com ', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/me')).json.user.email, 'alice@example.com');
});

test('存在しないメールと PW 違いで、同じメッセージを返す', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const c = new Client(srv.base);
  const a = await c.post('/api/auth/login', { email: 'a@example.com', password: 'wrong-wrong' });
  const b = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-wrong' });
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
  assert.equal(a.json.error, b.json.error);
  // ダミー hash の元の PW でも、存在しないユーザーには入れない
  const d = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'dummy-password-for-timing' });
  assert.equal(d.status, 400);
});

test('同じ IP から 5回続けて失敗すると、正しい PW でも 1分は拒否される', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', password: 'password123', person: { new_name: 'A' } });
  const c = new Client(srv.base);
  for (let i = 0; i < 5; i++) {
    assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'wrong-wrong' })).status, 400);
  }
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'password123' })).status, 429);
});

test('PW リセット: 1回限り。使うと既存のセッションが全部消え、新しい PW でだけ入れる', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const old = await registerUser(srv, { email: 'a@example.com', password: 'old-password', person: { new_name: 'A' } });
  const other = new Client(srv.base);
  assert.equal((await other.post('/api/auth/login', { email: 'a@example.com', password: 'old-password' })).status, 200);
  assert.ok((await other.get('/api/me')).json.user); // リセット前は、この端末もログイン中

  const c = new Client(srv.base);
  const f = await c.post('/api/auth/forgot', { email: 'A@example.com' });
  assert.equal(f.status, 200);
  const url = resetUrlOf(await srv.waitMail('a@example.com', 2)); // 1通目は登録のコード
  const token = new URL(url).searchParams.get('token');
  assert.ok(url.startsWith(srv.base)); // PUBLIC_URL 未設定なら Host から組み立てる

  // 短すぎる PW では失敗し、トークンは消費されない
  assert.equal((await c.post('/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { token, password: 'brand-new-password' })).status, 200);

  // 再利用はできない
  assert.equal((await c.post('/api/auth/reset', { token, password: 'another-password' })).status, 400);
  // 既存のセッションは全部無効
  assert.equal((await old.get('/api/me')).json.user, null);
  assert.equal((await other.get('/api/me')).json.user, null);
  // 古い PW は通らず、新しい PW で入れる
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'old-password' })).status, 400);
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'brand-new-password' })).status, 200);
});

test('PW リセット: 期限切れ・でたらめなトークンは 400', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const c = new Client(srv.base);
  await c.post('/api/auth/forgot', { email: 'a@example.com' });
  const token = new URL(resetUrlOf(await srv.waitMail('a@example.com', 2))).searchParams.get('token');
  const db = srv.openDb();
  db.prepare('UPDATE reset_tokens SET expires_at = 1').run();
  db.close();
  assert.equal((await c.post('/api/auth/reset', { token, password: 'brand-new-password' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { token: 'x'.repeat(43), password: 'brand-new-password' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { password: 'brand-new-password' })).status, 400);
});

test('PW リセット要求: 未登録のメールでも同じ応答で、メールは送らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const c = new Client(srv.base);
  const known = await c.post('/api/auth/forgot', { email: 'a@example.com' });
  const unknown = await c.post('/api/auth/forgot', { email: 'nobody@example.com' });
  const garbage = await c.post('/api/auth/forgot', { email: 'garbage' });
  assert.deepEqual([known.status, unknown.status, garbage.status], [200, 200, 200]);
  assert.deepEqual(known.json, unknown.json);
  await srv.waitMail('a@example.com', 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(srv.mailCount('nobody@example.com'), 0);
  assert.equal(srv.mailCount('garbage'), 0);
});

test('PUBLIC_URL を設定すると、リセット URL はそれを元にする', async (t) => {
  const srv = await startServer({ PUBLIC_URL: 'https://room.example.com/' });
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  await new Client(srv.base).post('/api/auth/forgot', { email: 'a@example.com' });
  const url = resetUrlOf(await srv.waitMail('a@example.com', 2));
  assert.ok(url.startsWith('https://room.example.com/reset?token='), url);
});

test('退会: PW が違えば消えない。正しければ人・在室・メモ・アカウント・セッションが消える', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const a = await registerUser(srv, { email: 'a@example.com', password: 'password123', person: { new_name: 'A' } });
  const b = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B' } });
  const pid = a.user.person_id;
  const db = srv.openDb();
  db.prepare("INSERT INTO stays (person_id, start, end) VALUES (?, '2030-01-01T09:00:00', '2030-01-01T10:00:00')").run(pid);
  db.prepare("INSERT INTO memos (person_id, title, all_day, start, end) VALUES (?, 'メモ', 1, '2030-01-01', '2030-01-02')").run(pid);
  db.close();

  assert.equal((await new Client(srv.base).post('/api/me/withdraw', { password: 'password123' })).status, 401);
  const wrong = await a.post('/api/me/withdraw', { password: 'wrong-wrong' });
  assert.equal(wrong.status, 400);
  assert.ok((await a.get('/api/me')).json.user); // まだログイン中

  assert.equal((await a.post('/api/me/withdraw', { password: 'password123' })).status, 200);
  assert.equal((await a.get('/api/me')).json.user, null);
  const db2 = srv.openDb();
  const n = (sql) => db2.prepare(sql).get().n;
  assert.equal(n(`SELECT COUNT(*) AS n FROM people WHERE id = ${pid}`), 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM stays WHERE person_id = ${pid}`), 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM memos WHERE person_id = ${pid}`), 0);
  assert.equal(n("SELECT COUNT(*) AS n FROM users WHERE email = 'a@example.com'"), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM sessions'), 1); // b のセッションだけが残る
  db2.close();
  assert.ok((await b.get('/api/me')).json.user);
  assert.equal((await new Client(srv.base).post('/api/auth/login', { email: 'a@example.com', password: 'password123' })).status, 400);
});

test('ログインに成功しても失敗の回数は消えない（自分のアカウントで成功を挟んで回数を戻せない）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', password: 'password123', person: { new_name: 'A' } });
  const c = new Client(srv.base);
  for (let i = 0; i < 4; i++) {
    assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'wrong-wrong' })).status, 400);
  }
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'password123' })).status, 200); // 成功を挟む
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'wrong-wrong' })).status, 400); // 5回目の失敗
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'password123' })).status, 429);
});

test('SMTP 利用中に PUBLIC_URL が未設定なら、リセットのメールは送らない（Host ヘッダーで URL をすり替えられないように）', async (t) => {
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
  t.after(() => srv.stop());
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name) VALUES ('A')").run().lastInsertRowid);
  db.prepare('INSERT INTO users (email, password_hash, person_id, created_at) VALUES (?, ?, ?, ?)')
    .run('a@example.com', hashPassword('password123'), pid, Date.now());
  db.close();

  const r = await new Client(srv.base).post('/api/auth/forgot', { email: 'a@example.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  await waitFor(() => srv.output().includes('PUBLIC_URL が未設定のため、パスワード再設定のメールを送れません'), 'PUBLIC_URL error log');
  assert.ok(!srv.output().includes('PW リセットのメール送信に失敗'), srv.output()); // 送ろうとした形跡がない
});
