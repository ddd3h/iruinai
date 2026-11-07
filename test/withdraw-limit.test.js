const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, registerUser } = require('./helpers');

const LOCK_MSG = '間違いが続いたので、1分ほど待ってからもう一度どうぞ';
const userCount = (srv, email) => {
  const db = srv.openDb();
  const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(email).n;
  db.close();
  return n;
};

async function setup(t) {
  const srv = await startServer({}, { fakeClock: true });
  t.after(() => srv.stop());
  const a = await registerUser(srv, { email: 'a@example.com', password: 'password123', person: { new_name: 'A' } });
  const b = await registerUser(srv, { email: 'b@example.com', password: 'password456', person: { new_name: 'B' } });
  return { srv, a, b };
}

test('退会: PW を 5回間違えると、正しい PW でも 1分は 429 で、アカウントは残る', async (t) => {
  const { srv, a } = await setup(t);
  for (let i = 0; i < 5; i++) {
    const r = await a.post('/api/me/withdraw', { password: 'wrong-wrong' });
    assert.equal(r.status, 400, `${i + 1}回目`);
    assert.equal(r.json.error, 'パスワードが違います');
  }
  const locked = await a.post('/api/me/withdraw', { password: 'password123' });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error, LOCK_MSG);
  // 間違った PW でも 429（PW の検査まで行かない）
  assert.equal((await a.post('/api/me/withdraw', { password: 'wrong-wrong' })).status, 429);
  // アカウントも人もログインも残っている
  assert.equal(userCount(srv, 'a@example.com'), 1);
  assert.ok((await a.get('/api/me')).json.user);
  assert.ok((await a.get('/api/people')).json.some((p) => p.id === a.user.person_id));
});

test('退会: 1分たつと、また試せる（正しい PW なら退会できる）。待っている間はまだ 429', async (t) => {
  const { srv, a } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await a.post('/api/me/withdraw', { password: 'wrong-wrong' })).status, 400);
  srv.advanceClock(30 * 1000);
  assert.equal((await a.post('/api/me/withdraw', { password: 'password123' })).status, 429); // まだ 30秒
  srv.advanceClock(31 * 1000);
  assert.equal((await a.post('/api/me/withdraw', { password: 'password123' })).status, 200);
  assert.equal(userCount(srv, 'a@example.com'), 0);
});

test('退会: 間違いの回数は 1分で数え直す。他のユーザーはロックされない', async (t) => {
  const { srv, a, b } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await a.post('/api/me/withdraw', { password: 'wrong-wrong' })).status, 400);
  assert.equal((await a.post('/api/me/withdraw', { password: 'password123' })).status, 429);

  // B は影響を受けない（ユーザーごとに数える）
  assert.equal((await b.post('/api/me/withdraw', { password: 'wrong-wrong' })).status, 400);
  assert.equal((await b.post('/api/me/withdraw', { password: 'wrong-wrong' })).status, 400);

  // 1分たつと A の回数は 0 から数え直し。4回間違えてもまだロックされない
  srv.advanceClock(61 * 1000);
  for (let i = 0; i < 4; i++) assert.equal((await a.post('/api/me/withdraw', { password: 'wrong-wrong' })).status, 400, `やり直し ${i + 1}回目`);
  assert.equal((await a.post('/api/me/withdraw', { password: 'password123' })).status, 200);

  // B は（A のロックと関係なく）正しい PW で退会できる
  assert.equal((await b.post('/api/me/withdraw', { password: 'password456' })).status, 200);
  assert.equal(userCount(srv, 'b@example.com'), 0);
});

test('退会: 128 文字を超える PW も間違いに数える（scrypt は走らせない）', async (t) => {
  const { srv, a } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await a.post('/api/me/withdraw', { password: 'x'.repeat(200) })).status, 400);
  assert.equal((await a.post('/api/me/withdraw', { password: 'password123' })).status, 429);
  assert.equal(userCount(srv, 'a@example.com'), 1);
});
