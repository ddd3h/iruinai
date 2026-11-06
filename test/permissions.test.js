const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, Client, registerUser } = require('./helpers');

// A と B がログイン済み、U は誰も紐付けていない既存の人
async function setup(t) {
  const srv = await startServer();
  t.after(() => srv.stop());
  const db = srv.openDb();
  const U = Number(db.prepare("INSERT INTO people (name) VALUES ('未紐付け')").run().lastInsertRowid);
  db.close();
  const a = await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const b = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B' } });
  return { srv, a, b, A: a.user.person_id, B: b.user.person_id, U, anon: new Client(srv.base) };
}

const stay = (person_id, extra = {}) => ({ person_id, start: '2030-01-05T09:00:00', end: '2030-01-05T18:00:00', note: '', ...extra });
const memo = (person_id, extra = {}) => ({ person_id, title: 'メモ', all_day: true, items: [{ start: '2030-01-05', end: '2030-01-06' }], ...extra });
const getStay = (srv, id) => { const db = srv.openDb(); const r = db.prepare('SELECT * FROM stays WHERE id = ?').get(id); db.close(); return r; };
const getMemo = (srv, id) => { const db = srv.openDb(); const r = db.prepare('SELECT * FROM memos WHERE id = ?').get(id); db.close(); return r; };

test('未ログインは読めるが書けない（401 + needLogin）', async (t) => {
  const { anon, A } = await setup(t);
  assert.equal((await anon.get('/api/stays')).status, 200);
  assert.equal((await anon.get('/api/memos')).status, 200);
  assert.equal((await anon.get('/api/people')).status, 200);
  for (const [m, url, body] of [
    ['POST', '/api/stays', stay(A)],
    ['POST', '/api/stays/batch', { person_id: A, dates: ['2030-01-05'], startTime: '09:00', endTime: '10:00' }],
    ['PUT', '/api/stays/1', {}],
    ['DELETE', '/api/stays/1'],
    ['POST', '/api/memos/batch', memo(null)],
    ['PUT', '/api/people/' + A, {}],
  ]) {
    const r = await anon.request(m, url, body);
    assert.equal(r.status, 401, `${m} ${url}`);
    assert.equal(r.json.needLogin, true);
    assert.equal(r.json.error, 'ログインしてください');
  }
});

test('在室: 自分の人にだけ追加できる。他人・未紐付けの人には 403', async (t) => {
  const { a, A, B, U } = await setup(t);
  assert.equal((await a.post('/api/stays', stay(A))).status, 201);
  assert.equal((await a.post('/api/stays', stay(B))).status, 403);
  assert.equal((await a.post('/api/stays', stay(U))).status, 403);
  assert.equal((await a.post('/api/stays/batch', { person_id: B, dates: ['2030-01-05'], startTime: '09:00', endTime: '10:00' })).status, 403);
  assert.equal((await a.post('/api/stays/batch', { person_id: A, dates: ['2030-01-05'], startTime: '09:00', endTime: '10:00' })).status, 201);
  const imp = { items: [{ start: '2030-01-09T09:00:00', end: '2030-01-09T10:00:00' }] };
  assert.equal((await a.post('/api/stays/import', { person_id: B, ...imp })).status, 403);
  assert.equal((await a.post('/api/stays/import', { person_id: A, ...imp })).status, 201);
});

test('在室: 他人のものは変更・削除できず、自分のものを他人に付け替えることもできない', async (t) => {
  const { srv, a, b, A, B } = await setup(t);
  const mine = (await a.post('/api/stays', stay(A))).json;
  const theirs = (await b.post('/api/stays', stay(B))).json;

  assert.equal((await a.put(`/api/stays/${theirs.id}`, { note: '乗っ取り' })).status, 403);
  assert.equal((await a.put(`/api/stays/${mine.id}`, { person_id: B })).status, 403); // 付け替え
  assert.equal((await a.put(`/api/stays/${theirs.id}`, { person_id: A })).status, 403); // 奪う
  assert.equal((await a.del(`/api/stays/${theirs.id}`)).status, 403);
  assert.equal(getStay(srv, mine.id).person_id, A);
  assert.equal(getStay(srv, theirs.id).person_id, B);
  assert.equal(getStay(srv, theirs.id).note, '');

  assert.equal((await a.put(`/api/stays/${mine.id}`, { note: '自分で変更' })).status, 200);
  assert.equal((await a.del(`/api/stays/${mine.id}`)).status, 200);
  assert.equal((await a.del('/api/stays/999999')).status, 204); // 存在しない id は今までどおり
});

