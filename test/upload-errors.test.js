const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, registerUser } = require('./helpers');

const MSG = 'アップロードの内容が正しくありません';
const B = 'XBOUNDARY';
const MULTIPART = `multipart/form-data; boundary=${B}`;
const PNG_HEAD = '\x89PNG\r\n\x1a\n';
const part = (head, body = '') => `--${B}\r\n${head}\r\n\r\n${body}`;

// [busboy が出すエラー文, Content-Type, 本文]。Content-Type は multipart のまま、本文の形だけが壊れている
const BROKEN = [
  ['Multipart: Boundary not found', 'multipart/form-data', 'abc'],
  ['Unexpected end of form（画像の途中で切れた）', MULTIPART,
    part('Content-Disposition: form-data; name="icon"; filename="a.png"\r\nContent-Type: image/png', PNG_HEAD + 'x'.repeat(5000))],
  ['Unexpected end of form（欄の途中で切れた）', MULTIPART, part('Content-Disposition: form-data; name="name"', 'abc')],
  ['Unexpected end of form（本文が空）', MULTIPART, ''],
  ['Malformed part header（: のない行）', MULTIPART, `--${B}\r\nthis is not a header\r\n\r\nabc\r\n--${B}--\r\n`],
  ['Malformed part header（大きすぎる行）', MULTIPART,
    `--${B}\r\nContent-Disposition: form-data; name="name"\r\nX-Big: ${'a'.repeat(100000)}\r\n\r\nabc\r\n--${B}--\r\n`],
  ['Malformed part header（CR だけの改行）', MULTIPART,
    `--${B}\r\nContent-Disposition: form-data; name="name"\rX-Foo: y\r\n\r\nabc\r\n--${B}--\r\n`],
];

async function setup(t) {
  const srv = await startServer();
  t.after(() => srv.stop());
  const a = await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  return { srv, a, url: `/api/people/${a.user.person_id}`, dir: path.join(srv.dataDir, 'uploads') };
}

test('壊れた multipart は 500 ではなく 400。画像は残らず、サーバーは動き続け、スタックをログに出さない', async (t) => {
  const { srv, a, url, dir } = await setup(t);
  const before = fs.readdirSync(dir);
  for (const [label, contentType, body] of BROKEN) {
    const r = await a.request('PUT', url, body, { raw: true, headers: { 'content-type': contentType } });
    assert.equal(r.status, 400, label);
    assert.equal(r.json?.error, MSG, label);
    assert.deepEqual(fs.readdirSync(dir), before, label);
    assert.equal((await a.get('/api/people')).status, 200, label); // 続けて普通に使える
  }
  assert.equal((await a.get('/api/people')).json.find((p) => p.id === a.user.person_id).name, 'A');
  assert.ok(!/Unexpected end of form|Malformed part header|Boundary not found/.test(srv.output()), srv.output());
  assert.ok(!/^\s+at /m.test(srv.output()), srv.output()); // スタックトレースもない

  // 対照：壊れていない multipart は通り、画像が 1つ増える（上の「増えていない」が見落としでないことの確認）
  const fd = new FormData();
  fd.append('name', 'A改');
  fd.append('icon', new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'icon.png');
  const ok = await a.putMultipart(url, fd);
  assert.equal(ok.status, 200);
  assert.equal(fs.readdirSync(dir).length, before.length + 1);
});

test('今までの画像のエラー文は変わらない（2MB 超過）。許していない欄名は新しい文面', async (t) => {
  const { a, url, dir } = await setup(t);
  const before = fs.readdirSync(dir);
  const big = new FormData();
  big.append('icon', new Blob([Buffer.alloc(3 * 1024 * 1024, 1)], { type: 'image/png' }), 'big.png');
  const r = await a.putMultipart(url, big);
  assert.equal(r.status, 400);
  assert.equal(r.json.error, '画像は2MBまでです');
  const other = new FormData();
  other.append('photo', new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }), 'x.png'); // 'icon' 以外の欄
  const u = await a.putMultipart(url, other);
  assert.equal(u.status, 400);
  assert.equal(u.json.error, MSG);
  assert.deepEqual(fs.readdirSync(dir), before);
});

test('multipart でない壊れた本文や、本人以外・未ログインの扱いは今までどおり', async (t) => {
  const { srv, a, url } = await setup(t);
  const b = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B' } });
  // 他人の人への壊れた multipart は、本文を読む前に 403（所有者の検査が先）
  const other = await a.request('PUT', `/api/people/${b.user.person_id}`, 'abc', { raw: true, headers: { 'content-type': 'multipart/form-data' } });
  assert.equal(other.status, 403);
  // JSON の PUT の本文が壊れていれば、今までどおり 400「送信内容が正しくありません」
  const json = await a.request('PUT', url, '{"name": ', { raw: true, headers: { 'content-type': 'application/json' } });
  assert.equal(json.status, 400);
  assert.equal(json.json.error, '送信内容が正しくありません');
});

// 受け取った内容の誤りではなく、サーバー側の問題（保存先に書けない）は、400 にせず 500 のまま（原因をログに残す）
test('保存先に書けないときは 400 にせず 500', { skip: process.getuid?.() === 0 && 'root は書けてしまう' }, async (t) => {
  const { srv, a, url, dir } = await setup(t);
  const fd = new FormData();
  fd.append('icon', new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'icon.png');
  fs.chmodSync(dir, 0o500);
  let r;
  try {
    r = await a.putMultipart(url, fd);
  } finally {
    fs.chmodSync(dir, 0o700); // srv.stop() が消せるように戻す
  }
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'サーバーでエラーが起きました');
  assert.match(srv.output(), /EACCES/);
});
