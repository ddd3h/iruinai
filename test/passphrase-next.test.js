const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');

const PASS = 'himitsu';
const enc = encodeURIComponent;

async function setup(t) {
  const srv = await startServer({ ROOM_PASSWORD: PASS });
  t.after(() => srv.stop());
  return srv;
}

test('合言葉の前に開いた画面のページは、next に元の場所を入れて合言葉の画面へ送る', async (t) => {
  const srv = await setup(t);
  const c = new Client(srv.base);
  const reset = await c.get('/reset?token=abc');
  assert.equal(reset.status, 303);
  assert.equal(reset.headers.get('location'), `/login?next=${enc('/reset?token=abc')}`);
  assert.equal((await c.get('/account')).headers.get('location'), `/login?next=${enc('/account')}`);
  // 行き先が既定の `/` なら、next は付けない
  assert.equal((await c.get('/')).headers.get('location'), '/login');
  // /api/* は 401、画像・スクリプトなどの素材には next を付けない
  assert.equal((await c.get('/api/stays')).status, 401);
  assert.equal((await c.get('/app.js')).headers.get('location'), '/login');
  assert.equal((await c.get('/uploads/x.png')).headers.get('location'), '/login');
  // 書き込み系（GET 以外）にも next は付けない
  assert.equal((await c.post('/account', {})).headers.get('location'), '/login');
});

test('合言葉の画面は next をフォームの隠し欄に入れ直し、HTML として解釈されないよう escape する', async (t) => {
  const srv = await setup(t);
  const c = new Client(srv.base);
  const ok = await c.get(`/login?next=${enc('/reset?token=abc&x=1')}`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /<input type="hidden" name="next" value="\/reset\?token=abc&amp;x=1">/);

  const evil = await c.get(`/login?next=${enc('/x"><script>alert(1)</script>')}`);
  assert.equal(evil.status, 200);
  assert.ok(!evil.text.includes('<script>alert(1)'), 'escape されていない');
  assert.ok(!evil.text.includes('"><script'), 'escape されていない');
  assert.match(evil.text, /value="\/x&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);

  // 安全でない next は、画面にも入れない
  const bad = await c.get(`/login?next=${enc('//evil.example')}`);
  assert.ok(!bad.text.includes('evil.example'));
  assert.match(bad.text, /<input type="hidden" name="next" value="">/);
  // next が何度も付いていても落ちない
  assert.equal((await c.get('/login?next=%2Fa&next=%2Fb')).status, 200);
});

test('合言葉が合えば、next の場所（リセットのトークンつき）へ送る。Cookie も付く', async (t) => {
  const srv = await setup(t);
  const c = new Client(srv.base);
  const r = await c.postForm('/login', { password: PASS, next: '/reset?token=abc' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/reset?token=abc');
  assert.ok(c.jar.has('iruinai_auth'));
  const page = await c.get('/reset?token=abc');
  assert.equal(page.status, 200);
  assert.match(page.text, /<script src="\/account\.js">/);

  const c2 = new Client(srv.base);
  const a = await c2.postForm('/login', { password: PASS, next: '/account' });
  assert.equal(a.headers.get('location'), '/account');
  // 長さの上限ちょうど（2000 文字）は通る
  const edge = '/' + 'a'.repeat(1999);
  assert.equal((await new Client(srv.base).postForm('/login', { password: PASS, next: edge })).headers.get('location'), edge);
});

test('安全でない next は無視して `/` へ送る（外部サイト・ループ・ヘッダー注入・長すぎる値）。合言葉は通る', async (t) => {
  const srv = await setup(t);
  const bad = [
    '//evil.com',
    '//evil.com/reset',
    'https://evil.com',
    'http://evil.com/',
    '/\\evil.com',
    '/\\/evil.com',
    'javascript:alert(1)',
    'evil.com',
    'reset?token=abc', // 先頭が / でない
    '',
    '/login',
    '/login?e=wrong',
    '/login/',
    '/LOGIN',
    '/logout',
    '/Logout?x=1',
    '/foo\r\nSet-Cookie: injected=1',
    '/foo\nLocation: https://evil.com',
    '/foo\tbar',
    '/foo%0d%0aSet-Cookie:injected=1',
    '/foo%0D%0ASet-Cookie:injected=1',
    '/x?u=https://evil.com',
    '/' + 'a'.repeat(2000), // 2001 文字
  ];
  for (const next of bad) {
    const c = new Client(srv.base);
    const r = await c.postForm('/login', { password: PASS, next });
    assert.equal(r.status, 303, JSON.stringify(next));
    assert.equal(r.headers.get('location'), '/', JSON.stringify(next));
    assert.ok(c.jar.has('iruinai_auth'), JSON.stringify(next));
    assert.equal(r.headers.get('set-cookie')?.includes('injected'), false);
  }
  // next が 2つ送られても（配列になっても）落ちず、`/` へ
  const c = new Client(srv.base);
  const dup = await c.request('POST', '/login', 'password=himitsu&next=%2Fa&next=%2Fb', {
    raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(dup.status, 303);
  assert.equal(dup.headers.get('location'), '/');
});

test('合言葉を間違えても、安全な next は合言葉の画面に引き継ぐ（安全でないものは捨てる）', async (t) => {
  const srv = await setup(t);
  const c = new Client(srv.base);
  const wrong = await c.postForm('/login', { password: 'nope', next: '/reset?token=abc' });
  assert.equal(wrong.status, 303);
  assert.equal(wrong.headers.get('location'), `/login?e=wrong&next=${enc('/reset?token=abc')}`);
  assert.ok(!c.jar.has('iruinai_auth'));
  const evil = await c.postForm('/login', { password: 'nope', next: '//evil.com' });
  assert.equal(evil.headers.get('location'), '/login?e=wrong');
  // 5回続けて間違えたあとの待ち時間の案内でも、next は残る
  for (let i = 0; i < 3; i++) await c.postForm('/login', { password: 'nope' });
  const wait = await c.postForm('/login', { password: PASS, next: '/account' });
  assert.equal(wait.headers.get('location'), `/login?e=wait&next=${enc('/account')}`);
  assert.ok(!c.jar.has('iruinai_auth'));
});
