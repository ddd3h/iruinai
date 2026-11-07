const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitFor(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// 一時の DATA_DIR・空きポートで server.js を子プロセスとして起動する。本番の data/ には触れない
// 起動に失敗したら、子プロセスを止め、一時ディレクトリを消してから reject する
// （呼び出し側は成功した後でしか srv.stop() を登録できないため）。
// reject する Error には、確認用に pid と dataDir を付ける。
// startTimeout は起動待ちの上限（ミリ秒）。テストで失敗経路を速く確かめるために変えられる。
// seed(dataDir) は起動前に呼ばれ、DATA_DIR に古い形式の app.db などを置くのに使える
// fakeClock: true なら、子プロセスの Date.now() を srv.advanceClock(ms) で進められる（test/fake-clock.js）。
// 「1分たつと戻る」を待たずに確かめるためのもの。この場合、テスト側から DB に絶対時刻（Date.now()）を書くのは避ける
async function startServer(extraEnv = {}, { startTimeout = 5000, seed, fakeClock = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iruinai-test-'));
  let port;
  let child;
  let exited;
  let out = '';
  try {
    if (seed) seed(dataDir); // 起動前に app.db などを用意する（古い形式の DB の確認用）
    port = await freePort();
    const env = {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ROOM_PASSWORD: '',
      SMTP_HOST: '',
      PUBLIC_URL: '',
      ENV_FILE: path.join(dataDir, 'none.env'), // 開発用の .env を読ませない
      ...extraEnv,
    };
    if (fakeClock) env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require=${path.join(__dirname, 'fake-clock.js')}`].filter(Boolean).join(' ');
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError = null;
    // 'close' は終了後に stdout/stderr を読み切ってから来る。起動に失敗したときは 'error' だけが来る
    exited = new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', (err) => { spawnError = err; resolve(); });
    });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const hasExited = () => spawnError !== null || child.exitCode !== null || child.signalCode !== null;
    await waitFor(() => out.includes('在室カレンダー: http') || hasExited(), 'server start', startTimeout);
    if (hasExited()) {
      await exited; // 出力を読み切る
      throw new Error(spawnError ? `server spawn failed: ${spawnError.message}` : 'server exited');
    }
  } catch (err) {
    if (child) {
      child.kill('SIGKILL'); // すでに終わっていれば何も起きない
      await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    const failure = new Error(`${err.message}\n${out}`, { cause: err });
    failure.pid = child && child.pid;
    failure.dataDir = dataDir;
    throw failure;
  }

  const mails = () => [...out.matchAll(/\[mail\] to=(\S+) subject=(.*)\n([\s\S]*?)\n\[\/mail\]/g)]
    .map((m) => ({ to: m[1], subject: m[2], text: m[3] }));
  const mailCount = (to) => mails().filter((m) => m.to === to).length;
  let clockOffset = 0;

  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    output: () => out,
    mails,
    mailCount,
    // to 宛のメールが minCount 通以上になるまで待ち、いちばん新しい 1 通を返す
    async waitMail(to, minCount = 1) {
      await waitFor(() => mailCount(to) >= minCount, `mail to ${to}`);
      const list = mails().filter((m) => m.to === to);
      return list[list.length - 1];
    },
    // fakeClock: true で起動したサーバーの時計を ms 進める。一時ファイルに書いて rename し、読み途中の値を見せない
    advanceClock(ms) {
      assert.ok(fakeClock, 'startServer(…, { fakeClock: true }) で起動したときだけ使える');
      clockOffset += ms;
      const file = path.join(dataDir, 'clock-offset');
      fs.writeFileSync(file + '.tmp', String(clockOffset));
      fs.renameSync(file + '.tmp', file);
    },
    // サーバーも起動直後に書き込む（期限切れの行の掃除）ので、ロックされていたら待つ
    openDb() {
      const db = new DatabaseSync(path.join(dataDir, 'app.db'));
      db.exec('PRAGMA busy_timeout = 5000');
      return db;
    },
    async stop() {
      child.kill();
      await exited;
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Cookie を覚える fetch ラッパー
class Client {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
    this.user = null;
  }

  // headers: 追加のリクエストヘッダー。raw: true なら body（文字列または Buffer）をそのまま送る（壊れた本文の確認用。content-type は headers で指定）
  async request(method, url, body, { form = false, headers: extra = {}, raw = false } = {}) {
    const headers = {};
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body !== undefined) {
      if (raw) {
        payload = body;
      } else if (body instanceof FormData) {
        payload = body; // multipart。content-type（boundary つき）は fetch が付ける
      } else if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        payload = new URLSearchParams(body).toString();
      } else {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    Object.assign(headers, extra);
    const res = await fetch(this.base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const gone = attrs.some((a) => a.trim().toLowerCase() === 'max-age=0');
      if (gone || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* JSON 以外 */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  get(url) { return this.request('GET', url); }
  post(url, body = {}) { return this.request('POST', url, body); }
  put(url, body = {}) { return this.request('PUT', url, body); }
  del(url) { return this.request('DELETE', url); }
  postForm(url, body) { return this.request('POST', url, body, { form: true }); }
  putMultipart(url, formData) { return this.request('PUT', url, formData); }
}

// 登録 → コード確認までを API で行い、ログイン済みの Client を返す
// person: { new_name, new_color? } または { person_id }
async function registerUser(srv, { email, password = 'password123', person }) {
  const c = new Client(srv.base);
  const before = srv.mailCount(email.trim().toLowerCase());
  const r = await c.post('/api/auth/signup', { email, password, ...person });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const mail = await srv.waitMail(email.trim().toLowerCase(), before + 1);
  const code = mail.text.match(/確認コード: (\d{6})/)[1];
  const v = await c.post('/api/auth/verify', { email, code, password });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  c.user = v.json.user;
  return c;
}

module.exports = { startServer, Client, registerUser, waitFor };
