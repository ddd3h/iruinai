const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, registerUser, Client } = require('./helpers');

// A（予定とメモを持つ）・B・C の 3 人がログイン済みの状態を用意する
async function setup(t, opts = {}) {
  const srv = await startServer({}, opts);
  t.after(() => srv.stop());
  const a = await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const b = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B' } });
  const c = await registerUser(srv, { email: 'c@example.com', person: { new_name: 'C' } });
  const stay = (await a.post('/api/stays', { person_id: a.user.person_id, start: '2026-11-10T09:00:00', end: '2026-11-10T18:00:00' })).json;
  const memo = (await a.post('/api/memos/batch', { person_id: a.user.person_id, title: 'Aのメモ', items: [{ start: '2026-11-11T10:00:00', end: '2026-11-11T11:00:00' }] })).json;
  return { srv, a, b, c, stay, memoId: memo.ids[0] };
}
const react = (c, type, id, extra) => c.post('/api/reactions', { type, id, ...extra });

test('スタンプ: 付けられる。同じものをもう一度付けても増えない', async (t) => {
  const { a, b, stay } = await setup(t);
  const r1 = await react(b, 'stay', stay.id, { stamp: 'like' });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.stamp, 'like');
  assert.equal(r1.json.kind, 'stamp');
  assert.equal(r1.json.mine, true);
  const r2 = await react(b, 'stay', stay.id, { stamp: 'like' });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.id, r1.json.id);
  assert.equal((await react(b, 'stay', stay.id, { stamp: 'sad' })).status, 201); // 別のスタンプは付けられる
  const list = (await a.get(`/api/reactions/stay/${stay.id}`)).json;
  assert.equal(list.length, 2);
});

test('入力の検証: 不明なスタンプ・型・ID・両方・どちらもなし', async (t) => {
  const { b, stay } = await setup(t);
  assert.equal((await react(b, 'stay', stay.id, { stamp: 'nope' })).status, 400);
  assert.equal((await react(b, 'stay', stay.id, { stamp: 5 })).status, 400);
  assert.equal((await react(b, 'person', stay.id, { stamp: 'like' })).status, 400);
  assert.equal((await react(b, 'stay', '1', { stamp: 'like' })).status, 400);
  assert.equal((await react(b, 'stay', stay.id, {})).status, 400);
  assert.equal((await react(b, 'stay', stay.id, { stamp: 'like', body: 'x' })).status, 400);
  assert.equal((await react(b, 'stay', stay.id, { body: 5 })).status, 400);
  assert.equal((await react(b, 'stay', 99999, { stamp: 'like' })).status, 404);
  assert.equal((await react(b, 'memo', 99999, { stamp: 'like' })).status, 404);
});

test('コメント: 空白の整理・長さ・件数', async (t) => {
  const { b, stay } = await setup(t);
  const ok = await react(b, 'stay', stay.id, { body: '  おつかれ\n さま  ' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.body, 'おつかれ さま');
  assert.equal(ok.json.kind, 'comment');
  assert.equal((await react(b, 'stay', stay.id, { body: '   \n ' })).status, 400);
  assert.equal((await react(b, 'stay', stay.id, { body: 'あ'.repeat(41) })).status, 400);
  assert.equal((await react(b, 'stay', stay.id, { body: '😀'.repeat(40) })).status, 201); // コードポイントで数える
  assert.equal((await react(b, 'stay', stay.id, { body: 'あ'.repeat(40) })).status, 201);
  assert.equal((await react(b, 'stay', stay.id, { body: '4' })).status, 201);
  assert.equal((await react(b, 'stay', stay.id, { body: '5' })).status, 201);
  const sixth = await react(b, 'stay', stay.id, { body: '6' });
  assert.equal(sixth.status, 400);
  assert.equal(sixth.json.error, 'この予定へのコメントは5件までです');
});

test('コメントの件数は人ごと・対象ごとに数える', async (t) => {
  const { b, c, stay, memoId } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await react(b, 'stay', stay.id, { body: `c${i}` })).status, 201);
  assert.equal((await react(c, 'stay', stay.id, { body: 'c' })).status, 201); // 別の人
  assert.equal((await react(b, 'memo', memoId, { body: 'm' })).status, 201); // 別の対象
});

