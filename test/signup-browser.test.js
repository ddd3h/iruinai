const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');
const { sha256, verifyPassword } = require('../lib/secrets');

// 登録の確認待ちは、申し込みの画面を送ったブラウザ（Cookie iruinai_signup）に結び付く。
// 確認コードの画面は、コードだけを受け取る。メールもパスワードも要らない

const codeOf = (mail) => mail.text.match(/確認コード: (\d{6})/)[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOT_FOUND_MSG = '確認の手続きが見つかりません。もう一度、登録から始めてください';
const PENDING_MSG = 'このメールアドレスは、すでに登録の手続き中です。自分で申し込んだ場合は、申し込んだブラウザで、届いた確認コードを入力してください。別のブラウザで申し込んだ場合や、心当たりがない場合は、10分ほど待ってからやり直してください';
const signupBody = (email, extra = {}) => ({ email, password: 'password123', ...extra });
const hasSession = (res) => res.headers.getSetCookie().some((l) => l.startsWith('iruinai_session='));
const signupCookie = (res) => res.headers.getSetCookie().find((l) => l.startsWith('iruinai_signup='));

const rows = (srv) => {
  const db = srv.openDb();
  const list = db.prepare('SELECT * FROM pending_signups ORDER BY email').all().map((r) => ({ ...r }));
  db.close();
  return list;
};
const rowOf = (srv, email) => rows(srv).find((r) => r.email === email);
const userCount = (srv) => {
  const db = srv.openDb();
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  db.close();
  return n;
};
const rewind = (srv) => {
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET sent_at = sent_at - 61000').run();
  db.close();
};

// ---- (a) なりすまし登録（pre-hijacking）への備え ----

test('pre-hijacking: 他人のメールで申し込まれても、本人のブラウザ（Cookie なし）は、コードを持っていても確認も再送もできない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const mallory = new Client(srv.base);
  assert.equal((await mallory.post('/api/auth/signup', signupBody('victim@example.com', { password: 'mallory-P1-password' }))).status, 200);
  const code = codeOf(await srv.waitMail('victim@example.com')); // 本人の受信箱に届くコード
  const before = rowOf(srv, 'victim@example.com');

  // 本人（Cookie なし）が、正しいコードを入れても、メールとパスワードを添えても通らない。ログインもされない
  const victim = new Client(srv.base);
  const bodies = [{ code }, { email: 'victim@example.com', code }, { email: 'victim@example.com', code, password: 'victim-P2-password' }];
  for (const body of bodies) {
    const r = await victim.post('/api/auth/verify', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, NOT_FOUND_MSG);
    assert.equal(hasSession(r), false);
  }
  assert.equal((await victim.get('/api/me')).json.user, null);
  assert.equal(userCount(srv), 0);

  // 再送もできない（メールも増えない）
  rewind(srv);
  for (const body of [{}, { email: 'victim@example.com' }]) {
    const r = await victim.post('/api/auth/resend', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, NOT_FOUND_MSG);
  }
  await sleep(200);
  assert.equal(srv.mailCount('victim@example.com'), 1);

  // 行は何も変わらない（間違いの回数も増えない）。申し込んだ側のブラウザは、そのまま確認できる
  const after = rowOf(srv, 'victim@example.com');
  assert.equal(after.attempts, before.attempts);
  assert.equal(after.resend_count, before.resend_count);
  assert.equal(after.code_hash, before.code_hash);
  const ok = await mallory.post('/api/auth/verify', { code });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.verified, true);
  // 本人のブラウザは、人の選択もできない
  const steal = await victim.post('/api/auth/complete', { new_name: 'V' });
  assert.equal(steal.status, 400);
  assert.equal(steal.json.noPending, true);
  assert.equal(hasSession(steal), false);
  assert.equal(userCount(srv), 0);
  const done = await mallory.post('/api/auth/complete', { new_name: 'M' });
  assert.equal(done.json.user.email, 'victim@example.com');
});

test('Cookie があっても、確認待ちの行が消えていれば「手続きが見つかりません」で、何も数えない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', signupBody('a@example.com'));
  await srv.waitMail('a@example.com');
  const db = srv.openDb();
  db.prepare('DELETE FROM pending_signups').run();
  db.close();
  const r = await c.post('/api/auth/verify', { code: '123456' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, NOT_FOUND_MSG);
  assert.equal((await c.post('/api/auth/resend', {})).json.error, NOT_FOUND_MSG);
});

