const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, registerUser, waitFor } = require('./helpers');
const { verifyPassword } = require('../lib/secrets');

const codeOf = (mail) => mail.text.match(/確認コード: (\d{6})/)[1];

test('新しい人で登録 → コード確認 → ログイン状態になる（メールは小文字化される）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);

  assert.deepEqual((await c.get('/api/me')).json, { user: null });

  const s = await c.post('/api/auth/signup', { email: ' Alice@Example.COM ', password: 'password123' });
  assert.equal(s.status, 200);
  const mail = await srv.waitMail('alice@example.com');
  assert.match(mail.subject, /確認コード/);

  // コードが合っただけでは、まだ登録されない（ユーザーも人も作られず、ログインもしていない）
  const v = await c.post('/api/auth/verify', { email: 'ALICE@example.com', code: codeOf(mail), password: 'password123' });
  assert.equal(v.status, 200);
  assert.equal(v.json.verified, true);
  assert.equal(v.json.user, undefined);
  assert.equal((await c.get('/api/me')).json.user, null);
  assert.deepEqual(counts(srv), { users: 0, people: 0, sessions: 0, attempts: 0 });

  // 人を選んで（ここでは新しく作る）、登録が済む
  const d = await c.post('/api/auth/complete', { new_name: 'アリス', new_color: '#112233' });
  assert.equal(d.status, 200);
  assert.equal(d.json.user.email, 'alice@example.com');

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
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const mail = await srv.waitMail('a@example.com');
  await c.post('/api/auth/verify', { code: codeOf(mail) });
  const v = await c.post('/api/auth/complete', { new_name: 'A' });
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

  // 使われている人は選べない。メールの確認は済んでいるので、行は残り、選び直せる
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'b@example.com', password: 'password123' });
  await c.post('/api/auth/verify', { code: codeOf(await srv.waitMail('b@example.com')) });
  const r = await c.post('/api/auth/complete', { person_id: pid });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /すでに使われています/);
  assert.equal((await c.get('/api/me')).json.user, null);
  assert.equal((await c.post('/api/auth/complete', { new_name: 'B' })).status, 200); // 選び直せる
});

test('登録の申し込み: メールアドレス・パスワードが不正なら 400（人は、コードの確認のあとで選ぶ）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const ok = { email: 'a@example.com', password: 'password123' };
  const cases = [
    { ...ok, email: 'not-an-email' },
    { ...ok, email: 'a'.repeat(250) + '@example.com' },
    { ...ok, password: '1234567' },
    { ...ok, password: 'x'.repeat(129) },
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
  const r = await new Client(srv.base).post('/api/auth/signup', { email: 'A@example.com', password: 'password123' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /登録済み/);
});

test('コードを 5回間違えると無効になり、その後は正しいコードでも通らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const good = codeOf(await srv.waitMail('a@example.com'));
  const bad = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await c.post('/api/auth/verify', { code: bad });
    assert.equal(r.status, 400);
  }
  const r = await c.post('/api/auth/verify', { code: good });
  assert.equal(r.status, 400);
  assert.equal((await c.get('/api/me')).json.user, null);
});

test('コードの期限が切れると通らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const good = codeOf(await srv.waitMail('a@example.com'));
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();
  const r = await c.post('/api/auth/verify', { code: good });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /有効期限/);
});

test('再送は 60秒空ける。再送すると古いコードは使えず、新しいコードで通る', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const first = codeOf(await srv.waitMail('a@example.com'));

  // 続けての resend は 429。別のブラウザからの signup も 429（同じブラウザの signup は resumed で、メールは送らない）
  assert.equal((await new Client(srv.base).post('/api/auth/signup', { email: 'a@example.com', password: 'password123' })).status, 429);
  assert.equal((await c.post('/api/auth/resend', {})).status, 429);

  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET sent_at = sent_at - 61000').run();
  db.close();
  assert.equal((await c.post('/api/auth/resend', {})).status, 200);
  const second = codeOf(await srv.waitMail('a@example.com', 2));

  if (first !== second) {
    assert.equal((await c.post('/api/auth/verify', { code: first })).status, 400);
  }
  assert.equal((await c.post('/api/auth/verify', { code: second })).status, 200);
});

