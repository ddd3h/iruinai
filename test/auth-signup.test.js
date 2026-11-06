const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, registerUser } = require('./helpers');

const codeOf = (mail) => mail.text.match(/確認コード: (\d{6})/)[1];

test('新しい人で登録 → コード確認 → ログイン状態になる（メールは小文字化される）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);

  assert.deepEqual((await c.get('/api/me')).json, { user: null });

  const s = await c.post('/api/auth/signup', { email: ' Alice@Example.COM ', password: 'password123', new_name: 'アリス', new_color: '#112233' });
  assert.equal(s.status, 200);
  const mail = await srv.waitMail('alice@example.com');
  assert.match(mail.subject, /確認コード/);

  const v = await c.post('/api/auth/verify', { email: 'ALICE@example.com', code: codeOf(mail) });
  assert.equal(v.status, 200);
  assert.equal(v.json.user.email, 'alice@example.com');

  const me = (await c.get('/api/me')).json.user;
  assert.equal(me.email, 'alice@example.com');
  const people = (await c.get('/api/people')).json;
  const mine = people.find((p) => p.id === me.person_id);
  assert.equal(mine.name, 'アリス');
  assert.equal(mine.color, '#112233');
});

test('Cookie は HttpOnly・SameSite=Lax で、DB にはトークンの hash だけが入る', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const mail = await srv.waitMail('a@example.com');
  const v = await c.post('/api/auth/verify', { email: 'a@example.com', code: codeOf(mail) });
  const setCookie = v.headers.getSetCookie().find((l) => l.startsWith('iruinai_session='));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const token = setCookie.split(';')[0].split('=')[1];
  const db = srv.openDb();
  const row = db.prepare('SELECT token_hash FROM sessions').get();
  db.close();
  assert.notEqual(row.token_hash, token);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test('既存の未紐付けの人を選んで登録できる。紐付け済みの人は選べない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name, color) VALUES ('既存', '#abcdef')").run().lastInsertRowid);
  db.close();

  const a = await registerUser(srv, { email: 'a@example.com', person: { person_id: pid } });
  assert.equal(a.user.person_id, pid);

  const c = new Client(srv.base);
  const r = await c.post('/api/auth/signup', { email: 'b@example.com', password: 'password123', person_id: pid });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /すでに使われています/);
  assert.equal(srv.mailCount('b@example.com'), 0);
});

test('存在しない人・不正な入力は 400', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const ok = { email: 'a@example.com', password: 'password123', new_name: 'A' };
  const cases = [
    { ...ok, email: 'not-an-email' },
    { ...ok, email: 'a'.repeat(250) + '@example.com' },
    { ...ok, password: '1234567' },
    { ...ok, password: 'x'.repeat(129) },
    { ...ok, new_name: '' },
    { ...ok, new_name: 'あ'.repeat(21) },
    { email: 'a@example.com', password: 'password123', person_id: 99999 },
    { email: 'a@example.com', password: 'password123', person_id: 'abc' },
  ];
  for (const body of cases) {
    const r = await c.post('/api/auth/signup', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(srv.mails().length, 0);
});

test('登録済みのメールは登録できない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const r = await new Client(srv.base).post('/api/auth/signup', { email: 'A@example.com', password: 'password123', new_name: 'B' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /登録済み/);
});

test('コードを 5回間違えると無効になり、その後は正しいコードでも通らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const good = codeOf(await srv.waitMail('a@example.com'));
  const bad = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await c.post('/api/auth/verify', { email: 'a@example.com', code: bad });
    assert.equal(r.status, 400);
  }
  const r = await c.post('/api/auth/verify', { email: 'a@example.com', code: good });
  assert.equal(r.status, 400);
  assert.equal((await c.get('/api/me')).json.user, null);
});

test('コードの期限が切れると通らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const good = codeOf(await srv.waitMail('a@example.com'));
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();
  const r = await c.post('/api/auth/verify', { email: 'a@example.com', code: good });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /有効期限/);
});

