const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, Client } = require('./helpers');
const { STAMPS: SERVER_STAMPS } = require('../lib/stamps');
const Reactions = require('../public/reactions.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const html = read('index.html');
const js = read('reactions.js');
const appJs = read('app.js');

test('reactions.js が参照する #id は index.html にある', () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(wanted.size >= 6, `突き合わせる id が少なすぎる: ${[...wanted]}`);
  for (const id of wanted) assert.ok(htmlIds.has(id), `index.html に id="${id}" がない`);
  // app.js が反応欄を差し込む場所
  for (const id of ['viewReactions', 'stayReactions', 'memoReactions']) assert.ok(htmlIds.has(id), id);
  for (const sel of appJs.matchAll(/mountReactions\('#(\w+)', '#(\w+)'/g)) {
    assert.ok(htmlIds.has(sel[1]) && htmlIds.has(sel[2]), `mountReactions の ${sel[1]} / ${sel[2]}`);
  }
});

test('スタンプの ID・表示名・順が、サーバーと画面で一致している', () => {
  assert.deepEqual(Reactions.STAMPS, SERVER_STAMPS);
  const drawn = [...js.matchAll(/^\s{4}(\w+): \['#/gm)].map((m) => m[1]); // 内蔵の絵（FACES）
  assert.deepEqual(drawn, SERVER_STAMPS.map((s) => s.id));
});

test('index.html: reactions.js を app.js より前に読み込む。ベルは非表示で始まる', () => {
  const r = html.indexOf('<script src="/reactions.js">');
  const a = html.indexOf('<script src="/app.js">');
  assert.ok(r > 0 && a > r);
  assert.match(html, /<button id="bellBtn"[^>]*\bhidden\b/);
  assert.match(html, /<div id="bellPanel"[^>]*\bhidden\b/);
  assert.match(html, /<input type="checkbox" id="soundToggle" checked>/); // 初期は音あり
});

test('app.js が反応の部品を呼んでいる', () => {
  assert.match(appJs, /Reactions\.onMe\(me\)/);
  assert.match(appJs, /Reactions\.decorateEl\(arg\.el\)/);
  assert.match(appJs, /eventsSet: \(\) => \{[^}]*Reactions\.refreshSummary\(\)/);
  assert.match(appJs, /Reactions\.init\(\{/);
});

test('reactions.js: ユーザーの入力を innerHTML に入れない。localStorage は try の中。30 秒ごと＋タブに戻ったとき', () => {
  assert.doesNotMatch(js.replace(/\/\/.*$/gm, ''), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  const storage = js.split('\n').filter((l) => /localStorage/.test(l) && !/^\s*\/\//.test(l));
  assert.ok(storage.length >= 2);
  for (const l of storage) assert.match(l, /try \{/, `localStorage は try で囲む: ${l.trim()}`);
  assert.match(js, /POLL_MS = 30 \* 1000/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /visibilityState === 'visible'/);
});

test('音: Audio がなくても落ちない。ミュート中は鳴らさない。再生が拒否されたら false', async () => {
  assert.equal(await Reactions.makeSound({}).pop(), false);
  assert.equal(await Reactions.makeSound(null).pop(), false);

  const played = [];
  let allowed = false;
  class FakeAudio {
    constructor(src) { this.src = src; this.currentTime = 5; }
    play() { played.push(this.src); return allowed ? Promise.resolve() : Promise.reject(new Error('NotAllowedError')); }
  }
  const s = Reactions.makeSound({ Audio: FakeAudio });
  assert.equal(await s.pop(), false); // ブラウザが操作前の再生を止めている
  allowed = true;
  s.unlock();
  assert.equal(await s.pop(), true);
  assert.deepEqual(played, ['/sounds/pop.wav', '/sounds/pop.wav']);
  s.setMuted(true);
  assert.equal(await s.pop(), false);
  assert.equal(played.length, 2); // ミュート中は play() も呼ばない
  s.setMuted(false);
  assert.equal(await s.pop(), true);
  // 作るときに例外を投げる環境でも落ちない
  const broken = Reactions.makeSound({ Audio: class { constructor() { throw new Error('x'); } } });
  broken.unlock();
  assert.equal(await broken.pop(), false);
});

test('音声ファイル: /sounds/pop.wav は正しい WAV で、サーバーから配られる', async (t) => {
  const file = fs.readFileSync(path.join(__dirname, '../public/sounds/pop.wav'));
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.toString('ascii', 8, 12), 'WAVE');
  assert.equal(file.readUInt16LE(22), 1); // モノラル
  assert.equal(file.readUInt32LE(24), 44100);
  assert.equal(file.readUInt32LE(40), file.length - 44); // data の長さがファイルと合っている
  assert.ok(file.length < 100 * 1024);
  const srv = await startServer();
  t.after(() => srv.stop());
  const r = await fetch(`${srv.base}/sounds/pop.wav`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /audio\/(wav|x-wav|wave)/);
  assert.equal((await r.arrayBuffer()).byteLength, file.length);
});

test('配信: /reactions.js は返り、スタンプ画像がなくても 404 で落ちない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const r = await c.get('/reactions.js');
  assert.equal(r.status, 200);
  assert.match(r.text, /window\.Reactions|root\.Reactions/);
  assert.equal((await c.get('/stamps/like.png')).status, 404);
  assert.match((await c.get('/')).text, /<script src="\/reactions\.js">/);
});