test('同じ既存の人を 2人が選んだら、先に確認した 1人だけ成功する', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name, color) VALUES ('既存', '#abcdef')").run().lastInsertRowid);
  db.close();

  const a = new Client(srv.base);
  const b = new Client(srv.base);
  assert.equal((await a.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' })).status, 200);
  assert.equal((await b.post('/api/auth/signup', { email: 'b@example.com', password: 'password123' })).status, 200);
  assert.equal((await a.post('/api/auth/verify', { code: codeOf(await srv.waitMail('a@example.com')) })).status, 200);
  assert.equal((await b.post('/api/auth/verify', { code: codeOf(await srv.waitMail('b@example.com')) })).status, 200);

  assert.equal((await a.post('/api/auth/complete', { person_id: pid })).status, 200);
  const rb = await b.post('/api/auth/complete', { person_id: pid });
  assert.equal(rb.status, 400);
  assert.match(rb.json.error, /すでに使われています/);

  const db2 = srv.openDb();
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM pending_signups WHERE email = 'b@example.com'").get().n, 1); // b の確認済みの行は残る
  db2.close();
  // b は、メールの確認からやり直さずに、別の人を選び直せる
  assert.equal((await b.post('/api/auth/complete', { new_name: 'B' })).status, 200);
});

test('人を選ぶ直前にメールが先に使われたら、新しい人を作らずに失敗する', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const code = codeOf(await srv.waitMail('a@example.com'));
  assert.equal((await c.post('/api/auth/verify', { code })).status, 200);
  // 人を選ぶ直前に、同じメールのユーザーが先に作られた状況を作る
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name) VALUES ('先客')").run().lastInsertRowid);
  db.prepare("INSERT INTO users (email, password_hash, person_id, created_at) VALUES ('a@example.com', 'x', ?, 0)").run(pid);
  const before = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
  db.close();
  const r = await c.post('/api/auth/complete', { new_name: 'A' });
  assert.equal(r.status, 400);
  const db2 = srv.openDb();
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM people').get().n, before);
  db2.close();
});

test('SMTP に送れないときは「メールを送れませんでした」で、途中データが残らない', async (t) => {
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
  t.after(() => srv.stop());
  const r = await new Client(srv.base).post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
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
  const r = await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  assert.equal(r.status, 401);
  assert.equal(r.json.needLogin, undefined); // 合言葉の 401 と書き込みガードの 401 は区別できる

  assert.equal((await c.postForm('/login', { password: 'himitsu' })).status, 303);
  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' })).status, 200);
});

test('GET /logout（アドレス欄から開いた = Sec-Fetch-Site: none）は合言葉とセッションの Cookie を両方消す', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.postForm('/login', { password: 'himitsu' });
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const code = codeOf(await srv.waitMail('a@example.com'));
  await c.post('/api/auth/verify', { code });
  await c.post('/api/auth/complete', { new_name: 'A' });
  assert.ok(c.jar.has('iruinai_session') && c.jar.has('iruinai_auth'));
  const r = await c.request('GET', '/logout', undefined, { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(r.status, 303);
  assert.equal(c.jar.size, 0);
  const db = srv.openDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  db.close();
});

// ---- 修正ラウンド 1 ----

const LOCK_MSG = '間違いが続いたため、このコードは使えません。10分ほど待ってから、もう一度登録してください';
const PENDING_MSG = 'このメールアドレスは、すでに登録の手続き中です。自分で申し込んだ場合は、申し込んだブラウザで、届いた確認コードを入力してください。別のブラウザで申し込んだ場合や、心当たりがない場合は、10分ほど待ってからやり直してください';

// signup → verify まで進めて、verify の応答（Set-Cookie を見る用）を返す
async function signupAndVerify(srv, email) {
  const c = new Client(srv.base);
  assert.equal((await c.post('/api/auth/signup', { email, password: 'password123' })).status, 200);
  const code = codeOf(await srv.waitMail(email));
  assert.equal((await c.post('/api/auth/verify', { code })).status, 200);
  const d = await c.post('/api/auth/complete', { new_name: 'A' });
  assert.equal(d.status, 200);
  return d.headers.getSetCookie().find((l) => l.startsWith('iruinai_session='));
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
  const reg = { email: 'a@example.com', password: 'password123' };
  await c.post('/api/auth/signup', reg);
  const good = codeOf(await srv.waitMail('a@example.com'));
  const wrong = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) {
    const r = await c.post('/api/auth/verify', { code: wrong });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, `確認コードが違います（あと ${4 - i} 回）`);
  }
  const fifth = await c.post('/api/auth/verify', { code: wrong });
  assert.equal(fifth.status, 400);

  // 正しいコードでも通らない。行は消えず、ロックされたまま残る
  const ok = await c.post('/api/auth/verify', { code: good });
  assert.equal(ok.status, 400);

  // 申し込んだブラウザでの登録し直しは resumed（メールは送らない）。別のブラウザは、すぐなら 429、61秒たっても確認待ちの行が残っているので 400。
  // どれもメールは増えない
  const other = new Client(srv.base);
  assert.deepEqual((await c.post('/api/auth/signup', reg)).json, { ok: true, resumed: true });
  assert.equal((await other.post('/api/auth/signup', reg)).status, 429);
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET sent_at = sent_at - 61000').run();
  db.close();
  assert.deepEqual((await c.post('/api/auth/signup', reg)).json, { ok: true, resumed: true });
  const again = await other.post('/api/auth/signup', reg);
  assert.equal(again.status, 400);
  assert.equal(again.json.error, PENDING_MSG);
  assert.equal(srv.mailCount('a@example.com'), 1);
  // 5回目の間違いも、その後の正しいコードも、同じ案内を返す
  assert.equal(fifth.json.error, LOCK_MSG);
  assert.equal(ok.json.error, LOCK_MSG);
});