test('再送は 60秒空ける。再送すると古いコードは使えず、新しいコードで通る', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const first = codeOf(await srv.waitMail('a@example.com'));

  // 続けての signup・resend は 429
  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' })).status, 429);
  assert.equal((await c.post('/api/auth/resend', { email: 'a@example.com' })).status, 429);

  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET sent_at = sent_at - 61000').run();
  db.close();
  assert.equal((await c.post('/api/auth/resend', { email: 'a@example.com' })).status, 200);
  const second = codeOf(await srv.waitMail('a@example.com', 2));

  if (first !== second) {
    assert.equal((await c.post('/api/auth/verify', { email: 'a@example.com', code: first })).status, 400);
  }
  assert.equal((await c.post('/api/auth/verify', { email: 'a@example.com', code: second })).status, 200);
});

test('同じ既存の人を 2人が選んだら、先に確認した 1人だけ成功する', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name, color) VALUES ('既存', '#abcdef')").run().lastInsertRowid);
  db.close();

  const a = new Client(srv.base);
  const b = new Client(srv.base);
  assert.equal((await a.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', person_id: pid })).status, 200);
  assert.equal((await b.post('/api/auth/signup', { email: 'b@example.com', password: 'password123', person_id: pid })).status, 200);
  const codeA = codeOf(await srv.waitMail('a@example.com'));
  const codeB = codeOf(await srv.waitMail('b@example.com'));

  assert.equal((await a.post('/api/auth/verify', { email: 'a@example.com', code: codeA })).status, 200);
  const rb = await b.post('/api/auth/verify', { email: 'b@example.com', code: codeB });
  assert.equal(rb.status, 400);
  assert.match(rb.json.error, /すでに使われています/);

  const db2 = srv.openDb();
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM pending_signups WHERE email = 'b@example.com'").get().n, 0);
  db2.close();
  // b は選び直してすぐ登録し直せる（再送の待ち時間に引っかからない）
  assert.equal((await b.post('/api/auth/signup', { email: 'b@example.com', password: 'password123', new_name: 'B' })).status, 200);
});

test('コード確認の直前にメールが先に使われたら、新しい人を作らずに失敗する', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const code = codeOf(await srv.waitMail('a@example.com'));
  // コード確認の直前に、同じメールのユーザーが先に作られた状況を作る
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name) VALUES ('先客')").run().lastInsertRowid);
  db.prepare("INSERT INTO users (email, password_hash, person_id, created_at) VALUES ('a@example.com', 'x', ?, 0)").run(pid);
  const before = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
  db.close();
  const r = await c.post('/api/auth/verify', { email: 'a@example.com', code });
  assert.equal(r.status, 400);
  const db2 = srv.openDb();
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM people').get().n, before);
  db2.close();
});

test('SMTP に送れないときは「メールを送れませんでした」で、途中データが残らない', async (t) => {
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
  t.after(() => srv.stop());
  const r = await new Client(srv.base).post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'メールを送れませんでした');
  const db = srv.openDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_signups').get().n, 0);
  db.close();
});

test('ログアウトするとセッションが消える。期限切れのセッションは無効', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  assert.ok((await c.get('/api/me')).json.user);
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/me')).json.user, null);
  const db = srv.openDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  db.close();

  const d = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B' } });
  const db2 = srv.openDb();
  db2.prepare('UPDATE sessions SET expires_at = 1').run();
  db2.close();
  assert.equal((await d.get('/api/me')).json.user, null);
});

test('合言葉が最初の関門のまま。合言葉なしでは登録 API にも届かない', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const r = await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  assert.equal(r.status, 401);
  assert.equal(r.json.needLogin, undefined); // 合言葉の 401 と書き込みガードの 401 は区別できる

  assert.equal((await c.postForm('/login', { password: 'himitsu' })).status, 303);
  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' })).status, 200);
});

test('GET /logout は合言葉とセッションの Cookie を両方消す', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.postForm('/login', { password: 'himitsu' });
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const code = codeOf(await srv.waitMail('a@example.com'));
  await c.post('/api/auth/verify', { email: 'a@example.com', code });
  assert.ok(c.jar.has('iruinai_session') && c.jar.has('iruinai_auth'));
  const r = await c.get('/logout');
  assert.equal(r.status, 303);
  assert.equal(c.jar.size, 0);
  const db = srv.openDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  db.close();
});
