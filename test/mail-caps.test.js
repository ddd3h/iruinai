const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, waitFor } = require('./helpers');
const { hashPassword } = require('../lib/secrets');

const CAP_MSG = '送信の回数が多すぎます。しばらくしてからやり直してください';
const MIN = 60 * 1000;

// 登録済みのユーザーを DB に直接入れる（登録 API を通すと、上限の数に数えられてしまうため）
function seedUser(srv, email, name = 'K') {
  const db = srv.openDb();
  const pid = Number(db.prepare('INSERT INTO people (name) VALUES (?)').run(name).lastInsertRowid);
  db.prepare('INSERT INTO users (email, password_hash, person_id, created_at) VALUES (?, ?, ?, ?)')
    .run(email, hashPassword('password123'), pid, 1);
  db.close();
}
const pendingCount = (srv, email) => {
  const db = srv.openDb();
  const n = db.prepare('SELECT COUNT(*) AS n FROM pending_signups WHERE email = ?').get(email).n;
  db.close();
  return n;
};
const tokenCount = (srv) => {
  const db = srv.openDb();
  const n = db.prepare('SELECT COUNT(*) AS n FROM reset_tokens').get().n;
  db.close();
  return n;
};
const signupBody = (email) => ({ email, password: 'password123', new_name: 'N' });

test('メールを送る 3つの API は同じ IP の上限を分け合い、超えたら 429 でメールも行も作らない。10分たつと戻る', async (t) => {
  const srv = await startServer({ MAIL_IP_LIMIT: '3' }, { fakeClock: true });
  t.after(() => srv.stop());
  seedUser(srv, 'known@example.com');
  const c = new Client(srv.base);

  // 1: signup  2: resend（前回から 60秒あけたあと）  3: forgot
  assert.equal((await c.post('/api/auth/signup', signupBody('s1@example.com'))).status, 200);
  await srv.waitMail('s1@example.com', 1);
  srv.advanceClock(61 * 1000);
  assert.equal((await c.post('/api/auth/resend', { email: 's1@example.com' })).status, 200);
  await srv.waitMail('s1@example.com', 2);
  assert.equal((await c.post('/api/auth/forgot', { email: 'known@example.com' })).status, 200);
  await srv.waitMail('known@example.com', 1);

  // forgot の宛先ごとの 60秒の間隔はあけておく（上限に当たらなければ、次の forgot も本当に送られる状況）
  srv.advanceClock(61 * 1000);
  const tokens = tokenCount(srv);

  // ここから上限超え。どれも、上限がなければメールを送る要求
  const signup = await c.post('/api/auth/signup', signupBody('s2@example.com'));
  assert.equal(signup.status, 429);
  assert.equal(signup.json.error, CAP_MSG);
  const resend = await c.post('/api/auth/resend', { email: 's1@example.com' });
  assert.equal(resend.status, 429);
  assert.equal(resend.json.error, CAP_MSG);
  const forgotKnown = await c.post('/api/auth/forgot', { email: 'known@example.com' });
  const forgotUnknown = await c.post('/api/auth/forgot', { email: 'nobody@example.com' });
  assert.equal(forgotKnown.status, 429);
  assert.equal(forgotKnown.json.error, CAP_MSG);
  // 登録の有無で応答が変わらない（本文もステータスも同じ）
  assert.equal(forgotUnknown.status, forgotKnown.status);
  assert.equal(forgotUnknown.text, forgotKnown.text);

  await new Promise((r) => setTimeout(r, 200)); // 遅れて送られるメールがないことを確かめる余裕
  assert.equal(srv.mailCount('s2@example.com'), 0);
  assert.equal(pendingCount(srv, 's2@example.com'), 0);
  assert.equal(srv.mailCount('s1@example.com'), 2);
  assert.equal(srv.mailCount('known@example.com'), 1);
  assert.equal(tokenCount(srv), tokens); // 新しい再設定トークンも作られていない

  // 10分たつと、古い分が数えから外れて戻る。signup も forgot も通る
  srv.advanceClock(10 * MIN);
  assert.equal((await c.post('/api/auth/forgot', { email: 'known@example.com' })).status, 200);
  await srv.waitMail('known@example.com', 2);
  assert.equal((await c.post('/api/auth/signup', signupBody('s3@example.com'))).status, 200);
  await srv.waitMail('s3@example.com', 1);
});