test('確認待ちの登録は、同じメールの別の登録で上書きできない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const victim = new Client(srv.base);
  assert.equal((await victim.post('/api/auth/signup', { email: 'a@example.com', password: 'passwordAAA' })).status, 200);
  const code = codeOf(await srv.waitMail('a@example.com'));

  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET sent_at = sent_at - 61000').run();
  db.close();
  const attacker = new Client(srv.base);
  const r = await attacker.post('/api/auth/signup', { email: 'a@example.com', password: 'passwordBBB' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, PENDING_MSG);
  assert.equal(srv.mailCount('a@example.com'), 1);

  // 元のコードで確認でき、パスワードも名前も最初の登録のまま
  assert.equal((await victim.post('/api/auth/verify', { code })).status, 200);
  assert.equal((await victim.post('/api/auth/complete', { new_name: 'アリス' })).status, 200);
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
  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'passwordAAA' })).status, 200);
  await srv.waitMail('a@example.com');
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();

  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'passwordBBB' })).status, 200);
  const code = codeOf(await srv.waitMail('a@example.com', 2));
  assert.equal((await c.post('/api/auth/verify', { code })).status, 200);
  assert.equal((await c.post('/api/auth/complete', { new_name: 'B' })).status, 200);
  const db2 = srv.openDb();
  const u = db2.prepare('SELECT password_hash FROM users WHERE email = ?').get('a@example.com');
  db2.close();
  assert.equal(verifyPassword('passwordBBB', u.password_hash), true);
});

// ---- verify は、コードだけを受け取る（確認待ちは、申し込んだブラウザの Cookie で決まる） ----

const MISMATCH_RE = /^確認コードが違います（あと \d 回）$/;
const hasSession = (res) => res.headers.getSetCookie().some((l) => l.startsWith('iruinai_session='));
const counts = (srv) => {
  const db = srv.openDb();
  const row = {
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    people: db.prepare('SELECT COUNT(*) AS n FROM people').get().n,
    sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    attempts: db.prepare('SELECT attempts FROM pending_signups').get()?.attempts ?? null,
  };
  db.close();
  return row;
};

test('verify: 本文の email・password は無視される。コードだけで、Cookie の確認待ちが確認できる', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const code = codeOf(await srv.waitMail('a@example.com'));
  // 別のメール・でたらめなパスワードを添えても、見られるのは Cookie の行だけ。間違いも増えない
  const ok = await c.post('/api/auth/verify', { email: 'other@example.com', code, password: { $ne: '' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.verified, true);
  assert.equal(hasSession(ok), false); // 確認だけではログインしない
  assert.deepEqual(counts(srv), { users: 0, people: 0, sessions: 0, attempts: 0 });
  const done = await c.post('/api/auth/complete', { new_name: 'A', email: 'other@example.com' });
  assert.equal(hasSession(done), true);
  assert.equal(done.json.user.email, 'a@example.com'); // 本文のメールは見ない
  assert.deepEqual(counts(srv), { users: 1, people: 1, sessions: 1, attempts: null });
});

test('verify: コードが文字列・6桁でないときも、500 ではなく 400 で、試行として数える', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const code = codeOf(await srv.waitMail('a@example.com'));
  const bodies = [{}, { code: null }, { code: ['x'] }, { code: { $ne: '' } }];
  for (const body of bodies) {
    const r = await c.post('/api/auth/verify', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, MISMATCH_RE);
  }
  assert.equal(counts(srv).attempts, 4);
  assert.equal(counts(srv).users, 0);
  assert.equal((await c.post('/api/auth/verify', { code })).status, 200);
  assert.equal((await c.post('/api/auth/complete', { new_name: 'A' })).status, 200);
});