// ---- (b) 2つの確認待ちは、それぞれの Cookie でだけ確認できる ----

test('2つのメールで同時に確認待ちがあっても、それぞれのブラウザは自分の行だけを確認できる', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const x = new Client(srv.base);
  const y = new Client(srv.base);
  assert.equal((await x.post('/api/auth/signup', signupBody('x@example.com'))).status, 200);
  assert.equal((await y.post('/api/auth/signup', signupBody('y@example.com'))).status, 200);
  const codeX = codeOf(await srv.waitMail('x@example.com'));
  const codeY = codeOf(await srv.waitMail('y@example.com'));
  assert.notEqual(rowOf(srv, 'x@example.com').browser_hash, rowOf(srv, 'y@example.com').browser_hash);

  // x のブラウザが y のコードを入れても、x の行の間違いに数えられるだけ。y の行には何も起きない
  if (codeX !== codeY) {
    const wrong = await x.post('/api/auth/verify', { code: codeY });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /^確認コードが違います（あと 4 回）$/);
    assert.equal(rowOf(srv, 'x@example.com').attempts, 1);
    assert.equal(rowOf(srv, 'y@example.com').attempts, 0);
  }

  // 再送も、本文のメールではなく Cookie の行に対して行われる
  rewind(srv);
  assert.equal((await x.post('/api/auth/resend', { email: 'y@example.com' })).status, 200);
  const newX = codeOf(await srv.waitMail('x@example.com', 2));
  await sleep(200);
  assert.equal(srv.mailCount('x@example.com'), 2);
  assert.equal(srv.mailCount('y@example.com'), 1);
  assert.equal(rowOf(srv, 'x@example.com').resend_count, 1);
  assert.equal(rowOf(srv, 'y@example.com').resend_count, 0);

  assert.equal((await x.post('/api/auth/verify', { code: newX })).status, 200);
  assert.equal((await y.post('/api/auth/verify', { code: codeY })).status, 200);
  const okX = await x.post('/api/auth/complete', { new_name: 'X' });
  assert.equal(okX.status, 200);
  assert.equal(okX.json.user.email, 'x@example.com');
  const okY = await y.post('/api/auth/complete', { new_name: 'Y' });
  assert.equal(okY.status, 200);
  assert.equal(okY.json.user.email, 'y@example.com');
  assert.equal((await x.get('/api/me')).json.user.email, 'x@example.com');
  assert.equal((await y.get('/api/me')).json.user.email, 'y@example.com');
});

test('同じブラウザで別のメールを申し込むと Cookie が入れ替わり、前の確認待ちはそのブラウザからは確認できない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const first = await c.post('/api/auth/signup', signupBody('x@example.com'));
  const second = await c.post('/api/auth/signup', signupBody('y@example.com'));
  const tokenOf = (res) => signupCookie(res).split(';')[0].split('=')[1];
  assert.notEqual(tokenOf(first), tokenOf(second));
  assert.equal(c.jar.get('iruinai_signup'), tokenOf(second));
  const codeX = codeOf(await srv.waitMail('x@example.com'));
  const codeY = codeOf(await srv.waitMail('y@example.com'));
  if (codeX !== codeY) assert.equal((await c.post('/api/auth/verify', { code: codeX })).status, 400);
  assert.equal(rowOf(srv, 'x@example.com').attempts, 0); // x の行には届いていない
  assert.equal((await c.post('/api/auth/verify', { code: codeY })).status, 200);
  const ok = await c.post('/api/auth/complete', { new_name: 'Y' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.email, 'y@example.com');
});

// ---- (c) 同じブラウザでの申し込み直し ----