test('在室: remove に他人の id が 1件でも混ざれば、何も消さずに 403', async (t) => {
  const { srv, a, b, A, B } = await setup(t);
  const mine = (await a.post('/api/stays', stay(A))).json;
  const theirs = (await b.post('/api/stays', stay(B))).json;
  assert.equal((await a.post('/api/stays/remove', { ids: [mine.id, theirs.id] })).status, 403);
  assert.ok(getStay(srv, mine.id));
  assert.ok(getStay(srv, theirs.id));
  assert.equal((await a.post('/api/stays/remove', { ids: [mine.id, 999999] })).status, 204);
  assert.ok(!getStay(srv, mine.id));
});

test('在室: restore で他人の行の id を上書きできない。自分の削除の取り消しはできる', async (t) => {
  const { srv, a, b, A, B } = await setup(t);
  const theirs = (await b.post('/api/stays', stay(B))).json;
  const evil = { ...theirs, person_id: A, note: '上書き' };
  assert.equal((await a.post('/api/stays/restore', { items: [evil] })).status, 403);
  assert.equal(getStay(srv, theirs.id).person_id, B);
  assert.equal(getStay(srv, theirs.id).note, '');
  assert.equal((await a.post('/api/stays/restore', { items: [{ ...theirs }] })).status, 403); // person_id が他人

  const mine = (await a.post('/api/stays', stay(A))).json;
  const deleted = (await a.del(`/api/stays/${mine.id}`)).json;
  assert.equal((await a.post('/api/stays/restore', { items: [deleted] })).status, 204);
  assert.ok(getStay(srv, mine.id));
});

test('部屋のメモは、ログイン済みなら誰でも編集・削除できる', async (t) => {
  const { srv, a, b } = await setup(t);
  const r = await a.post('/api/memos/batch', memo(null, { title: '大掃除' }));
  assert.equal(r.status, 201);
  const id = r.json.ids[0];
  assert.equal((await b.put(`/api/memos/${id}`, { title: 'B が変更' })).status, 200);
  assert.equal(getMemo(srv, id).title, 'B が変更');
  assert.equal((await b.del(`/api/memos/${id}`)).status, 200);
  assert.ok(!getMemo(srv, id));
});

test('人のメモ: 他人のものは変更できない。部屋への付け替えで奪うこともできない', async (t) => {
  const { srv, a, b, A, B } = await setup(t);
  assert.equal((await a.post('/api/memos/batch', memo(B))).status, 403);
  const mine = (await a.post('/api/memos/batch', memo(A))).json.ids[0];
  const theirs = (await b.post('/api/memos/batch', memo(B))).json.ids[0];

  assert.equal((await a.put(`/api/memos/${theirs}`, { title: '乗っ取り' })).status, 403);
  assert.equal((await a.put(`/api/memos/${theirs}`, { person_id: null })).status, 403); // 部屋にして奪う
  assert.equal((await a.put(`/api/memos/${theirs}`, { person_id: A })).status, 403);
  assert.equal((await a.del(`/api/memos/${theirs}`)).status, 403);
  assert.equal(getMemo(srv, theirs).person_id, B);

  assert.equal((await a.put(`/api/memos/${mine}`, { person_id: B })).status, 403); // 他人に付け替え
  assert.equal((await a.put(`/api/memos/${mine}`, { person_id: null })).status, 200); // 自分のものを部屋に出すのは可
  assert.equal(getMemo(srv, mine).person_id, null);
});