test('自分の予定・メモには付けられない（API を直接叩いても）', async (t) => {
  const { a, stay, memoId } = await setup(t);
  const s = await react(a, 'stay', stay.id, { stamp: 'like' });
  assert.equal(s.status, 400);
  assert.equal(s.json.error, '自分の予定には反応できません');
  assert.equal((await react(a, 'stay', stay.id, { body: 'x' })).status, 400);
  const m = await react(a, 'memo', memoId, { stamp: 'like' });
  assert.equal(m.status, 400);
  assert.equal(m.json.error, '自分のメモには反応できません');
});

test('部屋のメモと、アカウントのない人の予定には付けられる', async (t) => {
  const { srv, a, b } = await setup(t);
  const room = (await a.post('/api/memos/batch', { person_id: null, title: '部屋', items: [{ start: '2026-11-12T10:00:00', end: '2026-11-12T11:00:00' }] })).json.ids[0];
  assert.equal((await react(b, 'memo', room, { stamp: 'thanks' })).status, 201);
  assert.equal((await react(a, 'memo', room, { stamp: 'thanks' })).status, 201); // 部屋のメモは持ち主がいないので、誰でも
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name, color) VALUES ('Z', '#112233')").run().lastInsertRowid);
  const sid = Number(db.prepare("INSERT INTO stays (person_id, start, end) VALUES (?, '2026-11-13T09:00:00', '2026-11-13T10:00:00')").run(pid).lastInsertRowid);
  db.close();
  assert.equal((await react(b, 'stay', sid, { stamp: 'like' })).status, 201);
});