test('同じブラウザが同じメールをもう一度申し込むと resumed。メールは送らず、行も数も変えない', async (t) => {
  const srv = await startServer({ MAIL_IP_LIMIT: '1' }); // 送信の上限は 1通。resumed が上限を使わないことも確かめる
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  assert.equal((await c.post('/api/auth/signup', signupBody('a@example.com'))).status, 200);
  const code = codeOf(await srv.waitMail('a@example.com'));
  const before = rowOf(srv, 'a@example.com');

  // 60秒以内でも、あとでも、何度でも resumed（429 にも 400 にもならない）。申し込みの内容（パスワード）は、最初のまま
  for (let i = 0; i < 3; i++) {
    const r = await c.post('/api/auth/signup', signupBody('A@Example.com', { password: 'a-different-password' }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { ok: true, resumed: true });
    if (i === 1) rewind(srv);
  }
  await sleep(200);
  assert.equal(srv.mailCount('a@example.com'), 1);
  const after = rowOf(srv, 'a@example.com');
  assert.equal(after.attempts, before.attempts);
  assert.equal(after.resend_count, before.resend_count);
  assert.equal(after.code_hash, before.code_hash);
  assert.equal(after.expires_at, before.expires_at);
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.browser_hash, before.browser_hash);
  assert.equal(after.sent_at, before.sent_at - 61000); // rewind した分だけ。resumed では動かない

  // 送信の上限（1通）は、resumed では減らない。別のメールの申し込みは、上限に当たって 429
  assert.equal((await new Client(srv.base).post('/api/auth/signup', signupBody('b@example.com'))).status, 429);

  assert.equal((await c.post('/api/auth/verify', { code })).status, 200);
  assert.equal((await c.post('/api/auth/complete', { new_name: 'A' })).status, 200);
  const db = srv.openDb();
  const u = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('a@example.com');
  db.close();
  assert.equal(verifyPassword('password123', u.password_hash), true);
});

test('別のブラウザが同じメールを申し込むと、今までどおり 429（60秒以内）か 400（確認待ち）。上書きもメールも送らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const owner = new Client(srv.base);
  assert.equal((await owner.post('/api/auth/signup', signupBody('a@example.com', { password: 'owner-password' }))).status, 200);
  await srv.waitMail('a@example.com');
  const before = rowOf(srv, 'a@example.com');

  const other = new Client(srv.base);
  const soon = await other.post('/api/auth/signup', signupBody('a@example.com', { password: 'other-password' }));
  assert.equal(soon.status, 429);
  assert.equal(signupCookie(soon), undefined);
  rewind(srv);
  const later = await other.post('/api/auth/signup', signupBody('a@example.com', { password: 'other-password' }));
  assert.equal(later.status, 400);
  assert.equal(later.json.error, PENDING_MSG);
  assert.equal(signupCookie(later), undefined);
  assert.equal(other.jar.has('iruinai_signup'), false);

  await sleep(200);
  assert.equal(srv.mailCount('a@example.com'), 1);
  const after = rowOf(srv, 'a@example.com');
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.browser_hash, before.browser_hash);
  // 上書きされていないので、持ち主のブラウザは確認できる
  assert.equal((await owner.post('/api/auth/verify', { code: codeOf(await srv.waitMail('a@example.com')) })).status, 200);
  assert.equal((await owner.post('/api/auth/complete', { new_name: 'A' })).status, 200);
});

test('resumed のあとも、同じブラウザで再送とコードの確認ができる（戻るボタンや再読み込みで行き詰まらない）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', signupBody('a@example.com'));
  await srv.waitMail('a@example.com');
  assert.equal((await c.post('/api/auth/signup', signupBody('a@example.com'))).json.resumed, true);
  rewind(srv);
  assert.equal((await c.post('/api/auth/resend', {})).status, 200);
  const code = codeOf(await srv.waitMail('a@example.com', 2));
  assert.equal((await c.post('/api/auth/verify', { code })).status, 200);
  assert.equal((await c.post('/api/auth/complete', { new_name: 'A' })).status, 200);
});

// ---- (d) GET /api/auth/pending ----

test('GET /api/auth/pending: Cookie がなければ null（メールアドレスは何も漏らさない）。Cookie があれば自分の確認待ちだけ', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const owner = new Client(srv.base);
  const stranger = new Client(srv.base);

  const none = await stranger.get('/api/auth/pending');
  assert.equal(none.status, 200);
  assert.deepEqual(none.json, { pending: null });

  await owner.post('/api/auth/signup', signupBody('a@example.com'));
  await srv.waitMail('a@example.com');
  const row = rowOf(srv, 'a@example.com');

  // 他人（Cookie なし）にも、でたらめな Cookie にも、何も見せない
  const seen = await stranger.get('/api/auth/pending');
  assert.deepEqual(seen.json, { pending: null });
  assert.doesNotMatch(seen.text, /a@example\.com/);
  const forged = new Client(srv.base);
  forged.jar.set('iruinai_signup', 'forged-token');
  forged.paths.set('iruinai_signup', '/api/auth');
  assert.deepEqual((await forged.get('/api/auth/pending')).json, { pending: null });

  const mine = await owner.get('/api/auth/pending');
  assert.equal(mine.status, 200);
  assert.match(mine.headers.get('cache-control') || '', /no-store/);
  assert.deepEqual(mine.json, {
    pending: { email: 'a@example.com', expires_at: row.expires_at, resend_available_at: row.sent_at + 60 * 1000, locked: false, verified: false },
  });
  assert.ok(row.expires_at > Date.now() && row.expires_at <= Date.now() + 10 * 60 * 1000);
});

