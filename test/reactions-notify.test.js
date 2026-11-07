const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, registerUser, Client } = require('./helpers');

async function setup(t) {
  const srv = await startServer({});
  t.after(() => srv.stop());
  const a = await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const b = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B', new_color: '#e5484d' } });
  const c = await registerUser(srv, { email: 'c@example.com', person: { new_name: 'C' } });
  const stay = (await a.post('/api/stays', { person_id: a.user.person_id, start: '2026-11-10T09:00:00', end: '2026-11-10T18:00:00' })).json;
  const memoId = (await a.post('/api/memos/batch', { person_id: a.user.person_id, title: 'Aのメモ', items: [{ start: '2026-11-20T10:00:00', end: '2026-11-20T11:00:00' }] })).json.ids[0];
  return { srv, a, b, c, stay, memoId };
}
const react = (c, type, id, extra) => c.post('/api/reactions', { type, id, ...extra });
const summary = (c, from, to) => c.get(`/api/reactions/summary?from=${from}&to=${to}`);

test('要約: 期間内の予定とメモだけ。数・mine・コメント数が正しく、反応のないものは含めない', async (t) => {
  const { srv, a, b, c, stay, memoId } = await setup(t);
  const other = (await b.post('/api/stays', { person_id: b.user.person_id, start: '2026-11-10T09:00:00', end: '2026-11-10T10:00:00' })).json; // 反応なし
  await react(b, 'stay', stay.id, { stamp: 'like' });
  await react(c, 'stay', stay.id, { stamp: 'like' });
  await react(c, 'stay', stay.id, { stamp: 'sad' });
  await react(c, 'stay', stay.id, { body: 'やあ' });
  await react(b, 'memo', memoId, { body: 'メモへ' });

  const s = (await summary(b, '2026-11-01', '2026-12-01')).json;
  assert.deepEqual(s.stays[stay.id], { stamps: { like: 2, sad: 1 }, mine: ['like'], comments: 1 });
  assert.deepEqual(s.memos[memoId], { stamps: {}, mine: [], comments: 1 });
  assert.equal(s.stays[other.id], undefined);

  // 期間外: 予定は 11/10、メモは 11/20。11/15〜11/30 ならメモだけ
  const late = (await summary(b, '2026-11-15', '2026-11-30')).json;
  assert.deepEqual(Object.keys(late.stays), []);
  assert.deepEqual(Object.keys(late.memos), [String(memoId)]);
  // 区間は [from, to) の重なり。予定の終わり（18:00）と同じ日の 0 時までなら含まれる
  assert.deepEqual(Object.keys((await summary(b, '2026-11-10', '2026-11-11')).json.stays), [String(stay.id)]);
  assert.deepEqual(Object.keys((await summary(b, '2026-11-11', '2026-11-12')).json.stays), []);

  // 時刻つきの日付も受け付ける。未ログインでも読め、mine は空
  assert.equal((await summary(b, '2026-11-01T00:00:00', '2026-12-01T00:00:00')).status, 200);
  const anon = (await summary(new Client(srv.base), '2026-11-01', '2026-12-01')).json;
  assert.deepEqual(anon.stays[stay.id].mine, []);
  assert.equal((await summary(b, 'abc', '2026-12-01')).status, 400);
  assert.equal((await b.get('/api/reactions/summary')).status, 400);
});

test('通知: 自分の予定・メモへの他の人の反応だけが、新しい順に出る', async (t) => {
  const { a, b, c, stay, memoId } = await setup(t);
  await react(b, 'stay', stay.id, { stamp: 'like' });
  await react(c, 'memo', memoId, { body: 'ありがと' });
  const n = (await a.get('/api/notifications')).json;
  assert.equal(n.unread, 2);
  assert.equal(n.items.length, 2);
  assert.ok(n.items[0].id > n.items[1].id);
  const [memoItem, stayItem] = n.items;
  assert.deepEqual(memoItem, {
    id: memoItem.id, kind: 'comment', stamp: null, body: 'ありがと', created_at: memoItem.created_at,
    from: { name: 'C', color: memoItem.from.color, icon_path: null }, target: { type: 'memo', id: memoId, date: '2026-11-20', label: 'Aのメモ' },
  });
  assert.equal(stayItem.kind, 'stamp');
  assert.equal(stayItem.stamp, 'like');
  assert.equal(stayItem.from.name, 'B');
  assert.equal(stayItem.from.color, '#e5484d');
  assert.equal(stayItem.from.icon_path, null); // アイコンを登録していない人
  assert.deepEqual(stayItem.target, { type: 'stay', id: stay.id, date: '2026-11-10', label: 'Aの在室' });
  // 他の人には、A 宛てのものは出ない
  assert.deepEqual((await b.get('/api/notifications')).json, { unread: 0, items: [] });
  assert.equal((await c.get('/api/notifications')).json.unread, 0);
});

