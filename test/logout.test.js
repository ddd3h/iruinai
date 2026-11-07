const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');

const PASS = 'himitsu';
const site = (value) => ({ headers: value === undefined ? {} : { 'sec-fetch-site': value } });

// 合言葉を通り、登録してログインした Client（Cookie を 2つ持つ）
async function loggedIn(srv, email = 'a@example.com') {
  const c = new Client(srv.base);
  assert.equal((await c.postForm('/login', { password: PASS })).status, 303);
  assert.equal((await c.post('/api/auth/signup', { email, password: 'password123' })).status, 200);
  const code = (await srv.waitMail(email)).text.match(/確認コード: (\d{6})/)[1];
  assert.equal((await c.post('/api/auth/verify', { code })).status, 200);
  assert.equal((await c.post('/api/auth/complete', { new_name: 'A' })).status, 200);
  assert.ok(c.jar.has('iruinai_auth') && c.jar.has('iruinai_session'));
  return c;
}
const sessionCount = (srv) => {
  const db = srv.openDb();
  const n = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  db.close();
  return n;
};

async function setup(t) {
  const srv = await startServer({ ROOM_PASSWORD: PASS });
  t.after(() => srv.stop());
  return srv;
}

test('GET /logout: Sec-Fetch-Site が same-origin か none（アドレス欄・ブックマーク・同じサイトのリンク）なら、その場でログアウトする', async (t) => {
  const srv = await setup(t);
  for (const value of ['same-origin', 'none']) {
    const c = await loggedIn(srv, `${value}@example.com`);
    const r = await c.request('GET', '/logout', undefined, site(value));
    assert.equal(r.status, 303, value);
    assert.equal(r.headers.get('location'), '/login', value);
    assert.equal(c.jar.size, 0, value); // 合言葉とセッションの Cookie が両方消えた
    assert.equal((await c.get('/api/me')).status, 401); // 合言葉もなくなった
  }
  assert.equal(sessionCount(srv), 0); // セッションの行も消えている
});

test('GET /logout: cross-site・same-site・ヘッダーなしでは、ログアウトせずに確認の画面（POST のボタン）を出す', async (t) => {
  const srv = await setup(t);
  const c = await loggedIn(srv);
  for (const value of ['cross-site', 'same-site', undefined, '']) {
    const r = await c.request('GET', '/logout', undefined, site(value));
    const label = String(value);
    assert.equal(r.status, 200, label);
    assert.match(r.text, /ログアウトしますか？/, label);
    assert.match(r.text, /<form method="post" action="\/logout">/, label);
    assert.match(r.text, /<button type="submit"/, label);
    // /style.css は合言葉の内側にあり、合言葉のない端末では読めない。見た目はページの中に書く
    assert.doesNotMatch(r.text, /<link[^>]*stylesheet/, label);
    assert.match(r.text, /<style>[\s\S]*button[\s\S]*<\/style>/, label);
    assert.equal(r.headers.get('set-cookie'), null, label); // Cookie を触らない
    assert.ok(!r.text.includes('a@example.com'), label); // ユーザーの情報は入れない
    assert.equal(c.jar.size, 2, label);
    assert.equal(sessionCount(srv), 1, label);
    assert.ok((await c.get('/api/me')).json.user, label); // まだログイン中
  }
});

test('POST /logout: 合言葉とセッションの Cookie を消して /login へ送る。セッションの行も消える', async (t) => {
  const srv = await setup(t);
  const c = await loggedIn(srv);
  const r = await c.post('/logout', undefined);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/login');
  assert.equal(c.jar.size, 0);
  assert.equal(sessionCount(srv), 0);
  assert.equal((await c.get('/api/me')).status, 401);

  // 同じサイトの画面（確認の画面）から送られたものとして Sec-Fetch-Site: same-origin が付いても同じ
  const c2 = await loggedIn(srv, 'b@example.com');
  assert.equal((await c2.request('POST', '/logout', undefined, site('same-origin'))).status, 303);
  assert.equal(c2.jar.size, 0);
  assert.equal(sessionCount(srv), 0);
});

test('POST /logout: 他のサイトから送られたもの（cross-site）はログアウトせず、確認の画面を返す', async (t) => {
  const srv = await setup(t);
  const c = await loggedIn(srv);
  for (const value of ['cross-site', 'same-site']) {
    const r = await c.request('POST', '/logout', undefined, site(value));
    assert.equal(r.status, 200, value);
    assert.match(r.text, /ログアウトしますか？/, value);
    assert.equal(r.headers.get('set-cookie'), null, value);
    assert.equal(c.jar.size, 2, value);
    assert.equal(sessionCount(srv), 1, value);
  }
});

test('/logout は合言葉の外側にあるまま。確認の画面に、合言葉のない人が見られるものを増やさない', async (t) => {
  const srv = await setup(t);
  const anon = new Client(srv.base);
  const page = await anon.request('GET', '/logout', undefined, site('cross-site'));
  assert.equal(page.status, 200);
  assert.ok(!/(data-|stays|memos|people)/.test(page.text));
  // 合言葉の前でも、今までどおり同じ場所へ（Cookie を消すだけ）
  const out = await anon.request('GET', '/logout', undefined, site('none'));
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), '/login');
  // ROOM_PASSWORD がなければ /logout は存在しない（今までどおり）
  const open = await startServer();
  t.after(() => open.stop());
  const c = new Client(open.base);
  assert.equal((await c.request('GET', '/logout', undefined, site('same-origin'))).status, 404);
  assert.equal((await c.post('/logout', undefined)).status, 404);
});

test('合言葉を通っていない端末に出る確認画面は、外部のスタイルシートに頼らない', async (t) => {
  const srv = await setup(t);
  const r = await new Client(srv.base).request('GET', '/logout', undefined, site('cross-site'));
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /<link[^>]*stylesheet/);
  assert.equal((await new Client(srv.base).get('/style.css')).status, 303); // style.css は合言葉の内側
});