test('GET /api/auth/pending: 間違いが 5回で locked、再送で resend_available_at が進む、期限切れ・確認後は null', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', signupBody('a@example.com'));
  const code = codeOf(await srv.waitMail('a@example.com'));
  const wrong = code === '000000' ? '111111' : '000000';

  rewind(srv);
  const resendable = (await c.get('/api/auth/pending')).json.pending;
  assert.ok(resendable.resend_available_at < Date.now()); // 60秒たてば、もう再送できる時刻
  assert.equal((await c.post('/api/auth/resend', {})).status, 200);
  const code2 = codeOf(await srv.waitMail('a@example.com', 2));
  const sentAt = rowOf(srv, 'a@example.com').sent_at;
  assert.equal((await c.get('/api/auth/pending')).json.pending.resend_available_at, sentAt + 60 * 1000);

  for (let i = 0; i < 5; i++) await c.post('/api/auth/verify', { code: wrong === code2 ? '222222' : wrong });
  const locked = (await c.get('/api/auth/pending')).json.pending;
  assert.equal(locked.locked, true);
  assert.equal(locked.email, 'a@example.com');

  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();
  assert.deepEqual((await c.get('/api/auth/pending')).json, { pending: null });

  // 確認が済んだあとも null（行が消え、Cookie も消える）
  const d = new Client(srv.base);
  await d.post('/api/auth/signup', signupBody('b@example.com'));
  const codeB = codeOf(await srv.waitMail('b@example.com'));
  assert.equal((await d.get('/api/auth/pending')).json.pending.verified, false);
  assert.equal((await d.post('/api/auth/verify', { code: codeB })).status, 200);
  assert.equal((await d.get('/api/auth/pending')).json.pending.verified, true); // 人を選ぶ段階。開き直しても戻れる
  assert.equal((await d.post('/api/auth/complete', { new_name: 'B' })).status, 200);
  assert.deepEqual((await d.get('/api/auth/pending')).json, { pending: null });
});

test('GET /api/auth/pending も合言葉の内側。合言葉がなければ 401', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  assert.equal((await c.get('/api/auth/pending')).status, 401);
  await c.postForm('/login', { password: 'himitsu' });
  assert.deepEqual((await c.get('/api/auth/pending')).json, { pending: null });
});

// ---- (e) Cookie の属性 ----

test('申し込みの Cookie: HttpOnly・SameSite=Lax・Path=/api/auth・Max-Age=3600。DB にはトークンの hash だけが入る', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const r = await c.post('/api/auth/signup', signupBody('a@example.com'));
  const line = signupCookie(r);
  assert.ok(line, 'Set-Cookie: iruinai_signup がある');
  assert.match(line, /; HttpOnly/);
  assert.match(line, /; SameSite=Lax/);
  assert.match(line, /; Path=\/api\/auth(;|$)/);
  assert.match(line, /; Max-Age=3600/);
  assert.doesNotMatch(line, /Secure/);

  const token = line.split(';')[0].split('=')[1];
  assert.ok(token.length >= 32);
  const row = rowOf(srv, 'a@example.com');
  assert.notEqual(row.browser_hash, token);
  assert.equal(row.browser_hash, sha256(token));

  // Path が /api/auth なので、ほかの API には送られない（Client が Path を見て送る）
  assert.match(c.cookieHeader('/api/auth/verify'), /iruinai_signup=/);
  assert.match(c.cookieHeader('/api/auth'), /iruinai_signup=/);
  assert.doesNotMatch(c.cookieHeader('/api/stays'), /iruinai_signup/);
  assert.doesNotMatch(c.cookieHeader('/api/authx'), /iruinai_signup/);
  assert.doesNotMatch(c.cookieHeader('/'), /iruinai_signup/);
});

