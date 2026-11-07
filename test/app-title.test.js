const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, Client, registerUser } = require('./helpers');
const { appTitle } = require('../lib/appTitle');

const DEFAULT = '在室カレンダー';
const TITLE = '研究室の在室表';

// ---- lib/appTitle.js（環境変数を呼ぶたびに読む） ----

// process.env.APP_TITLE を一時的に差し替えて appTitle() を呼ぶ
function titleWith(value) {
  const saved = process.env.APP_TITLE;
  try {
    if (value === undefined) delete process.env.APP_TITLE;
    else process.env.APP_TITLE = value;
    return appTitle();
  } finally {
    if (saved === undefined) delete process.env.APP_TITLE;
    else process.env.APP_TITLE = saved;
  }
}

test('appTitle: 未設定・空・空白だけのときは、既定の「在室カレンダー」', () => {
  for (const value of [undefined, '', ' ', '   ', '\t', '\n', ' \r\n \t ', '　', '\u0000\u001f']) {
    assert.equal(titleWith(value), DEFAULT, JSON.stringify(value));
  }
});

test('appTitle: 前後の空白は取り、途中の空白・改行・制御文字の連なりは 1つの空白にする', () => {
  assert.equal(titleWith(`  ${TITLE}  `), TITLE);
  assert.equal(titleWith('研究室の\n在室表'), '研究室の 在室表');
  assert.equal(titleWith('研究室の\r\n\r\n在室表'), '研究室の 在室表');
  assert.equal(titleWith('A \t　 B'), 'A B');
  assert.equal(titleWith('A\u0001\u0007\u001b[31mB'), 'A [31mB'); // 制御文字（BEL・ESC など）も空白に。残りの文字はそのまま
  assert.equal(titleWith('\n\nA\n\n'), 'A');
  assert.doesNotMatch(titleWith('X\r\nSubject: evil\r\n\r\nbody'), /[\r\n]/); // メールの件名に改行を入れられない
});

test('appTitle: 40文字（コードポイント）で切る。切ったあとの末尾の空白は取る。サロゲートペアは壊さない', () => {
  assert.equal(titleWith('あ'.repeat(100)), 'あ'.repeat(40));
  assert.equal(titleWith('あ'.repeat(40)), 'あ'.repeat(40));
  assert.equal(titleWith('あ'.repeat(41)), 'あ'.repeat(40));
  assert.equal(titleWith('a'.repeat(39) + ' b'.repeat(10)), 'a'.repeat(39)); // 40文字目が空白になるので、末尾の空白を取る
  assert.equal([...titleWith('😀'.repeat(60))].length, 40);
  assert.equal(titleWith('😀'.repeat(60)), '😀'.repeat(40));
});

test('appTitle: 呼ぶたびに環境変数を読み直す（server.js が .env を読んだあとの値を使える）', () => {
  assert.equal(titleWith('一つめ'), '一つめ');
  assert.equal(titleWith('二つめ'), '二つめ');
  assert.equal(titleWith(undefined), DEFAULT);
});

// ---- 画面 ----

const meta = (html, key) => html.match(new RegExp(`<meta property="${key}" content="([^"]*)">`))?.[1];

test('メインの画面: ヘッダーの見出し・タブのタイトル・共有時のタイトルが APP_TITLE になる', async (t) => {
  const srv = await startServer({ APP_TITLE: TITLE });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  for (const url of ['/', '/index.html']) {
    const r = await c.get(url);
    assert.equal(r.status, 200, url);
    assert.match(r.text, new RegExp(`<h1>${TITLE}</h1>`));
    assert.match(r.text, new RegExp(`<title>${TITLE}</title>`));
    assert.equal(meta(r.text, 'og:site_name'), TITLE);
    assert.equal(meta(r.text, 'og:title'), TITLE);
    assert.doesNotMatch(r.text, /__TITLE__/);
    assert.doesNotMatch(r.text, new RegExp(DEFAULT));
  }
  // 起動のログは変えない（テストの起動待ちや、運用の目印に使われる）
  assert.ok(srv.output().includes(`${DEFAULT}: http://localhost:`), srv.output());
});

test('アカウントの画面（/account・/reset）: 見出しと「ログイン | …」のタイトルが APP_TITLE になる', async (t) => {
  const srv = await startServer({ APP_TITLE: TITLE });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  for (const url of ['/account', '/reset?token=abc']) {
    const r = await c.get(url);
    assert.equal(r.status, 200, url);
    assert.match(r.text, new RegExp(`<h1>${TITLE}</h1>`));
    assert.match(r.text, new RegExp(`<title>ログイン \\| ${TITLE}</title>`));
    assert.doesNotMatch(r.text, /__TITLE__/);
    assert.doesNotMatch(r.text, new RegExp(DEFAULT));
  }
});