test('complete: 登録の途中で予期しないエラーが起きても、内部のエラー文は返さない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  assert.equal((await c.post('/api/auth/verify', { code: codeOf(await srv.waitMail('a@example.com')) })).status, 200);
  // people への INSERT を失敗させる
  const db = srv.openDb();
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON people BEGIN SELECT RAISE(ABORT, 'constraint boom'); END");
  db.close();
  const r = await c.post('/api/auth/complete', { new_name: 'A' });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'サーバーでエラーが起きました');
  assert.doesNotMatch(r.text, /constraint|boom|people|SQLITE/i);
  await waitFor(() => /constraint/i.test(srv.output()), 'error log'); // 元のエラーはサーバーのログに残る
  assert.deepEqual(counts(srv).users, 0);
});

// ---- 最終レビュー対応: 入力の検査 ----

test('メールアドレス: アドレスの書式に使う記号を含むものは登録できない。普通のアドレスは通る', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const bads = ['victim<attacker@evil.com>', 'a"b@example.com', 'a,b@example.com', 'a(b)@example.com', 'a;b@example.com',
    'a:b@example.com', 'a[b]@example.com', 'a\\b@example.com', 'a b@example.com', 'a@exa mple.com', 'a@example.com>'];
  for (const email of bads) {
    const r = await c.post('/api/auth/signup', { email, password: 'password123' });
    assert.equal(r.status, 400, email);
  }
  assert.equal(srv.mails().length, 0);
  const ok = await c.post('/api/auth/signup', { email: 'first.last+tag@sub.example.co.jp', password: 'password123' });
  assert.equal(ok.status, 200);
  await srv.waitMail('first.last+tag@sub.example.co.jp');
});

test('登録の申し込みの入力が文字列でなければ 400（[object Object] を保存せず、DB のエラーも返さない）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const ok = { email: 'a@example.com', password: 'password123' };
  const cases = [
    { ...ok, email: { a: 1 } },
    { ...ok, email: ['a@example.com'] },
    { ...ok, password: { a: 1 } },
    { ...ok, password: 12345678 },
  ];
  for (const body of cases) {
    const r = await c.post('/api/auth/signup', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.doesNotMatch(r.text, /object|SQLite|bind/i, JSON.stringify(body));
  }
  assert.equal(srv.mails().length, 0);
  const db = srv.openDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_signups').get().n, 0);
  db.close();
});

test('complete: 人の指定が不正なら 400。確認済みの行は残り、選び直せる。何も作られない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  assert.equal((await c.post('/api/auth/verify', { code: codeOf(await srv.waitMail('a@example.com')) })).status, 200);
  const cases = [
    {}, { new_name: '' }, { new_name: '   ' }, { new_name: 'あ'.repeat(21) },
    { new_name: { a: 1 } }, { new_name: ['A'] }, { new_name: 12 },
    { new_name: 'A', new_color: { a: 1 } }, { new_name: 'A', new_color: 123456 },
    { person_id: 99999 }, { person_id: 'abc' }, { person_id: true }, { person_id: [] }, { person_id: {} }, { person_id: '1' }, { person_id: 1.5 },
  ];
  for (const body of cases) {
    const r = await c.post('/api/auth/complete', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.doesNotMatch(r.text, /object|SQLite|bind/i, JSON.stringify(body));
  }
  assert.deepEqual(counts(srv), { users: 0, people: 0, sessions: 0, attempts: 0 });
  assert.equal((await c.get('/api/auth/pending')).json.pending.verified, true); // 選び直せる
  // 色の指定が不正（形式違い）なら、既定の色になる
  const done = await c.post('/api/auth/complete', { new_name: 'A', new_color: 'red' });
  assert.equal(done.status, 200);
  const db = srv.openDb();
  assert.equal(db.prepare('SELECT color FROM people WHERE id = ?').get(done.json.user.person_id).color, '#4f7cff');
  db.close();
});

// ---- コード確認のあとに人を選ぶ。選ばなければ、登録されない ----

