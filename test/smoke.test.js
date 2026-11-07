const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, Client } = require('./helpers');

test('サーバーが起動して /api/people を返す', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const r = await new Client(srv.base).get('/api/people');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
});

// 起動に失敗した startServer は、子プロセスも一時ディレクトリも残さない。
// 失敗した Error には、後始末の確認用に pid と dataDir が付く
function assertCleanedUp(err) {
  assert.ok(err.pid, 'err.pid');
  assert.throws(() => process.kill(err.pid, 0), { code: 'ESRCH' }, '子プロセスが残っている');
  assert.ok(err.dataDir, 'err.dataDir');
  assert.equal(fs.existsSync(err.dataDir), false, '一時ディレクトリが残っている');
}

const rejection = (promise) => promise.then(() => assert.fail('startServer が成功してしまった'), (err) => err);

test('起動直後に落ちたら、後始末をして出力つきで reject する', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iruinai-smoketest-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // 通常のファイルの下は作れないので、server.js は起動時に落ちる
  const file = path.join(scratch, 'file');
  fs.writeFileSync(file, '');

  const err = await rejection(startServer({ DATA_DIR: path.join(file, 'data') }));
  assert.match(err.message, /server exited/);
  assert.match(err.message, /ENOTDIR/); // サーバーの出力が入っている
  assertCleanedUp(err);
});

test('起動待ちがタイムアウトしたら、子プロセスを止めて後始末をして reject する', async () => {
  // 1ms では起動が間に合わない
  const err = await rejection(startServer({}, { startTimeout: 1 }));
  assert.match(err.message, /timeout: server start/);
  assertCleanedUp(err);
});
