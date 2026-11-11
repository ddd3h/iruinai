const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, registerUser } = require('./helpers');
const { hashPassword } = require('../lib/secrets');

const PW = 'password123';
const SUBJECT = /APIトークン/;
const tokenMails = (srv, to) => srv.mails().filter((m) => m.to === to && SUBJECT.test(m.subject));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t, env = {}) {
  const srv = await startServer(env, { fakeClock: true });
  t.after(() => srv.stop());
  const a = await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  return { srv, a };
}

test('発行すると、本人のメールアドレスに通知が届く。トークン本体は書かない', async (t) => {
  const { srv, a } = await setup(t);
  const r = await a.post('/api/me/token', { password: PW });
  assert.equal(r.status, 200);
  await srv.waitMail('a@example.com', 2); // 登録の確認コード + 今回の通知
  const mails = tokenMails(srv, 'a@example.com');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^【.+】APIトークンが発行されました$/);
  assert.match(mails[0].text, /心当たりがない/);
  assert.ok(!mails[0].text.includes(r.json.token), '本文にトークン本体が入っている');
  assert.ok(!mails[0].text.includes('iruinai_'), '本文にトークンらしい文字列が入っている');
});

test('パスワードが違って発行されなかったときは、メールを送らない', async (t) => {
  const { srv, a } = await setup(t);
  assert.equal((await a.post('/api/me/token', { password: 'wrong-wrong' })).status, 400);
  await wait(300);
  assert.equal(tokenMails(srv, 'a@example.com').length, 0);
});

test('無効にしても、メールは送らない', async (t) => {
  const { srv, a } = await setup(t);
  await a.post('/api/me/token', { password: PW });
  await srv.waitMail('a@example.com', 2);
  assert.equal((await a.del('/api/me/token')).status, 200);
  await wait(300);
  assert.equal(tokenMails(srv, 'a@example.com').length, 1);
});

test('作り直したときも届く。ただし1ユーザーにつき1分に1通まで（それでも発行はできる）', async (t) => {
  const { srv, a } = await setup(t);
  const first = await a.post('/api/me/token', { password: PW });
  await srv.waitMail('a@example.com', 2);
  const second = await a.post('/api/me/token', { password: PW }); // 1分以内
  assert.equal(second.status, 200);
  assert.notEqual(second.json.token, first.json.token);
  await wait(300);
  assert.equal(tokenMails(srv, 'a@example.com').length, 1, '1分以内の2通目は送らない');

  srv.advanceClock(61 * 1000);
  assert.equal((await a.post('/api/me/token', { password: PW })).status, 200);
  await srv.waitMail('a@example.com', 3);
  assert.equal(tokenMails(srv, 'a@example.com').length, 2);
});

test('通知も、メールの送信上限（IP ごと）に数える。上限を超えたら通知は送らないが、発行はできる', async (t) => {
  // 1: 登録の確認コード  2: 1回目の通知  3: 2回目の通知
  const { srv, a } = await setup(t, { MAIL_IP_LIMIT: '3' });
  assert.equal((await a.post('/api/me/token', { password: PW })).status, 200);
  await srv.waitMail('a@example.com', 2);
  srv.advanceClock(61 * 1000);
  assert.equal((await a.post('/api/me/token', { password: PW })).status, 200);
  await srv.waitMail('a@example.com', 3);

  srv.advanceClock(61 * 1000);
  const over = await a.post('/api/me/token', { password: PW });
  assert.equal(over.status, 200, '上限を超えても発行はできる');
  assert.ok(over.json.token.startsWith('iruinai_'));
  await wait(300);
  assert.equal(tokenMails(srv, 'a@example.com').length, 2, '上限を超えた通知は送らない');

  // 通知が上限を使っているので、別の登録のメールも 429 になる
  const signup = await new Client(srv.base).post('/api/auth/signup', { email: 'b@example.com', password: PW });
  assert.equal(signup.status, 429);
});

test('メールの送信に失敗しても、発行は成功する（失敗はログに出す）', async (t) => {
  // 届かない SMTP（接続を拒否される）。ユーザーは、メールを送らずに DB に直接入れる
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', PUBLIC_URL: 'https://room.example.com' });
  t.after(() => srv.stop());
  const db = srv.openDb();
  const personId = Number(db.prepare("INSERT INTO people (name) VALUES ('T')").run().lastInsertRowid);
  db.prepare('INSERT INTO users (email, password_hash, person_id, created_at) VALUES (?, ?, ?, ?)')
    .run('t@example.com', hashPassword(PW), personId, Date.now());
  db.close();
  const c = new Client(srv.base);
  assert.equal((await c.post('/api/auth/login', { email: 't@example.com', password: PW })).status, 200);
  const r = await c.post('/api/me/token', { password: PW });
  assert.equal(r.status, 200);
  assert.ok(r.json.token.startsWith('iruinai_'));
  const me = await new Client(srv.base).request('GET', '/api/me', undefined, { headers: { authorization: `Bearer ${r.json.token}` } });
  assert.equal(me.json.user.email, 't@example.com');
  for (let i = 0; i < 100 && !/APIトークンの通知メールの送信に失敗/.test(srv.output()); i++) await wait(50);
  assert.match(srv.output(), /APIトークンの通知メールの送信に失敗/);
});
