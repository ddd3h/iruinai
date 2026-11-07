const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
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
const signupBody = (email) => ({ email, password: 'password123' });

test('メールを送る 3つの API は同じ IP の上限を分け合い、超えたら 429 でメールも行も作らない。1時間たつと戻る', async (t) => {
  const srv = await startServer({ MAIL_IP_LIMIT: '3' }, { fakeClock: true });
  t.after(() => srv.stop());
  seedUser(srv, 'known@example.com');
  const c = new Client(srv.base);

  // 1: signup  2: resend（前回から 60秒あけたあと）  3: forgot
  assert.equal((await c.post('/api/auth/signup', signupBody('s1@example.com'))).status, 200);
  await srv.waitMail('s1@example.com', 1);
  srv.advanceClock(61 * 1000);
  assert.equal((await c.post('/api/auth/resend', {})).status, 200);
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
  const resend = await c.post('/api/auth/resend', {});
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

  // 1時間たつと、古い分が数えから外れて戻る。signup も forgot も通る
  srv.advanceClock(60 * MIN);
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
    ['/api/auth/signup', { email: 'not-an-email', password: 'password123' }],
    ['/api/auth/signup', { email: 'x@example.com', password: 'short' }],
    ['/api/auth/signup', { email: 'x@example.com' }], // パスワードがない
    ['/api/auth/signup', signupBody('known@example.com')], // 登録済み
    ['/api/auth/resend', {}], // 確認待ちがない（この Client は申し込んだことがないので Cookie がない）
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

test('1つの IP は 1時間に 10回まで（既定）。登録の有無にかかわらず、11回目は 429', async (t) => {
  const srv = await startServer({}, { fakeClock: true });
  t.after(() => srv.stop());
  seedUser(srv, 'known@example.com');
  const c = new Client(srv.base);
  // 10回の forgot（存在しない宛先）。メールは出ないが、書式が正しい要求は全部数える
  for (let i = 1; i <= 10; i++) {
    const r = await c.post('/api/auth/forgot', { email: `nobody${i}@example.com` });
    assert.equal(r.status, 200, `${i}回目`);
    assert.deepEqual(r.json, { ok: true });
  }
  // 11回目は、登録済みの宛先（上限がなければ送られる）も、未登録の宛先も、同じ 429
  const known = await c.post('/api/auth/forgot', { email: 'known@example.com' });
  const unknown = await c.post('/api/auth/forgot', { email: 'nobody11@example.com' });
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
  assert.equal((await c.post('/api/auth/signup', signupBody('late@example.com'))).status, 429); // 10分では戻らない（IP の窓も 1時間）
  srv.advanceClock(50 * MIN);
  assert.equal((await c.post('/api/auth/signup', signupBody('late@example.com'))).status, 200);
  await srv.waitMail('late@example.com', 1);
});

test('登録の申し込み 10回までは通り、11回目は 429 でメールも行も作らない（既定の上限）', async (t) => {
  const srv = await startServer({}, { fakeClock: true });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  for (let i = 1; i <= 10; i++) {
    const r = await c.post('/api/auth/signup', signupBody(`u${i}@example.com`));
    assert.equal(r.status, 200, `${i}回目: ${JSON.stringify(r.json)}`);
  }
  await waitFor(() => srv.mails().length >= 10, '10 mails');
  const r = await c.post('/api/auth/signup', signupBody('u11@example.com'));
  assert.equal(r.status, 429);
  assert.equal(r.json.error, CAP_MSG);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(srv.mails().length, 10);
  assert.equal(pendingCount(srv, 'u11@example.com'), 0);
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

  // 11分たっても、全体の窓（1時間）の中ではまだ止まったまま
  srv.advanceClock(11 * MIN);
  assert.equal((await c.post('/api/auth/signup', signupBody('g5@example.com'))).status, 429);
  srv.advanceClock(50 * MIN); // 合計 61分
  assert.equal((await c.post('/api/auth/signup', signupBody('g5@example.com'))).status, 200);
  await srv.waitMail('g5@example.com', 1);
  assert.equal((await new Client(srv.base).post('/api/auth/forgot', { email: 'known@example.com' })).status, 200);
  await srv.waitMail('known@example.com', 1);
});

// ---- IP ごとの分離（1つの IP が上限に達しても、別の IP は影響を受けない） ----

// 127.0.0.2 から接続するには、Linux のように 127.0.0.0/8 全体が自分のアドレスの環境が要る。バインドできなければ飛ばす
const canBindLoopbackAlias = () => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '127.0.0.2', () => s.close(() => resolve(true)));
});

