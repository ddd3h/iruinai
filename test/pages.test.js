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
  // 確認コードの画面は、6桁のコードだけを尋ねる（メールもパスワードも入れない。確認待ちは、申し込んだブラウザの Cookie で決まる）
  const code = block('view-code');
  assert.deepEqual([...code.matchAll(/<input\b[^>]*>/g)].map((m) => m[0].match(/\bname="([^"]+)"/)?.[1]), ['code']);
  assert.doesNotMatch(code, /type="(?:email|password)"/);
  assert.doesNotMatch(code, /name="(?:email|password)"/);
  assert.doesNotMatch(code, /codePassword/);
  const codeInput = code.match(/<input[^>]*name="code"[^>]*>/)[0];
  assert.match(codeInput, /inputmode="numeric"/);
  assert.match(codeInput, /autocomplete="one-time-code"/);
  assert.match(codeInput, /maxlength="6"/);
  assert.match(codeInput, /\brequired\b/);
  // 残るのは、宛先の案内・コードを確認する・再送（カウントダウンつき）・入力し直す（登録の画面へ戻る）
  assert.match(code, /id="codeSent"/);
  assert.match(code, /<button type="submit"[^>]*>コードを確認する<\/button>/);
  assert.match(code, /id="resendBtn"/);
  assert.match(code, /data-go="signup"[^>]*>入力し直す</);
  // 申し込みの画面には「あなたの人」を置かない。人は、コードの確認のあとの画面（view-person）で選ぶ
  const signup = block('view-signup');
  assert.doesNotMatch(signup, /あなたの人|name="(?:mode|new_name|new_color|person_id)"/);
  const person = block('view-person');
  assert.deepEqual([...new Set([...person.matchAll(/<(?:input|select)\b[^>]*>/g)].map((m) => m[0].match(/\bname="([^"]+)"/)?.[1]))].sort(), ['mode', 'new_color', 'new_name', 'person_id']);
  assert.match(person, /<button type="submit"[^>]*>登録を完了する<\/button>/);
  assert.match(person, /id="cancelBtn"[^>]*>やめる</);
  // 登録の申し込みの本文は、メールとパスワードだけ。人の指定は /complete で送る
  assert.match(js, /post\('\/api\/auth\/signup', \{ email: f\.email\.value, password: f\.password\.value \}\)/);
  assert.match(js, /post\('\/api\/auth\/complete'/);
  assert.match(js, /post\('\/api\/auth\/cancel'/);
  // 「確認コードを入力する」のリンクは、どの画面にもない
  assert.doesNotMatch(html, /data-go="code"/);
  assert.doesNotMatch(html, /確認コードを入力する/);
  // ブラウザの保存領域（sessionStorage・localStorage）は、パスワードにもメールにも使わない。そもそも一切触らない
  assert.doesNotMatch(js, /sessionStorage|localStorage/);
  // 確認の要求の本文は、コードだけ（メールもパスワードも送らない）。再送の本文は空
  const verify = js.match(/post\('\/api\/auth\/verify', (\{[^}]*\})\)/);
  assert.ok(verify, 'verify の呼び出しが見つからない');
  assert.equal(verify[1].replace(/\s+/g, ' '), '{ code: f.code.value }');
  assert.match(js, /post\('\/api\/auth\/resend', \{\}\)/);
  assert.doesNotMatch(js, /signupPassword|codePassword|pendingEmail/);
  // ページを開いたときは、確認待ち（Cookie の行）があれば、コード入力の画面を直接出す
  assert.match(js, /fetch\('\/api\/auth\/pending'/);
});
