const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startServer, Client } = require('./helpers');
const { hashPassword, sha256 } = require('../lib/secrets');

const codeOf = (mail) => mail.text.match(/確認コード: (\d{6})/)[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_MSG = '間違いが続いたため、このコードは使えません。10分ほど待ってから、もう一度登録してください';
const CAP_MSG = '再送できる回数の上限です。10分ほど待ってから、もう一度登録してください';
const EMAIL = 'a@example.com';
const REG = { email: EMAIL, password: 'password123', new_name: 'A' };

const row = (srv) => {
  const db = srv.openDb();
  const r = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(EMAIL);
  db.close();
  return r ? { ...r } : r;
};
// 前回の送信から 60秒以上たったことにする（resend の間隔の制限を通す）
const rewind = (srv) => {
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET sent_at = sent_at - 61000').run();
  db.close();
};
const verify = (c, code) => c.post('/api/auth/verify', { code });

test('再送しても間違いの回数は戻らない。再送後の 1回の間違いで、行がロックされる', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', REG);
  const first = codeOf(await srv.waitMail(EMAIL));
  const wrong = first === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal((await verify(c, wrong)).status, 400);
  assert.equal(row(srv).attempts, 4);

  rewind(srv);
  assert.equal((await c.post('/api/auth/resend', {})).status, 200);
  const second = codeOf(await srv.waitMail(EMAIL, 2));
  assert.equal(row(srv).attempts, 4); // 再送で 0 に戻らない

  // もう 1回間違えると、新しいコードでもロックされて通らない
  const w = second === '000000' ? '111111' : '000000';
  const last = await verify(c, w);
  assert.equal(last.status, 400);
  assert.equal(last.json.error, LOCK_MSG);
  assert.equal(row(srv).attempts, 5);
  const ok = await verify(c, second);
  assert.equal(ok.status, 400);
  assert.equal(ok.json.error, LOCK_MSG);
  assert.equal((await c.get('/api/me')).json.user, null);
});

test('ロックされた行の再送は、ロックの案内を返し、メールを送らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', REG);
  const good = codeOf(await srv.waitMail(EMAIL));
  const wrong = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await verify(c, wrong);
  assert.equal(row(srv).attempts, 5);

  rewind(srv);
  const before = row(srv);
  const r = await c.post('/api/auth/resend', {});
  assert.equal(r.status, 400);
  assert.equal(r.json.error, LOCK_MSG);
  await sleep(200);
  assert.equal(srv.mailCount(EMAIL), 1);
  assert.deepEqual(row(srv), before); // 行は何も変わらない
});

test('再送は 1つの登録につき 3回まで。4回目は断られ、メールは増えない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', REG);
  await srv.waitMail(EMAIL);
  assert.equal(row(srv).resend_count, 0); // 新しい登録は 0 から
  for (let n = 1; n <= 3; n++) {
    rewind(srv);
    const r = await c.post('/api/auth/resend', {});
    assert.equal(r.status, 200, `resend ${n}`);
    await srv.waitMail(EMAIL, n + 1);
    assert.equal(row(srv).resend_count, n);
  }
  rewind(srv);
  const r = await c.post('/api/auth/resend', {});
  assert.equal(r.status, 429);
  assert.equal(r.json.error, CAP_MSG);
  await sleep(200);
  assert.equal(srv.mailCount(EMAIL), 4);
  assert.equal(row(srv).resend_count, 3);

  // 最後に届いたコードと、サインアップ時のパスワードでは確認できる
  const last = codeOf((srv.mails().filter((m) => m.to === EMAIL)).at(-1));
  assert.equal((await verify(c, last)).status, 200);
});

test('登録し直すと再送の回数は 0 から数え直す（期限切れの行は新しい行に置き換わる）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', REG);
  await srv.waitMail(EMAIL);
  rewind(srv);
  assert.equal((await c.post('/api/auth/resend', {})).status, 200);
  assert.equal(row(srv).resend_count, 1);
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();
  assert.equal((await c.post('/api/auth/signup', REG)).status, 200);
  assert.equal(row(srv).resend_count, 0);
  assert.equal(row(srv).attempts, 0);
});

test('再送を同時に 2回送っても、メールは 1通だけ（二重クリックで 60秒の制限をすり抜けられない）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', REG);
  await srv.waitMail(EMAIL);
  rewind(srv);
  const rs = await Promise.all([c.post('/api/auth/resend', {}), c.post('/api/auth/resend', {})]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429]);
  await srv.waitMail(EMAIL, 2);
  await sleep(200);
  assert.equal(srv.mailCount(EMAIL), 2);
  assert.equal(row(srv).resend_count, 1);
});

// SMTP が遅くて失敗する状況を作る：接続を受けて、少し待ってから切る
function slowFailingSmtp() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.on('error', () => {});
      setTimeout(() => s.destroy(), 300);
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => { for (const s of sockets) s.destroy(); server.close(); },
    }));
  });
}

test('メールの送信を待つ間も二重に通らない。送信に失敗したら予約を戻す（1分待たされず、再送の回数も減らない）', async (t) => {
  const smtp = await slowFailingSmtp();
  t.after(() => smtp.close());
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port) });
  t.after(() => srv.stop());
  // SMTP では登録の時点でメールが失敗して行が消えるので、確認待ちの行を直接入れる（申し込んだブラウザの Cookie も用意する）
  const now = Date.now();
  const token = 'seeded-browser-token';
  const db = srv.openDb();
  db.prepare(`INSERT INTO pending_signups (email, password_hash, person_id, new_name, new_color, code_hash, expires_at, attempts, sent_at, browser_hash)
    VALUES (?, ?, NULL, 'A', '#4f7cff', ?, ?, 2, ?, ?)`).run(EMAIL, hashPassword('password123'), sha256('123456'), now + 5 * 60 * 1000, now - 120000, sha256(token));
  db.close();
  const before = row(srv);

  const c = new Client(srv.base);
  c.jar.set('iruinai_signup', token);
  c.paths.set('iruinai_signup', '/api/auth');
  const rs = await Promise.all([c.post('/api/auth/resend', {}), c.post('/api/auth/resend', {})]);
  // 1つ目は送信を試みて失敗（502）、2つ目は送信中の予約に引っかかる（429）
  assert.deepEqual(rs.map((r) => r.status).sort(), [429, 502]);
  assert.equal(rs.find((r) => r.status === 502).json.error, 'メールを送れませんでした');
  // 失敗したので、予約（コード・期限・送信時刻・再送の回数）は元に戻っている。間違いの回数はそのまま
  assert.deepEqual(row(srv), before);
  // 元のコードはまだ使える
  assert.equal((await verify(c, '123456')).status, 200);
});
