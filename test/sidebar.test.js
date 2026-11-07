const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');

// ブラウザで動かせないので、サイドバー（スマホの「表示する人」）が触る要素が index.html に揃っているかを突き合わせる
test('サイドバー: app.js が触る要素は index.html にあり、閉じた状態で始まる', () => {
  const html = read('index.html');
  const app = read('app.js');
  const block = app.slice(app.indexOf('サイドバー（表示する人）'), app.indexOf('// ---------- 上部の人一覧'));
  assert.ok(block.length > 200, 'サイドバーの処理が見つからない');
  const ids = new Set([...block.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
  for (const id of ['sideBtn', 'sidebar', 'sideOverlay', 'sideClose', 'sidePeople']) assert.ok(ids.has(id), `app.js が #${id} を使っていない`);
  for (const id of ids) assert.match(html, new RegExp(`\\bid="${id}"`), `index.html に id="${id}" がない`);
  // 人のチップの一覧（#people）は、広い画面では上のバーにあり、サイドバーの中には最初はない
  assert.match(html, /<div id="people" class="people">/);
  assert.doesNotMatch(html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('</aside>')), /id="people"/);
  assert.match(html, /<div id="sideOverlay"[^>]*\bhidden\b/);
  assert.match(html, /<button id="sideBtn"[^>]*aria-expanded="false"/);
  // アプリの名前（APP_TITLE）が入る
  assert.match(html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('</aside>')), /__TITLE__/);
});
