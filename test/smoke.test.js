const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');

test('サーバーが起動して /api/people を返す', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const r = await new Client(srv.base).get('/api/people');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
});