// 送信元のアドレスを指定して JSON を POST する
function postFrom(srv, localAddress, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(srv.base + urlPath, {
      method: 'POST', localAddress, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('IP ごとの上限は IP ごとに数える。1つの IP が使い切っても、別の IP は（全体の上限まで）送れる', async (t) => {
  if (!(await canBindLoopbackAlias())) return t.skip('127.0.0.2 にバインドできない環境');
  const srv = await startServer({ MAIL_IP_LIMIT: '2', MAIL_GLOBAL_LIMIT: '4' });
  t.after(() => srv.stop());
  for (const n of [1, 2]) assert.equal((await postFrom(srv, '127.0.0.1', '/api/auth/signup', signupBody(`a${n}@example.com`))).status, 200, `127.0.0.1 の ${n}回目`);
  const blocked = await postFrom(srv, '127.0.0.1', '/api/auth/signup', signupBody('a3@example.com'));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, CAP_MSG);
  // 別の IP は、127.0.0.1 が使い切ったあとでも送れる
  for (const n of [1, 2]) assert.equal((await postFrom(srv, '127.0.0.2', '/api/auth/signup', signupBody(`b${n}@example.com`))).status, 200, `127.0.0.2 の ${n}回目`);
  // 127.0.0.2 も 2回で止まる（全体の上限 4 にも達している）
  assert.equal((await postFrom(srv, '127.0.0.2', '/api/auth/signup', signupBody('b3@example.com'))).status, 429);
  await waitFor(() => srv.mails().length >= 4, '4 mails');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(srv.mails().length, 4);
  assert.equal(pendingCount(srv, 'a3@example.com'), 0);
});

// ---- 設定の警告 ----

// 起動時の警告は、起動の行のあとに出る。アイコンの縮小の行（警告より後）まで待ってから読む
const startupOutput = async (srv) => {
  await waitFor(() => srv.output().includes('アイコンの縮小'), 'startup output');
  return srv.output();
};

test('MAIL_IP_LIMIT・MAIL_GLOBAL_LIMIT に使えない値を書くと、起動時に警告を出して既定の値を使う', async (t) => {
  // 0 は「無効」ではなく、使えない値。既定（IP ごとに 10回）のまま動く
  for (const bad of ['0', '-1', 'abc', '0x10', '1e3', '1.5', ' 5']) {
    const srv = await startServer({ MAIL_IP_LIMIT: bad });
    t.after(() => srv.stop());
    const out = await startupOutput(srv);
    assert.match(out, new RegExp(`警告: MAIL_IP_LIMIT=${JSON.stringify(bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} は使えない値です`), bad);
    assert.match(out, /既定の 10 を使います/, bad);
    const c = new Client(srv.base);
    for (let i = 1; i <= 10; i++) assert.equal((await c.post('/api/auth/signup', signupBody(`u${i}@example.com`))).status, 200, `${bad}: ${i}回目`);
    assert.equal((await c.post('/api/auth/signup', signupBody('u11@example.com'))).status, 429, bad);
  }
  const g = await startServer({ MAIL_GLOBAL_LIMIT: 'many' });
  t.after(() => g.stop());
  assert.match(await startupOutput(g), /警告: MAIL_GLOBAL_LIMIT="many" は使えない値です.*既定の 100/);
});

test('正しい値・未設定・空のときは、警告を出さない', async (t) => {
  for (const env of [{}, { MAIL_IP_LIMIT: '', MAIL_GLOBAL_LIMIT: '' }, { MAIL_IP_LIMIT: '5', MAIL_GLOBAL_LIMIT: '50' }]) {
    const srv = await startServer(env);
    t.after(() => srv.stop());
    assert.doesNotMatch(await startupOutput(srv), /警告: MAIL_/, JSON.stringify(env));
  }
});

test('MAIL_IP_LIMIT が MAIL_GLOBAL_LIMIT 以上のときは、IP ごとの上限が働かないと警告する', async (t) => {
  const same = await startServer({ MAIL_IP_LIMIT: '100', MAIL_GLOBAL_LIMIT: '100' });
  t.after(() => same.stop());
  assert.match(await startupOutput(same), /警告: MAIL_IP_LIMIT（100）が MAIL_GLOBAL_LIMIT（100）以上です/);
  const over = await startServer({ MAIL_IP_LIMIT: '1000', MAIL_GLOBAL_LIMIT: '4' });
  t.after(() => over.stop());
  assert.match(await startupOutput(over), /警告: MAIL_IP_LIMIT（1000）が MAIL_GLOBAL_LIMIT（4）以上です/);
});
