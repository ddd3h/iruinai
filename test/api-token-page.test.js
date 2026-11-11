const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const html = read('index.html');
const js = read('app.js');

test('app.js が参照するトークンの要素は index.html にある', () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const id of ['tokenBtn', 'tokenDialog', 'tokenForm', 'tokenStatus', 'tokenShown', 'tokenValue', 'tokenCopy', 'tokenUsage', 'tokenError', 'tokenRevoke', 'tokenSubmit']) {
    assert.ok(htmlIds.has(id), `index.html に id="${id}" がない`);
    assert.ok(js.includes(`#${id}`), `app.js が #${id} を使っていない`);
  }
  assert.ok(js.includes('/api/me/token'));
});

test('tokenDialog: パスワード欄・読み取り専用のトークン欄・閉じるボタン', () => {
  const start = html.indexOf('<dialog id="tokenDialog">');
  assert.ok(start >= 0, 'tokenDialog がない');
  const d = html.slice(start, html.indexOf('</dialog>', start));
  assert.match(d, /name="password"/);
  assert.match(d, /id="tokenValue"[^>]*readonly/);
  assert.match(d, /data-close/);
  assert.match(d, /二度と見られません/);
  assert.match(d, /1週間/);
});

test('personDialog の中に「APIトークン」ボタンがある', () => {
  const start = html.indexOf('<dialog id="personDialog">');
  const person = html.slice(start, html.indexOf('</dialog>', start));
  assert.match(person, /id="tokenBtn"/);
});
