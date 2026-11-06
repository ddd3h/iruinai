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
async function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iruinai-test-'));
  const port = await freePort();
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
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await waitFor(() => out.includes('在室カレンダー: http') || (child.exitCode !== null && 'exited'), 'server start');
  if (child.exitCode !== null) throw new Error('server exited:\n' + out);

  const mails = () => [...out.matchAll(/\[mail\] to=(\S+) subject=(.*)\n([\s\S]*?)\n\[\/mail\]/g)]
    .map((m) => ({ to: m[1], subject: m[2], text: m[3] }));
  const mailCount = (to) => mails().filter((m) => m.to === to).length;

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
    openDb: () => new DatabaseSync(path.join(dataDir, 'app.db')),
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

  async request(method, url, body, { form = false } = {}) {
    const headers = {};
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body !== undefined) {
      if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        payload = new URLSearchParams(body).toString();
      } else {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
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
  const v = await c.post('/api/auth/verify', { email, code });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  c.user = v.json.user;
  return c;
}

module.exports = { startServer, Client, registerUser, waitFor };
