const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, registerUser } = require('./helpers');
const { verifyPassword } = require('../lib/secrets');

const codeOf = (mail) => mail.text.match(/確認コード: (\d{6})/)[1];

// 起動した直後はサーバーが期限切れの行を消す書き込みをしていて、DB がロックされていることがある。
// 起動直後に書き込むテストは、ロックが外れるまで待つ（待たないと "database is locked" で不定期に落ちる）
const openDbWaiting = (srv) => {
  const db = srv.openDb();
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
};

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
  const db = openDbWaiting(srv);
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
  const db = openDbWaiting(srv);
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

// ---- 修正ラウンド 1 ----

const LOCK_MSG = '間違いが続いたので、10分ほど待ってからもう一度登録してください';

// signup → verify まで進めて、verify の応答（Set-Cookie を見る用）を返す
async function signupAndVerify(srv, email) {
  const c = new Client(srv.base);
  assert.equal((await c.post('/api/auth/signup', { email, password: 'password123', new_name: 'A' })).status, 200);
  const code = codeOf(await srv.waitMail(email));
  const v = await c.post('/api/auth/verify', { email, code });
  assert.equal(v.status, 200);
  return v.headers.getSetCookie().find((l) => l.startsWith('iruinai_session='));
}

test('PUBLIC_URL が https のとき、セッション Cookie に Secure が付く（TLS プロキシの後ろでも付く）', async (t) => {
  const srv = await startServer({ PUBLIC_URL: 'https://room.example.com' });
  t.after(() => srv.stop());
  assert.match(await signupAndVerify(srv, 'a@example.com'), /; Secure/);
});

test('PUBLIC_URL が未設定の http では、セッション Cookie に Secure は付かない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  assert.doesNotMatch(await signupAndVerify(srv, 'a@example.com'), /Secure/);
});

test('コードを 5回間違えた後は、登録し直してもメールは再送されない（60秒の制限をすり抜けられない）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const reg = { email: 'a@example.com', password: 'password123', new_name: 'A' };
  await c.post('/api/auth/signup', reg);
  const good = codeOf(await srv.waitMail('a@example.com'));
  const wrong = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) {
    const r = await c.post('/api/auth/verify', { email: 'a@example.com', code: wrong });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'コードが違います');
  }
  const fifth = await c.post('/api/auth/verify', { email: 'a@example.com', code: wrong });
  assert.equal(fifth.status, 400);

  // 正しいコードでも通らない。行は消えず、ロックされたまま残る
  const ok = await c.post('/api/auth/verify', { email: 'a@example.com', code: good });
  assert.equal(ok.status, 400);

  // すぐの登録は 429、61秒たっても確認待ちの行が残っているので 400。どちらもメールは増えない
  assert.equal((await c.post('/api/auth/signup', reg)).status, 429);
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET sent_at = sent_at - 61000').run();
  db.close();
  const again = await c.post('/api/auth/signup', reg);
  assert.equal(again.status, 400);
  assert.match(again.json.error, /送信済み/);
  assert.equal(srv.mailCount('a@example.com'), 1);
  // 5回目の間違いも、その後の正しいコードも、同じ案内を返す
  assert.equal(fifth.json.error, LOCK_MSG);
  assert.equal(ok.json.error, LOCK_MSG);
});

test('確認待ちの登録は、同じメールの別の登録で上書きできない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const victim = new Client(srv.base);
  assert.equal((await victim.post('/api/auth/signup', { email: 'a@example.com', password: 'passwordAAA', new_name: 'アリス' })).status, 200);
  const code = codeOf(await srv.waitMail('a@example.com'));

  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET sent_at = sent_at - 61000').run();
  db.close();
  const attacker = new Client(srv.base);
  const r = await attacker.post('/api/auth/signup', { email: 'a@example.com', password: 'passwordBBB', new_name: 'マロリー' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'このメールアドレスには確認メールを送信済みです。届いたコードを入力するか、10分ほど待ってからやり直してください');
  assert.equal(srv.mailCount('a@example.com'), 1);

  // 元のコードで確認でき、パスワードも名前も最初の登録のまま
  assert.equal((await victim.post('/api/auth/verify', { email: 'a@example.com', code })).status, 200);
  const db2 = srv.openDb();
  const u = db2.prepare('SELECT u.password_hash, p.name FROM users u JOIN people p ON p.id = u.person_id WHERE u.email = ?').get('a@example.com');
  db2.close();
  assert.equal(verifyPassword('passwordAAA', u.password_hash), true);
  assert.equal(verifyPassword('passwordBBB', u.password_hash), false);
  assert.equal(u.name, 'アリス');
});

test('期限切れの確認待ちは、新しい登録で置き換えられる', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'passwordAAA', new_name: 'A' })).status, 200);
  await srv.waitMail('a@example.com');
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();

  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'passwordBBB', new_name: 'B' })).status, 200);
  const code = codeOf(await srv.waitMail('a@example.com', 2));
  assert.equal((await c.post('/api/auth/verify', { email: 'a@example.com', code })).status, 200);
  const db2 = srv.openDb();
  const u = db2.prepare('SELECT password_hash FROM users WHERE email = ?').get('a@example.com');
  db2.close();
  assert.equal(verifyPassword('passwordBBB', u.password_hash), true);
});