test('申し込みの Cookie は、コードの確認ではまだ消えず、人を選んで登録が済むと同じ Path で消える（Max-Age=0）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', signupBody('a@example.com'));
  const code = codeOf(await srv.waitMail('a@example.com'));
  assert.ok(c.jar.has('iruinai_signup'));
  const v = await c.post('/api/auth/verify', { code });
  assert.equal(v.status, 200);
  assert.equal(signupCookie(v), undefined); // 人の選択が残っているので、まだ手放さない
  assert.ok(c.jar.has('iruinai_signup'));
  assert.equal(hasSession(v), false);
  const d = await c.post('/api/auth/complete', { new_name: 'A' });
  assert.equal(d.status, 200);
  const cleared = signupCookie(d);
  assert.match(cleared, /^iruinai_signup=;/);
  assert.match(cleared, /; Max-Age=0/);
  assert.match(cleared, /; Path=\/api\/auth(;|$)/);
  assert.match(cleared, /; HttpOnly/);
  assert.match(cleared, /; SameSite=Lax/);
  assert.equal(c.jar.has('iruinai_signup'), false);
  assert.equal(c.jar.has('iruinai_session'), true);
  assert.equal(rows(srv).length, 0);
});

test('間違ったコードでは Cookie は消えない。何度でもやり直せる', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', signupBody('a@example.com'));
  const code = codeOf(await srv.waitMail('a@example.com'));
  const wrong = await c.post('/api/auth/verify', { code: code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.equal(signupCookie(wrong), undefined);
  assert.ok(c.jar.has('iruinai_signup'));
  assert.equal((await c.post('/api/auth/verify', { code })).status, 200);
  // 人の選択が通らなかった（不正な入力）ときも、Cookie は消えず、選び直せる
  const bad = await c.post('/api/auth/complete', { new_name: '' });
  assert.equal(bad.status, 400);
  assert.equal(signupCookie(bad), undefined);
  assert.ok(c.jar.has('iruinai_signup'));
  assert.equal((await c.post('/api/auth/complete', { new_name: 'A' })).status, 200);
});

test('PUBLIC_URL が https のとき、申し込みの Cookie にも、消すときにも Secure が付く', async (t) => {
  const srv = await startServer({ PUBLIC_URL: 'https://room.example.com' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const r = await c.post('/api/auth/signup', signupBody('a@example.com'));
  assert.match(signupCookie(r), /; Secure/);
  const code = codeOf(await srv.waitMail('a@example.com'));
  await c.post('/api/auth/verify', { code });
  const v = await c.post('/api/auth/complete', { new_name: 'A' });
  assert.match(signupCookie(v), /; Max-Age=0/);
  assert.match(signupCookie(v), /; Secure/);
});

test('メールを送れなかった申し込みには、Cookie を付けない（行も作らない）', async (t) => {
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const r = await c.post('/api/auth/signup', signupBody('a@example.com'));
  assert.equal(r.status, 502);
  assert.equal(signupCookie(r), undefined);
  assert.equal(c.jar.has('iruinai_signup'), false);
  assert.equal(rows(srv).length, 0);
});

test('入力の誤りや上限超えの申し込みには、Cookie を付けない', async (t) => {
  const srv = await startServer({ MAIL_IP_LIMIT: '1' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const bad = await c.post('/api/auth/signup', { email: 'not-an-email', password: 'password123' });
  assert.equal(bad.status, 400);
  assert.equal(signupCookie(bad), undefined);
  assert.equal((await c.post('/api/auth/signup', signupBody('a@example.com'))).status, 200);
  const capped = await new Client(srv.base).post('/api/auth/signup', signupBody('b@example.com'));
  assert.equal(capped.status, 429);
  assert.equal(signupCookie(capped), undefined);
});

test('期限切れの確認待ちは、その Cookie があっても確認できず、同じメールで申し込み直せる（新しい Cookie に替わる）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', signupBody('a@example.com'));
  const oldToken = c.jar.get('iruinai_signup');
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();
  const expired = await c.post('/api/auth/verify', { code: '123456' });
  assert.equal(expired.status, 400);
  assert.match(expired.json.error, /有効期限/);

  const again = await c.post('/api/auth/signup', signupBody('a@example.com'));
  assert.deepEqual(again.json, { ok: true }); // resumed ではない（期限切れの行は引き継がない）
  assert.notEqual(c.jar.get('iruinai_signup'), oldToken);
  const code = codeOf(await srv.waitMail('a@example.com', 2));
  assert.equal((await c.post('/api/auth/verify', { code })).status, 200);
  assert.equal((await c.post('/api/auth/complete', { new_name: 'A' })).status, 200);
});