test('合言葉の画面（/login）とログアウトの確認画面も APP_TITLE になる。next の引き継ぎは今までどおり', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu', APP_TITLE: TITLE });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const r = await c.get('/login?next=%2Faccount');
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`<h1>${TITLE}</h1>`));
  assert.match(r.text, new RegExp(`<title>${TITLE}</title>`));
  assert.equal(meta(r.text, 'og:site_name'), TITLE);
  assert.equal(meta(r.text, 'og:title'), TITLE);
  assert.match(r.text, /name="next" value="\/account"/);
  assert.doesNotMatch(r.text, /__TITLE__|__NEXT__/);
  assert.doesNotMatch(r.text, new RegExp(DEFAULT));

  // ログアウトの確認画面（ヘッダーなし = 同じサイトからと分からないときに出る）
  const out = await c.get('/logout');
  assert.equal(out.status, 200);
  assert.match(out.text, new RegExp(`<h1>${TITLE}</h1>`));
  assert.match(out.text, new RegExp(`<title>ログアウト \\| ${TITLE}</title>`));
  assert.doesNotMatch(out.text, /__TITLE__/);
});

test('画面の .html のアドレス（/account.html など）からも、プレースホルダーのままではなく APP_TITLE が出る', async (t) => {
  const srv = await startServer({ APP_TITLE: TITLE });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  // public/ の中でプレースホルダー（__TITLE__・__ORIGIN__・__NEXT__）を持つ HTML は、静的ファイルとして生のまま配られてはいけない
  const dir = path.join(__dirname, '../public');
  const templated = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && /__[A-Z]+__/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(templated.length >= 4, `プレースホルダーを持つ HTML が少なすぎる: ${templated}`);
  for (const file of templated) {
    const r = await c.get('/' + file);
    assert.equal(r.status, 200, file);
    assert.doesNotMatch(r.text, /__[A-Z]+__/, `${file} に置き換えられていないプレースホルダーがある`);
    assert.match(r.text, new RegExp(`<h1>${TITLE}</h1>`), file);
  }
  assert.match((await c.get('/account.html')).text, new RegExp(`<title>ログイン \\| ${TITLE}</title>`));
  assert.match((await c.get('/logout.html')).text, new RegExp(`<title>ログアウト \\| ${TITLE}</title>`));
});

test('APP_TITLE が未設定・空・空白だけのときは、どの画面も「在室カレンダー」', async (t) => {
  for (const env of [{}, { APP_TITLE: '' }, { APP_TITLE: '   ' }, { APP_TITLE: ' \n ' }]) {
    const srv = await startServer({ ROOM_PASSWORD: 'himitsu', ...env });
    t.after(() => srv.stop());
    const c = new Client(srv.base);
    const label = JSON.stringify(env);
    const login = await c.get('/login');
    assert.match(login.text, new RegExp(`<h1>${DEFAULT}</h1>`), label);
    assert.match(login.text, new RegExp(`<title>${DEFAULT}</title>`), label);
    assert.equal(meta(login.text, 'og:site_name'), DEFAULT, label);
    await c.postForm('/login', { password: 'himitsu' });
    const home = await c.get('/');
    assert.match(home.text, new RegExp(`<h1>${DEFAULT}</h1>`), label);
    assert.match(home.text, new RegExp(`<title>${DEFAULT}</title>`), label);
    assert.equal(meta(home.text, 'og:title'), DEFAULT, label);
    const account = await c.get('/account');
    assert.match(account.text, new RegExp(`<title>ログイン \\| ${DEFAULT}</title>`), label);
    assert.match(account.text, new RegExp(`<h1>${DEFAULT}</h1>`), label);
  }
});

test('HTML の記号（< > " & \'）は、どの画面でも escape されて出る。生の <b> は出ない', async (t) => {
  const evil = '<b>"&\'x';
  const escaped = '&lt;b&gt;&quot;&amp;&#39;x';
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu', APP_TITLE: evil });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const check = (r, label) => {
    assert.equal(r.status, 200, label);
    assert.doesNotMatch(r.text, /<b>/, label);
    assert.ok(!r.text.includes('"&\'x'), `${label}: 記号が escape されずに出ている`);
    assert.match(r.text, new RegExp(`<h1>${escaped}</h1>`), label);
    assert.equal(meta(r.text, 'og:site_name'), escaped, label);
    assert.equal(meta(r.text, 'og:title'), escaped, label);
  };
  const login = await c.get('/login');
  check(login, '/login');
  assert.match(login.text, new RegExp(`<title>${escaped}</title>`));
  await c.postForm('/login', { password: 'himitsu' });
  const home = await c.get('/');
  check(home, '/');
  assert.match(home.text, new RegExp(`<title>${escaped}</title>`));
  const account = await c.get('/account');
  assert.equal(account.status, 200);
  assert.doesNotMatch(account.text, /<b>/);
  assert.match(account.text, new RegExp(`<h1>${escaped}</h1>`));
  assert.match(account.text, new RegExp(`<title>ログイン \\| ${escaped}</title>`));
  const out = await c.get('/logout');
  assert.doesNotMatch(out.text, /<b>/);
  assert.match(out.text, new RegExp(`<title>ログアウト \\| ${escaped}</title>`));
});