test('通知: 部屋のメモと、アカウントのない人の予定への反応は、誰にも通知されない', async (t) => {
  const { srv, a, b, c } = await setup(t);
  const room = (await a.post('/api/memos/batch', { person_id: null, title: '部屋', items: [{ start: '2026-11-12T10:00:00', end: '2026-11-12T11:00:00' }] })).json.ids[0];
  await react(b, 'memo', room, { stamp: 'like' });
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name, color) VALUES ('Z', '#112233')").run().lastInsertRowid);
  const sid = Number(db.prepare("INSERT INTO stays (person_id, start, end) VALUES (?, '2026-11-13T09:00:00', '2026-11-13T10:00:00')").run(pid).lastInsertRowid);
  db.close();
  await react(b, 'stay', sid, { stamp: 'like' });
  for (const u of [a, b, c]) assert.deepEqual((await u.get('/api/notifications')).json, { unread: 0, items: [] });
});

test('通知: 50件まで、新しい順。未読は全件を数える', async (t) => {
  const { srv, a, b, c, stay, memoId } = await setup(t);
  // 書き込み上限（1人 30回/分）をよけるため、DB に直接 60 件入れる
  const db = srv.openDb();
  const ins = db.prepare('INSERT INTO reactions (user_id, memo_id, body, created_at) VALUES (?, ?, ?, 1)');
  for (let i = 0; i < 60; i++) ins.run(b.user.id, memoId, `c${i}`);
  db.close();
  const n = (await a.get('/api/notifications')).json;
  assert.equal(n.unread, 60);
  assert.equal(n.items.length, 50);
  assert.equal(n.items[0].body, 'c59');
  assert.equal(n.items[49].body, 'c10');
  assert.ok(c && stay);
});

test('既読: seen で未読が 0 になり、新しい反応でまた増える。他の人の既読には影響しない', async (t) => {
  const { srv, a, b, c, stay } = await setup(t);
  // C も自分の予定を持ち、A と B が反応する
  const cStay = (await c.post('/api/stays', { person_id: c.user.person_id, start: '2026-11-14T09:00:00', end: '2026-11-14T10:00:00' })).json;
  await react(b, 'stay', stay.id, { stamp: 'like' });
  await react(b, 'stay', cStay.id, { stamp: 'like' });
  assert.equal((await a.get('/api/notifications')).json.unread, 1);
  assert.equal((await c.get('/api/notifications')).json.unread, 1);

  assert.deepEqual((await a.post('/api/notifications/seen')).json, { unread: 0 });
  assert.equal((await a.get('/api/notifications')).json.unread, 0);
  assert.equal((await a.get('/api/notifications')).json.items.length, 1); // 履歴には残る
  assert.equal((await c.get('/api/notifications')).json.unread, 1); // C は変わらない

  await react(b, 'stay', stay.id, { stamp: 'sad' });
  assert.equal((await a.get('/api/notifications')).json.unread, 1);
  assert.equal((await a.post('/api/notifications/seen')).json.unread, 0);
  assert.equal((await a.post('/api/notifications/seen')).json.unread, 0); // 2回目も同じ

  // 反応が消えても既読の位置は戻らない
  const db = srv.openDb();
  const seen = db.prepare('SELECT reactions_seen_id AS id FROM users WHERE id = ?').get(a.user.id).id;
  db.close();
  assert.ok(seen > 0);
  const mine = (await b.get(`/api/reactions/stay/${stay.id}`)).json;
  for (const r of mine) await b.del(`/api/reactions/${r.id}`);
  assert.equal((await a.post('/api/notifications/seen')).json.unread, 0);
  const db2 = srv.openDb();
  assert.equal(db2.prepare('SELECT reactions_seen_id AS id FROM users WHERE id = ?').get(a.user.id).id, seen);
  db2.close();
});

test('通知: 反応が消えると、通知からも消える', async (t) => {
  const { a, b, stay } = await setup(t);
  const r = (await react(b, 'stay', stay.id, { stamp: 'like' })).json;
  assert.equal((await a.get('/api/notifications')).json.items.length, 1);
  assert.equal((await a.del(`/api/reactions/${r.id}`)).status, 403); // 持ち主は消せないので、通知も残る
  assert.equal((await a.get('/api/notifications')).json.items.length, 1);
  assert.equal((await b.del(`/api/reactions/${r.id}`)).status, 204); // した本人が消すと、通知からも消える
  assert.deepEqual((await a.get('/api/notifications')).json, { unread: 0, items: [] });
});