test('complete: Cookie がない・コードを確認していないときは、何も作らずに 400', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  assert.equal((await new Client(srv.base).post('/api/auth/complete', { new_name: 'A' })).json.noPending, true); // Cookie なし
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const r = await c.post('/api/auth/complete', { new_name: 'A' }); // コードを確認する前
  assert.equal(r.status, 400);
  assert.equal(r.json.error, '先に、メールに届いた確認コードを入力してください');
  assert.deepEqual(counts(srv), { users: 0, people: 0, sessions: 0, attempts: 0 });
  // 別のブラウザの Cookie では、確認済みの行にも触れない
  assert.equal((await c.post('/api/auth/verify', { code: codeOf(await srv.waitMail('a@example.com')) })).status, 200);
  const other = new Client(srv.base);
  assert.equal((await other.post('/api/auth/complete', { new_name: 'X' })).json.noPending, true);
  assert.deepEqual(counts(srv), { users: 0, people: 0, sessions: 0, attempts: 0 });
});

test('人を選ばなければ、登録されない: ユーザーも人もセッションも作られず、期限で確認待ちが消える', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  assert.equal((await c.post('/api/auth/verify', { code: codeOf(await srv.waitMail('a@example.com')) })).status, 200);
  const peopleBefore = (await c.get('/api/people')).json;
  // このブラウザには、確認済みの状態が見える（ページを開き直しても、人の選択に戻れる）
  const pending = (await c.get('/api/auth/pending')).json.pending;
  assert.equal(pending.verified, true);
  assert.equal(pending.locked, false);
  assert.deepEqual((await c.get('/api/people')).json, peopleBefore);
  assert.equal((await c.get('/api/me')).json.user, null);
  assert.deepEqual(counts(srv), { users: 0, people: 0, sessions: 0, attempts: 0 });

  // 確認済みでも、コードの再送はできない。もう一度 verify しても、コードは見ずに同じ結果
  assert.equal((await c.post('/api/auth/resend', {})).status, 400);
  const again = await c.post('/api/auth/verify', { code: '000000' });
  assert.equal(again.status, 200);
  assert.equal(again.json.verified, true);

  // 人を選ばないまま期限が過ぎる → 選べず、確認待ちは消え、ユーザーも人も作られない
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();
  const late = await c.post('/api/auth/complete', { new_name: 'A' });
  assert.equal(late.status, 400);
  assert.match(late.json.error, /時間が過ぎました/);
  assert.deepEqual(counts(srv), { users: 0, people: 0, sessions: 0, attempts: null });
  assert.equal((await c.get('/api/auth/pending')).json.pending, null);
  assert.equal((await c.get('/api/me')).json.user, null);
  // 同じメールで、また最初から登録できる
  assert.equal((await new Client(srv.base).post('/api/auth/signup', { email: 'a@example.com', password: 'password123' })).status, 200);
});

test('人を選ばずに放っておいた確認待ちは、サーバーの掃除でも消える', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  await c.post('/api/auth/verify', { code: codeOf(await srv.waitMail('a@example.com')) });
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();
  // 別の人の申し込みで cleanup() が走ると、期限切れの行は消える
  assert.equal((await new Client(srv.base).post('/api/auth/signup', { email: 'b@example.com', password: 'password123' })).status, 200);
  const db2 = srv.openDb();
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM pending_signups WHERE email = 'a@example.com'").get().n, 0);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM people').get().n, 0);
  db2.close();
});

test('cancel: 確認待ちを消して Cookie も消す。そのあとは、すぐ登録し直せる。Cookie がなくても落ちない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  await c.post('/api/auth/verify', { code: codeOf(await srv.waitMail('a@example.com')) });
  const r = await c.post('/api/auth/cancel', {});
  assert.equal(r.status, 200);
  assert.ok(r.headers.getSetCookie().some((l) => l.startsWith('iruinai_signup=') && /Max-Age=0/.test(l)));
  assert.deepEqual(counts(srv), { users: 0, people: 0, sessions: 0, attempts: null });
  assert.equal((await c.get('/api/auth/pending')).json.pending, null);
  assert.equal((await c.post('/api/auth/complete', { new_name: 'A' })).json.noPending, true);
  assert.equal((await new Client(srv.base).post('/api/auth/cancel', {})).status, 200); // Cookie がなくても
  // 他のブラウザの確認待ちは消せない
  const d = new Client(srv.base);
  await d.post('/api/auth/signup', { email: 'b@example.com', password: 'password123' });
  await new Client(srv.base).post('/api/auth/cancel', {});
  assert.equal((await d.get('/api/auth/pending')).json.pending.email, 'b@example.com');
});