test('一覧: 古い順で、mine と deletable が呼んだ人ごとに正しい。未ログインでも読める', async (t) => {
  const { srv, a, b, c, stay } = await setup(t);
  const rb = (await react(b, 'stay', stay.id, { stamp: 'like' })).json;
  const rc = (await react(c, 'stay', stay.id, { body: 'やあ' })).json;
  const asA = (await a.get(`/api/reactions/stay/${stay.id}`)).json;
  assert.deepEqual(asA.map((x) => x.id), [rb.id, rc.id]);
  assert.deepEqual(asA.map((x) => x.mine), [false, false]);
  assert.deepEqual(asA.map((x) => x.deletable), [true, true]); // 持ち主は両方消せる
  assert.equal(asA[0].user.name, 'B');
  assert.match(asA[0].user.color, /^#[0-9a-f]{6}$/i);
  const asB = (await b.get(`/api/reactions/stay/${stay.id}`)).json;
  assert.deepEqual(asB.map((x) => x.mine), [true, false]);
  assert.deepEqual(asB.map((x) => x.deletable), [true, false]);
  const anon = new Client(srv.base);
  const asAnon = await anon.get(`/api/reactions/stay/${stay.id}`);
  assert.equal(asAnon.status, 200);
  assert.deepEqual(asAnon.json.map((x) => x.deletable || x.mine), [false, false]);
  assert.equal((await a.get('/api/reactions/stay/99999')).status, 404);
  assert.equal((await a.get('/api/reactions/person/1')).status, 400);
  assert.equal((await a.get('/api/reactions/stay/abc')).status, 400);
});

test('削除: 書いた本人と持ち主はできる。第三者はできない', async (t) => {
  const { b, c, a, stay } = await setup(t);
  const r1 = (await react(b, 'stay', stay.id, { stamp: 'like' })).json;
  const r2 = (await react(b, 'stay', stay.id, { body: 'x' })).json;
  const r3 = (await react(b, 'stay', stay.id, { stamp: 'sad' })).json;
  assert.equal((await c.del(`/api/reactions/${r1.id}`)).status, 403);
  assert.equal((await b.del(`/api/reactions/${r1.id}`)).status, 204); // 本人
  assert.equal((await a.del(`/api/reactions/${r2.id}`)).status, 204); // 持ち主
  assert.equal((await a.del(`/api/reactions/${r2.id}`)).status, 404); // もうない
  assert.equal((await a.del('/api/reactions/abc')).status, 400);
  assert.equal((await a.del('/api/reactions/99999')).status, 404);
  // 取り消したスタンプは、付け直せる
  assert.equal((await react(b, 'stay', stay.id, { stamp: 'like' })).status, 201);
  assert.equal((await a.get(`/api/reactions/stay/${stay.id}`)).json.length, 2);
  assert.ok(r3.id);
});

test('未ログインの書き込みは 401', async (t) => {
  const { srv, b, stay } = await setup(t);
  const anon = new Client(srv.base);
  const r = await react(anon, 'stay', stay.id, { stamp: 'like' });
  assert.equal(r.status, 401);
  assert.equal(r.json.needLogin, true);
  const rb = (await react(b, 'stay', stay.id, { stamp: 'like' })).json;
  const d = await anon.del(`/api/reactions/${rb.id}`);
  assert.equal(d.status, 401);
  assert.equal((await anon.post('/api/notifications/seen')).status, 401);
  assert.equal((await anon.get('/api/notifications')).status, 401);
});

test('書き込みの上限: 1人 1分に 30回。1分たつと戻る。他の人には影響しない', async (t) => {
  const { srv, b, c, stay } = await setup(t, { fakeClock: true });
  for (let i = 0; i < 30; i++) {
    const r = await react(b, 'stay', stay.id, { stamp: i % 2 ? 'like' : 'sad' });
    assert.ok(r.status === 201 || r.status === 200, `${i + 1}回目: ${r.status}`);
  }
  const over = await react(b, 'stay', stay.id, { stamp: 'like' });
  assert.equal(over.status, 429);
  assert.equal(over.json.error, '少し待ってからやり直してください');
  assert.equal((await b.del('/api/reactions/1')).status, 429); // 削除も数える
  assert.equal((await react(c, 'stay', stay.id, { stamp: 'like' })).status, 201); // C は別
  srv.advanceClock(61 * 1000);
  assert.equal((await react(b, 'stay', stay.id, { stamp: 'angry' })).status, 201);
});

test('予定とメモを消すと、付いた反応も消える', async (t) => {
  const { srv, a, b, stay, memoId } = await setup(t);
  await react(b, 'stay', stay.id, { stamp: 'like' });
  await react(b, 'memo', memoId, { body: 'x' });
  const count = () => { const db = srv.openDb(); const n = db.prepare('SELECT COUNT(*) AS n FROM reactions').get().n; db.close(); return n; };
  assert.equal(count(), 2);
  assert.equal((await a.del(`/api/stays/${stay.id}`)).status, 200);
  assert.equal(count(), 1);
  assert.equal((await a.del(`/api/memos/${memoId}`)).status, 200);
  assert.equal(count(), 0);
});

test('退会すると、その人が付けた反応も、その人の予定への反応も消える', async (t) => {
  const { srv, a, b, c, stay } = await setup(t);
  const cStay = (await c.post('/api/stays', { person_id: c.user.person_id, start: '2026-11-14T09:00:00', end: '2026-11-14T10:00:00' })).json;
  await react(b, 'stay', stay.id, { stamp: 'like' }); // A の予定への B の反応
  await react(a, 'stay', cStay.id, { stamp: 'like' }); // C の予定への A の反応
  await react(b, 'stay', cStay.id, { stamp: 'like' }); // C の予定への B の反応
  const count = () => { const db = srv.openDb(); const n = db.prepare('SELECT COUNT(*) AS n FROM reactions').get().n; db.close(); return n; };
  assert.equal(count(), 3);
  assert.equal((await a.post('/api/me/withdraw', { password: 'password123' })).status, 200);
  assert.equal(count(), 1); // A の予定への反応と、A が付けた反応が消え、B → C だけ残る
});

test('古い DB（reactions_seen_id のない users）でも起動して、列が足される', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const srv = await startServer({}, {
    seed(dir) {
      const db = new DatabaseSync(path.join(dir, 'app.db'));
      db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#4f7cff', icon_path TEXT);
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
          person_id INTEGER NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE, created_at INTEGER NOT NULL);`);
      db.close();
    },
  });
  t.after(() => srv.stop());
  const db = srv.openDb();
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  db.close();
  assert.ok(cols.includes('reactions_seen_id'));
  const a = await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  assert.equal((await a.get('/api/notifications')).json.unread, 0);
});