test('値の中の $& や $\' は、置き換えの特別な記号として働かない（そのまま出る）', async (t) => {
  const srv = await startServer({ APP_TITLE: 'A$&B$`C$\'D' });
  t.after(() => srv.stop());
  const r = await new Client(srv.base).get('/');
  assert.match(r.text, /<h1>A\$&amp;B\$`C\$&#39;D<\/h1>/);
  assert.match(r.text, /<title>A\$&amp;B\$`C\$&#39;D<\/title>/);
});

test('値の中にプレースホルダーに見える文字があっても、もう一度は置き換えない', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu', APP_TITLE: '__NEXT__ __ORIGIN__' });
  t.after(() => srv.stop());
  const r = await new Client(srv.base).get('/login?next=%2Fa');
  assert.match(r.text, /<h1>__NEXT__ __ORIGIN__<\/h1>/);
  assert.match(r.text, /name="next" value="\/a"/);
});

test('改行を含む値は 1行にまとまり、100文字の値は 40文字で切れる', async (t) => {
  const srv1 = await startServer({ APP_TITLE: '研究室の\n在室表\r\n' });
  t.after(() => srv1.stop());
  const r1 = await new Client(srv1.base).get('/');
  assert.match(r1.text, /<h1>研究室の 在室表<\/h1>/);
  assert.match(r1.text, /<title>研究室の 在室表<\/title>/);
  assert.equal(meta(r1.text, 'og:title'), '研究室の 在室表');

  const srv2 = await startServer({ APP_TITLE: 'あ'.repeat(100) });
  t.after(() => srv2.stop());
  const r2 = await new Client(srv2.base).get('/');
  assert.match(r2.text, new RegExp(`<h1>${'あ'.repeat(40)}</h1>`));
  assert.doesNotMatch(r2.text, new RegExp('あ'.repeat(41)));
  assert.equal(meta(r2.text, 'og:site_name'), 'あ'.repeat(40));
});

test('.env に書いた APP_TITLE も使われる（ENV_FILE で読むファイルを指定）。環境変数が先', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iruinai-title-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'test.env');
  fs.writeFileSync(envFile, `APP_TITLE=${TITLE}（.env）\n`);

  const fromFile = await startServer({ ENV_FILE: envFile });
  t.after(() => fromFile.stop());
  const r = await new Client(fromFile.base).get('/');
  assert.match(r.text, new RegExp(`<h1>${TITLE}（.env）</h1>`));

  const overridden = await startServer({ ENV_FILE: envFile, APP_TITLE: '環境変数' });
  t.after(() => overridden.stop());
  assert.match((await new Client(overridden.base).get('/')).text, /<h1>環境変数<\/h1>/);
});

// ---- メール ----

test('確認コードのメールの件名と本文が APP_TITLE になる（HTML の escape はしない）', async (t) => {
  const srv = await startServer({ APP_TITLE: TITLE });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' })).status, 200);
  const mail = await srv.waitMail('a@example.com');
  assert.equal(mail.subject, `【${TITLE}】確認コード`);
  assert.match(mail.text, new RegExp(`^${TITLE}の確認コードです。`));
  assert.match(mail.text, /確認コード: \d{6}/);
  assert.doesNotMatch(mail.text, new RegExp(DEFAULT));
});

test('パスワード再設定のメールの件名も APP_TITLE になる', async (t) => {
  const srv = await startServer({ APP_TITLE: TITLE });
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  assert.equal((await new Client(srv.base).post('/api/auth/forgot', { email: 'a@example.com' })).status, 200);
  const mails = await srv.waitMail('a@example.com', 2);
  assert.equal(mails.subject, `【${TITLE}】パスワードの再設定`);
  assert.match(mails.text, /\/reset\?token=/);
});

test('メールには HTML の記号を escape せずに入れ、改行は入れない', async (t) => {
  const srv = await startServer({ APP_TITLE: '<b>"&\'x\r\nBcc: evil@example.com' });
  t.after(() => srv.stop());
  await new Client(srv.base).post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const mail = await srv.waitMail('a@example.com');
  assert.equal(mail.subject, '【<b>"&\'x Bcc: evil@example.com】確認コード');
  assert.match(mail.text, /^<b>"&'x Bcc: evil@example\.comの確認コードです。/);
});

test('APP_TITLE が未設定のときは、メールも今までどおり「在室カレンダー」', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await new Client(srv.base).post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const mail = await srv.waitMail('a@example.com');
  assert.equal(mail.subject, `【${DEFAULT}】確認コード`);
  assert.match(mail.text, new RegExp(`^${DEFAULT}の確認コードです。`));
});
