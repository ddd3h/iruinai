const test = require('node:test');
const assert = require('node:assert/strict');
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
  assert.equal(r.headers.get('location'), '/login');
});
