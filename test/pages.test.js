const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, Client } = require('./helpers');

test('/account と /reset は同じ画面を返す', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  for (const url of ['/account', '/reset?token=abc']) {
    const r = await c.get(url);
    assert.equal(r.status, 200, url);
    assert.match(r.text, /<script src="\/account\.js">/);
  }
  assert.equal((await c.get('/account.js')).status, 200);
});

test('合言葉を通っていなければ /account は合言葉の画面へ', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  const r = await new Client(srv.base).get('/account');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/login?next=%2Faccount'); // 合言葉のあとに戻れるよう、元の場所を控える
});

test('合言葉を通ったあとは /account も /reset も開ける', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  assert.equal((await c.postForm('/login', { password: 'himitsu' })).status, 303);
  for (const url of ['/account', '/reset?token=abc']) {
    const r = await c.get(url);
    assert.equal(r.status, 200, url);
    assert.match(r.text, /<script src="\/account\.js">/);
  }
  // Cookie を持たない人は、どちらも合言葉の画面へ（合言葉のあとに戻れるよう、元の場所を next に控える）
  for (const url of ['/account', '/reset?token=abc']) {
    const r = await new Client(srv.base).get(url);
    assert.equal(r.status, 303, url);
    assert.equal(r.headers.get('location'), `/login?next=${encodeURIComponent(url)}`, url);
  }
});

// ブラウザで動かせないので、account.js が触る要素が account.html に揃っているかを文字列で突き合わせる
test('account.js が参照する要素は account.html にある', () => {
  const dir = path.join(__dirname, '../public');
  const html = fs.readFileSync(path.join(dir, 'account.html'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'account.js'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  // '#id' のセレクタ（'#view-' + name のような途中の文字列は除く）と getElementById('id')
  const wanted = new Set();
  for (const m of js.matchAll(/['"`]#([\w-]+)/g)) if (!m[1].endsWith('-')) wanted.add(m[1]);
  for (const m of js.matchAll(/getElementById\('([\w-]+)'\)/g)) wanted.add(m[1]);
  // show('name') / onSubmit('name') と data-go="name" は #view-name を指す
  for (const m of js.matchAll(/\b(?:show|onSubmit)\('(\w+)'/g)) wanted.add('view-' + m[1]);
  for (const m of html.matchAll(/\bdata-go="(\w+)"/g)) wanted.add('view-' + m[1]);

  assert.ok(wanted.size >= 10, `突き合わせる id が少なすぎる（正規表現の取りこぼし？）: ${[...wanted]}`);
  for (const id of wanted) assert.ok(htmlIds.has(id), `account.html に id="${id}" がない`);

  const block = (id) => {
    const m = html.match(new RegExp(`<form id="${id}"[\\s\\S]*?</form>`));
    assert.ok(m, `<form id="${id}"> がない`);
    return m[0];
  };
  // 確認コードの画面は自分のメール欄を持つ（画面を離れても、コード入力に戻れるように）
  assert.match(block('view-code'), /name="email"/);
  // 確認コードの画面はパスワードも持つ（verify はサインアップ時のパスワードを要求する）
  const pw = block('view-code').match(/<input[^>]*id="codePassword"[^>]*>/);
  assert.ok(pw, 'view-code に id="codePassword" の入力がない');
  assert.match(pw[0], /name="password"/);
  assert.match(pw[0], /type="password"/);
  assert.match(pw[0], /autocomplete="current-password"/);
  assert.match(pw[0], /\brequired\b/);
  // パスワードは変数に持つだけで、ブラウザの保存領域には書かない（sessionStorage にはメールアドレスだけ）
  assert.doesNotMatch(js, /(?:session|local)Storage\.setItem\([^)]*assword/i);
  assert.match(js, /post\('\/api\/auth\/verify', \{[^}]*password:/);
  // 登録の画面から、確認コードの入力へ行ける
  assert.match(block('view-signup'), /data-go="code"/);
});