test('メールを送らずに終わる要求（入力の誤りなど）は、上限に数えない', async (t) => {
  const srv = await startServer({ MAIL_IP_LIMIT: '3' }, { fakeClock: true });
  t.after(() => srv.stop());
  seedUser(srv, 'known@example.com');
  const c = new Client(srv.base);

  const rejected = [
    ['/api/auth/signup', { email: 'not-an-email', password: 'password123', new_name: 'N' }],
    ['/api/auth/signup', { email: 'x@example.com', password: 'short', new_name: 'N' }],
    ['/api/auth/signup', { email: 'x@example.com', password: 'password123' }], // 名前も人もない
    ['/api/auth/signup', signupBody('known@example.com')], // 登録済み
    ['/api/auth/resend', { email: 'nobody@example.com' }], // 確認待ちがない
  ];
  for (let round = 0; round < 3; round++) {
    for (const [url, body] of rejected) assert.equal((await c.post(url, body)).status, 400, `${url} ${JSON.stringify(body)}`);
    // 書式が正しくない forgot は、今までどおり同じ応答で、数えない
    for (const email of ['garbage', '', 'a b@example.com']) {
      const r = await c.post('/api/auth/forgot', { email });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
    }
  }
  // 数えていなければ、3通はまだ送れて、4通目で止まる
  for (const n of ['a', 'b', 'c']) assert.equal((await c.post('/api/auth/signup', signupBody(`${n}@example.com`))).status, 200, n);
  assert.equal((await c.post('/api/auth/signup', signupBody('d@example.com'))).status, 429);
  assert.equal(srv.mailCount('d@example.com'), 0);
});

test('1つの IP は 10分に 30通まで（既定）。登録の有無にかかわらず、31通目は 429', async (t) => {
  const srv = await startServer({}, { fakeClock: true });
  t.after(() => srv.stop());
  seedUser(srv, 'known@example.com');
  const c = new Client(srv.base);
  // 30回の forgot（存在しない宛先）。メールは出ないが、書式が正しい要求は全部数える
  for (let i = 1; i <= 30; i++) {
    const r = await c.post('/api/auth/forgot', { email: `nobody${i}@example.com` });
    assert.equal(r.status, 200, `${i}回目`);
    assert.deepEqual(r.json, { ok: true });
  }
  // 31回目は、登録済みの宛先（上限がなければ送られる）も、未登録の宛先も、同じ 429
  const known = await c.post('/api/auth/forgot', { email: 'known@example.com' });
  const unknown = await c.post('/api/auth/forgot', { email: 'nobody31@example.com' });
  assert.equal(known.status, 429);
  assert.equal(known.json.error, CAP_MSG);
  assert.equal(unknown.status, 429);
  assert.equal(unknown.text, known.text);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(srv.mailCount('known@example.com'), 0);
  assert.equal(tokenCount(srv), 0);
  // 登録の申し込みも、同じ上限に当たる
  assert.equal((await c.post('/api/auth/signup', signupBody('late@example.com'))).status, 429);
  assert.equal(srv.mailCount('late@example.com'), 0);

  srv.advanceClock(10 * MIN + 1000);
  assert.equal((await c.post('/api/auth/signup', signupBody('late@example.com'))).status, 200);
  await srv.waitMail('late@example.com', 1);
});

test('登録の申し込み 30通までは通り、31通目は 429 でメールも行も作らない（既定の上限）', async (t) => {
  const srv = await startServer({}, { fakeClock: true });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  for (let i = 1; i <= 30; i++) {
    const r = await c.post('/api/auth/signup', signupBody(`u${i}@example.com`));
    assert.equal(r.status, 200, `${i}回目: ${JSON.stringify(r.json)}`);
  }
  await waitFor(() => srv.mails().length >= 30, '30 mails');
  const r = await c.post('/api/auth/signup', signupBody('u31@example.com'));
  assert.equal(r.status, 429);
  assert.equal(r.json.error, CAP_MSG);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(srv.mails().length, 30);
  assert.equal(pendingCount(srv, 'u31@example.com'), 0);
});

test('全体の上限は 1時間（IP の上限とは別）。超えたら誰でも 429 で、1時間たつと戻る', async (t) => {
  const srv = await startServer({ MAIL_IP_LIMIT: '1000', MAIL_GLOBAL_LIMIT: '4' }, { fakeClock: true });
  t.after(() => srv.stop());
  seedUser(srv, 'known@example.com');
  const c = new Client(srv.base);
  for (let i = 1; i <= 4; i++) assert.equal((await c.post('/api/auth/signup', signupBody(`g${i}@example.com`))).status, 200, `${i}通目`);
  await waitFor(() => srv.mails().length >= 4, '4 mails');

  const over = await c.post('/api/auth/signup', signupBody('g5@example.com'));
  assert.equal(over.status, 429);
  assert.equal(over.json.error, CAP_MSG);
  const forgot = await c.post('/api/auth/forgot', { email: 'known@example.com' });
  assert.equal(forgot.status, 429);
  assert.equal(forgot.json.error, CAP_MSG);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(srv.mails().length, 4);
  assert.equal(pendingCount(srv, 'g5@example.com'), 0);

  // IP の窓（10分）がたっても、全体の窓（1時間）の中ではまだ止まったまま
  srv.advanceClock(11 * MIN);
  assert.equal((await c.post('/api/auth/signup', signupBody('g5@example.com'))).status, 429);
  srv.advanceClock(50 * MIN); // 合計 61分
  assert.equal((await c.post('/api/auth/signup', signupBody('g5@example.com'))).status, 200);
  await srv.waitMail('g5@example.com', 1);
  assert.equal((await new Client(srv.base).post('/api/auth/forgot', { email: 'known@example.com' })).status, 200);
  await srv.waitMail('known@example.com', 1);
});