test('メモ: remove / restore も全件を検査する', async (t) => {
  const { srv, a, b, A, B } = await setup(t);
  const mine = (await a.post('/api/memos/batch', memo(A))).json.ids[0];
  const theirs = (await b.post('/api/memos/batch', memo(B))).json.ids[0];
  const room = (await a.post('/api/memos/batch', memo(null))).json.ids[0];

  assert.equal((await a.post('/api/memos/remove', { ids: [mine, theirs] })).status, 403);
  assert.ok(getMemo(srv, mine));
  assert.equal((await a.post('/api/memos/remove', { ids: [mine, room] })).status, 204); // 部屋のメモは可

  const row = getMemo(srv, theirs);
  assert.equal((await a.post('/api/memos/restore', { items: [{ ...row, person_id: A }] })).status, 403);
  assert.equal(getMemo(srv, theirs).person_id, B);
});

test('人: POST と DELETE は廃止。PUT は本人だけ。未紐付けの人は誰も編集できない', async (t) => {
  const { a, b, A, B, U } = await setup(t);
  assert.equal((await a.post('/api/people', { name: '新人' })).status, 404);
  assert.equal((await a.del(`/api/people/${A}`)).status, 404);

  assert.equal((await a.put(`/api/people/${B}`, { name: '乗っ取り' })).status, 403);
  assert.equal((await a.put(`/api/people/${U}`, { name: '乗っ取り' })).status, 403);
  assert.equal((await a.put(`/api/people/${A}`, { name: 'A改' })).status, 200);
  const names = (await b.get('/api/people')).json.map((p) => p.name);
  assert.ok(names.includes('A改') && names.includes('B') && names.includes('未紐付け'));
});

test('人: restore は自分の人の取り消し専用（在室・メモは受け付けない）', async (t) => {
  const { srv, a, A, B } = await setup(t);
  const r = await a.put(`/api/people/${A}`, { name: 'A改', color: '#00ff00' });
  assert.equal(r.status, 200);
  const back = await a.post('/api/people/restore', { person: r.json.before });
  assert.equal(back.status, 200);
  assert.equal(back.json.name, 'A');

  assert.equal((await a.post('/api/people/restore', { person: { ...r.json.before, id: B } })).status, 403);
  // 消えた人を作り直すことはできない
  assert.equal((await a.post('/api/people/restore', { person: { id: 99999, name: 'x', color: '#000000' } })).status, 403);
  // stays を渡しても書き込まれない
  const db = srv.openDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM stays').get().n;
  db.close();
  await a.post('/api/people/restore', { person: r.json.before, stays: [{ id: 1, ...stay(A) }] });
  const db2 = srv.openDb();
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM stays').get().n, before);
  db2.close();
});

test('GET /api/people は claimed を返し、メールアドレスは返さない', async (t) => {
  const { anon, A, B, U } = await setup(t);
  const people = (await anon.get('/api/people')).json;
  const by = Object.fromEntries(people.map((p) => [p.id, p]));
  assert.equal(by[A].claimed, 1);
  assert.equal(by[B].claimed, 1);
  assert.equal(by[U].claimed, 0);
  assert.ok(!JSON.stringify(people).includes('@'));
});

// ---- 修正: restore のアイコン横取り・対象の検査・id の範囲 ----