test('complete が成功すると、申し込みの Cookie は消え、確認待ちの行もなくなる', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  const v = await c.post('/api/auth/verify', { code: codeOf(await srv.waitMail('a@example.com')) });
  assert.ok(!v.headers.getSetCookie().some((l) => l.startsWith('iruinai_signup=') && /Max-Age=0/.test(l))); // 確認だけでは、まだ消さない
  const d = await c.post('/api/auth/complete', { new_name: 'A' });
  assert.ok(d.headers.getSetCookie().some((l) => l.startsWith('iruinai_signup=') && /Max-Age=0/.test(l)));
  assert.equal(counts(srv).attempts, null);
  assert.equal((await c.post('/api/auth/complete', { new_name: 'A' })).json.noPending, true); // 二重に登録できない
  assert.equal(counts(srv).users, 1);
});

test('古い形式の DB（resend_count・browser_hash 列がない pending_signups）でも起動でき、列と索引が足される。古い行は確認できないまま期限で消える', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const { hashPassword, sha256 } = require('../lib/secrets');
  const srv = await startServer({}, {
    seed(dir) {
      const old = new DatabaseSync(path.join(dir, 'app.db'));
      old.exec(`CREATE TABLE pending_signups (
        email TEXT PRIMARY KEY, password_hash TEXT NOT NULL, person_id INTEGER, new_name TEXT, new_color TEXT,
        code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL)`);
      const now = Date.now();
      old.prepare(`INSERT INTO pending_signups (email, password_hash, new_name, new_color, code_hash, expires_at, attempts, sent_at)
        VALUES ('a@example.com', ?, 'A', '#4f7cff', ?, ?, 0, ?)`).run(hashPassword('password123'), sha256('123456'), now + 600000, now - 120000);
      old.close();
    },
  });
  t.after(() => srv.stop());
  const db = srv.openDb();
  const cols = db.prepare('PRAGMA table_info(pending_signups)').all();
  const resend = cols.find((c) => c.name === 'resend_count');
  assert.ok(resend, 'resend_count 列が足されている');
  assert.equal(resend.notnull, 1);
  assert.ok(cols.find((c) => c.name === 'verified_at'), 'verified_at 列が足されている');
  const browser = cols.find((c) => c.name === 'browser_hash');
  assert.ok(browser, 'browser_hash 列が足されている');
  assert.equal(browser.notnull, 0); // 古い行は NULL のまま
  assert.equal(db.prepare("SELECT resend_count FROM pending_signups WHERE email = 'a@example.com'").get().resend_count, 0);
  assert.equal(db.prepare("SELECT browser_hash FROM pending_signups WHERE email = 'a@example.com'").get().browser_hash, null);
  const indexed = db.prepare('PRAGMA index_list(pending_signups)').all()
    .some((ix) => db.prepare(`PRAGMA index_info(${JSON.stringify(ix.name)})`).all().some((c) => c.name === 'browser_hash'));
  assert.ok(indexed, 'browser_hash の索引がある');
  db.close();

  // 古い行は、どの Cookie でも確認も再送もできない（期限の 10分で消える）。同じメールの別の登録も、期限までは断られる
  const c = new Client(srv.base);
  c.jar.set('iruinai_signup', 'some-token');
  c.paths.set('iruinai_signup', '/api/auth');
  assert.equal((await c.post('/api/auth/verify', { code: '123456' })).status, 400);
  assert.equal((await c.post('/api/auth/resend', {})).status, 400);
  assert.equal((await c.get('/api/auth/pending')).json.pending, null);
  assert.equal((await new Client(srv.base).post('/api/auth/signup', { email: 'a@example.com', password: 'password123' })).status, 400);
});

test('browser_hash の追加は何度起動しても同じ結果になる（列があるときは何もしない）', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iruinai-test-'));
  try {
    const run = () => execFileSync(process.execPath, ['-e', "require('./lib/db')"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir } });
    run();
    run(); // 2回目に「列が重複」で落ちない
    const db = new DatabaseSync(path.join(dir, 'app.db'));
    assert.equal(db.prepare('PRAGMA table_info(pending_signups)').all().filter((c) => c.name === 'browser_hash').length, 1);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