test('人: restore で、他人が使っているアイコン画像を自分のものにできない', async (t) => {
  const { srv, a, A, B } = await setup(t);
  const file = path.join(srv.dataDir, 'uploads', 'victim.png');
  fs.writeFileSync(file, 'x');
  const db = srv.openDb();
  db.prepare("UPDATE people SET icon_path = '/uploads/victim.png' WHERE id = ?").run(B);
  db.close();

  const r = await a.post('/api/people/restore', { person: { id: A, name: 'A', color: '#4f7cff', icon_path: '/uploads/victim.png' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.icon_path, null);
  const people = (await a.get('/api/people')).json;
  assert.equal(people.find((p) => p.id === B).icon_path, '/uploads/victim.png');
  assert.ok(fs.existsSync(file));
});

test('人: restore で、だれも使っていない自分の古い画像は戻せる', async (t) => {
  const { srv, a, A } = await setup(t);
  fs.writeFileSync(path.join(srv.dataDir, 'uploads', 'mine.png'), 'x');
  const r = await a.post('/api/people/restore', { person: { id: A, name: 'A', color: '#4f7cff', icon_path: '/uploads/mine.png' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.icon_path, '/uploads/mine.png');
});

// 使い終わった id を作る（AUTOINCREMENT の seq が maxId まで進む。消した行の「元に戻す」と同じ状況）
function burnIds(srv, maxId, A) {
  const db = srv.openDb();
  db.prepare("INSERT INTO stays (id, person_id, start, end, note) VALUES (?, ?, '2030-02-01T09:00:00', '2030-02-01T10:00:00', '')").run(maxId, A);
  db.prepare('DELETE FROM stays WHERE id = ?').run(maxId);
  db.prepare("INSERT INTO memos (id, person_id, title, all_day, start, end) VALUES (?, NULL, 'x', 1, '2030-02-01', '2030-02-02')").run(maxId);
  db.prepare('DELETE FROM memos WHERE id = ?').run(maxId);
  db.close();
}

test('restore: 存在しない id でも、書き戻す先が他人の人なら 403。自分の人なら通る', async (t) => {
  const { srv, a, A, B } = await setup(t);
  burnIds(srv, 60000, A);
  const s = (id, person_id) => ({ id, person_id, start: '2030-01-05T09:00:00', end: '2030-01-05T18:00:00', note: '' });
  const m = (id, extra) => ({ id, title: 'メモ', all_day: 1, start: '2030-01-05', end: '2030-01-06', ...extra });

  // 在室: 存在しない id に、他人の person_id
  assert.equal((await a.post('/api/stays/restore', { items: [s(50000, B)] })).status, 403);
  assert.ok(!getStay(srv, 50000));
  // メモ: 存在しない id に、他人の person_id
  assert.equal((await a.post('/api/memos/restore', { items: [m(50000, { person_id: B })] })).status, 403);
  assert.ok(!getMemo(srv, 50000));
  // 在室: 存在しない id でも、自分の person_id なら通る（検査が厳しすぎない）
  assert.equal((await a.post('/api/stays/restore', { items: [s(50000, A)] })).status, 204);
  assert.equal(getStay(srv, 50000).person_id, A);
});

test('メモ: restore で person_id を省いて、他人の既存のメモの id を部屋のメモに書き換えられない', async (t) => {
  const { srv, a, b, B } = await setup(t);
  const theirs = (await b.post('/api/memos/batch', memo(B))).json.ids[0];
  const row = getMemo(srv, theirs);
  const { person_id, ...withoutPerson } = row;
  assert.equal((await a.post('/api/memos/restore', { items: [{ ...withoutPerson, title: '上書き' }] })).status, 403);
  assert.deepEqual({ ...getMemo(srv, theirs) }, { ...row });
});

test('restore: 今までに使われていない大きな id では書き戻せない（以後の追加を壊されない）', async (t) => {
  const { srv, a, A, anon } = await setup(t);
  const BIG = 9007199254740991;
  const r1 = await a.post('/api/stays/restore', { items: [{ id: BIG, ...stay(A) }] });
  assert.equal(r1.status, 400);
  assert.equal(r1.json.error, '入力が不正です');
  assert.equal((await a.post('/api/stays', stay(A))).status, 201);
  assert.equal((await anon.get('/api/stays')).status, 200);

  const r2 = await a.post('/api/memos/restore', { items: [{ id: BIG, ...memo(A), all_day: 1, start: '2030-01-05', end: '2030-01-06' }] });
  assert.equal(r2.status, 400);
  assert.equal(r2.json.error, '入力が不正です');
  assert.equal((await a.post('/api/memos/batch', memo(A))).status, 201);
  assert.equal((await anon.get('/api/memos')).status, 200);
});
