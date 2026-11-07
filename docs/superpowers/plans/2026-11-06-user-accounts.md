# ユーザーアカウント Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** メール+PW のログインと所有者による編集制限を入れる。閲覧だけなら今までどおり合言葉で入れる。

**Architecture:** 認証まわりを `lib/` に切り出す（`db`, `secrets`, `mailer`, `auth`, `guard`）。`server.js` は既存の people/stays/memos のルートを残し、権限の検査だけを挟む。セッションは SQLite の `sessions` 表 + HttpOnly Cookie。メールは `nodemailer`（`SMTP_HOST` 未設定ならコンソール出力）。

**Tech Stack:** Node.js 22.13+（`node:sqlite`, `process.loadEnvFile`, `node:test`）、Express 5、nodemailer、素の HTML/JS/CSS。

**Spec:** `docs/superpowers/specs/2026-11-06-user-accounts-design.md`

**実行の前提:**
- 作業は新しいブランチ `feat/user-accounts` で行う（今は `main`）。
- 各タスク末尾の「Commit」は、このプランをユーザーが承認した後に実行する。コミットメッセージは日本語で、末尾に `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` を付ける。
- `.serena/` は絶対に `git add` しない。`git add` は、各タスクに書いたパスだけを指定する。
- テストは必ず一時の `DATA_DIR` で動かす。本番の `data/` には触れない。

## Global Constraints

- Node.js 22.13 以降。新しい依存は `nodemailer` だけ。
- PW は 8文字以上 128文字以下。メールは 254文字以下。新規の人の名前は 20文字以下（人ダイアログの `maxlength=20` と同じ）。
- PW のハッシュは `crypto.scrypt`（ソルト 16バイト、鍵長 64バイト）。形式は `scrypt$N$r$p$salt$hash`。比較は `crypto.timingSafeEqual`。
- トークン（セッション、リセット）は `crypto.randomBytes(32)` の base64url。DB には SHA-256 の hash だけを保存する。6桁コードは `crypto.randomInt`。DB には hash だけを保存する。
- セッションは 30日。使うたびに延ばす。Cookie 名は `iruinai_session`。属性は `HttpOnly; SameSite=Lax; Path=/`、HTTPS のときは `Secure`。
- 6桁コード: 有効 10分、間違いは 5回まで、再送は 60秒空ける。リセット URL: 有効 1時間、1回限り。
- ログイン失敗: 同じ IP から 5回続けたら 1分待たせる（今の合言葉と同じ方式）。
- 未ログインの POST/PUT/DELETE（`/api/auth/*` 以外）は `401 {"error":"ログインしてください","needLogin":true}`。他人のものへの操作は `403`。入力の不正やコード違いは `400`。メッセージは日本語。
- 合言葉（`ROOM_PASSWORD`）は最初の関門のまま。`/account` と `/reset` も合言葉の後ろに置く。
- `.env` は `process.loadEnvFile()` で読む。既に設定済みの環境変数は上書きしない。`ENV_FILE` で読む場所を変えられる（テスト用）。
- `SMTP_HOST` 未設定なら、メールは送らず、次の形式でコンソールに出す。テストはこの形式を読む。

```
[mail] to=<宛先> subject=<件名>
<本文>
[/mail]
```

## Review Focus

仕様が暗黙に求めているが、素直なテストでは当たらない入力を 5 つ挙げる。各行のテストは、担当タスクの中に入っている。

1. メールの大文字小文字と前後の空白: `" Alice@Example.COM "` で登録したら、`alice@example.com` でログインできる（Task 4, 5）。
2. 同じ既存の人を、2 人が別のメールで同時に選ぶ: 先にコードを確認した 1 人だけが成功する。残りは失敗し、`users` は増えず、残りの途中データも消える（Task 4）。
3. SMTP が落ちている・設定が間違っている: 「メールを送れませんでした」を返し、登録の途中データが残らない（Task 4）。
4. PW リセット URL: 使用後の再利用不可、期限切れ不可、短すぎる PW で失敗してもトークンは消費されない、成功すると既存のセッションがすべて無効になる（Task 5）。
5. 所有者のすり替え: `PUT` で自分の在室を他人の `person_id` に付け替える、他人のメモを `person_id: null`（部屋）にして奪う、`restore` で他人の行の `id` を上書きする、`remove` に他人の `id` を 1 件混ぜる。いずれも `403` で、何も変わらない（Task 6）。

---

## File Structure

| ファイル | 役割 |
| --- | --- |
| `lib/db.js`（新規） | DB の初期化、全テーブル、`inTransaction` |
| `lib/secrets.js`（新規） | PW のハッシュ、トークンとコードの生成、hash |
| `lib/mailer.js`（新規） | メール送信（SMTP またはコンソール出力） |
| `lib/cookies.js`（新規） | `readCookie` |
| `lib/auth.js`（新規） | 登録・ログイン・リセット・`/api/me`・退会のルート、セッションを読むミドルウェア |
| `lib/guard.js`（新規） | 未ログインの書き込み拒否、所有者の検査 |
| `server.js`（変更） | `.env` の読み込み、`lib/` の組み込み、既存ルートへの権限検査、人の作成・削除ルートの廃止 |
| `public/account.html`, `public/account.js`（新規） | ログイン・登録・コード入力・リセットの画面 |
| `public/index.html`, `public/app.js`, `public/style.css`（変更） | ヘッダー、ロック、人の固定、他人の予定の閲覧専用、退会 |
| `test/helpers.js`（新規） | サーバーの起動、Cookie 付きのクライアント、メールの読み取り |
| `test/*.test.js`（新規） | `node:test` のテスト |
| `.env.example`, `README.md`（変更・新規） | 設定とドキュメント |

---

### Task 1: 土台（ブランチ、依存、`.env`、`lib/db.js`、テスト基盤）

**Files:**
- Create: `lib/db.js`, `test/helpers.js`, `test/smoke.test.js`, `.env.example`
- Modify: `server.js`（先頭の DB 初期化と `inTransaction` を移す）、`package.json`

**Interfaces:**
- Produces:
  - `lib/db.js` → `{ db, DATA_DIR, UPLOAD_DIR, inTransaction(fn) }`
  - `test/helpers.js` → `startServer(extraEnv?) => Promise<{ base, dataDir, output(), mails(), mailCount(to), waitMail(to, minCount?), openDb(), stop() }>`、`class Client`（`get/post/put/del/postForm`、各 `=> { status, json, text, headers }`）、`registerUser(srv, { email, password?, person }) => Promise<Client>`（`client.user` に `{ id, email, person_id }`）

- [ ] **Step 1: ブランチを作り、依存を入れる**

```bash
cd /home/ddd3h/iruinai
git switch -c feat/user-accounts
npm install nodemailer
npm ls nodemailer
```

Expected: `nodemailer@<バージョン>` が表示される。`package.json` の `dependencies` に `nodemailer` が増える。

- [ ] **Step 2: テスト基盤を書く**

`test/helpers.js`:

```js
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
```

`test/smoke.test.js`:

```js
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
```

`package.json` の `scripts` を次にする（`start` は残す）:

```json
"scripts": {
  "start": "node server.js",
  "test": "node --test \"test/**/*.test.js\""
}
```

- [ ] **Step 3: 今のサーバーでスモークテストを通す（リファクタ前の基準）**

Run: `npm test`
Expected: `pass 1`。（今のコードで通る。これはリファクタが壊していないことを確かめる基準になる。）

- [ ] **Step 4: `lib/db.js` を作り、`server.js` から DB 初期化を移す**

`lib/db.js`（既存の表の定義は `server.js` からそのまま移し、末尾に新しい表を足す）:

```js
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#4f7cff',
    icon_path TEXT
  );
  CREATE TABLE IF NOT EXISTS stays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_stays_start ON stays(start);
  CREATE INDEX IF NOT EXISTS idx_stays_person ON stays(person_id);
  -- person_id が NULL のメモは「部屋」のメモ
  CREATE TABLE IF NOT EXISTS memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    start TEXT NOT NULL,
    end TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memos_start ON memos(start);
  CREATE INDEX IF NOT EXISTS idx_memos_person ON memos(person_id);

  -- アカウント。1アカウント = 1人。人が消えるとアカウントも消える
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    person_id INTEGER NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  -- メール確認前の登録（コードを確認するまで users には入れない）
  CREATE TABLE IF NOT EXISTS pending_signups (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    person_id INTEGER,
    new_name TEXT,
    new_color TEXT,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_reset_user ON reset_tokens(user_id);
`);

function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, DATA_DIR, UPLOAD_DIR, inTransaction };
```

`server.js` の変更:

1. 先頭の `require` と `DATA_DIR`〜`db.exec(...)` までのブロックを、次に置き換える。

```js
const path = require('path');
const fs = require('fs');

// .env を読む（すでに設定されている環境変数は上書きしない）。ENV_FILE で場所を変えられる（テスト用）
const ENV_FILE = process.env.ENV_FILE || path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const express = require('express');
const compression = require('compression');
const multer = require('multer');
const crypto = require('crypto');
const { db, UPLOAD_DIR, inTransaction } = require('./lib/db');
```

2. `server.js` の中ほどにある `function inTransaction(fn) { ... }` の定義（`// ---- stays ----` のすぐ下）を削除する。
3. `DATA_DIR` を参照している箇所が残っていないか確認する。

Run: `grep -n "DATA_DIR\|DatabaseSync" server.js`
Expected: 出力なし。

- [ ] **Step 5: `.env.example` を作る**

```
# このファイルを .env にコピーして使う（.env は Git に入れない）

# 部屋の合言葉（閲覧用）。未設定なら誰でも開ける
# ROOM_PASSWORD=

# 公開 URL。PW リセットのメールに入る URL の元になる。HTTPS のプロキシの後ろでは必ず設定する
# PUBLIC_URL=https://room.example.com

# メール送信（SMTP）。SMTP_HOST が未設定なら、メールは送らずサーバーのコンソールに出す
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=
# SMTP_PASS=
# MAIL_FROM=在室カレンダー <noreply@example.com>
```

- [ ] **Step 6: リファクタ後にスモークテストを通す**

Run: `npm test`
Expected: `pass 1`。`ls data/` で本番の `data/` が増減していないことも確認する（テストは `/tmp` の一時ディレクトリを使う）。

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json lib/db.js server.js test/helpers.js test/smoke.test.js .env.example
git commit -m "アカウント機能の土台: lib/db.js に DB を切り出し、.env とテスト基盤を追加" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/secrets.js` と `lib/mailer.js` と `lib/cookies.js`

**Files:**
- Create: `lib/secrets.js`, `lib/mailer.js`, `lib/cookies.js`, `test/secrets.test.js`, `test/mailer.test.js`
- Modify: `server.js`（`readCookie` を `lib/cookies.js` に置き換える）

**Interfaces:**
- Produces:
  - `lib/secrets.js` → `hashPassword(pw) => string`、`verifyPassword(pw, stored) => boolean`、`sha256(s) => hex`、`newToken() => base64url(32バイト)`、`newCode() => '000000'〜'999999'`、`safeEqualHex(a, b) => boolean`、`DUMMY_HASH`（存在しないユーザーへのログインで時間差を消すためのハッシュ）
  - `lib/mailer.js` → `sendMail({ to, subject, text }) => Promise<void>`（失敗は reject）、`mailMode() => 'smtp' | 'console'`
  - `lib/cookies.js` → `readCookie(req, name) => string`

- [ ] **Step 1: 失敗するテストを書く**

`test/secrets.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/secrets');

test('hashPassword は scrypt$N$r$p$salt$hash の形で、検証できる', () => {
  const h = S.hashPassword('correct horse');
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
  assert.equal(S.verifyPassword('correct horse', h), true);
});

test('違う PW・壊れた hash は false', () => {
  const h = S.hashPassword('correct horse');
  assert.equal(S.verifyPassword('wrong', h), false);
  assert.equal(S.verifyPassword('correct horse', 'garbage'), false);
  assert.equal(S.verifyPassword('correct horse', ''), false);
});

test('同じ PW でもソルトで hash が変わる', () => {
  assert.notEqual(S.hashPassword('same'), S.hashPassword('same'));
});

test('newCode は先頭が 0 でも 6桁', () => {
  for (let i = 0; i < 300; i++) assert.match(S.newCode(), /^\d{6}$/);
});

test('newToken は毎回違い、十分に長い', () => {
  const a = S.newToken();
  assert.notEqual(a, S.newToken());
  assert.ok(a.length >= 43);
});

test('safeEqualHex は長さが違っても例外を出さない', () => {
  assert.equal(S.safeEqualHex(S.sha256('a'), S.sha256('a')), true);
  assert.equal(S.safeEqualHex(S.sha256('a'), S.sha256('b')), false);
  assert.equal(S.safeEqualHex('ab', 'abcd'), false);
});

test('DUMMY_HASH は検証できる形式', () => {
  assert.equal(S.verifyPassword('x', S.DUMMY_HASH), false);
});
```

`test/mailer.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('SMTP_HOST 未設定ならコンソールに出す', async () => {
  delete process.env.SMTP_HOST;
  const { sendMail, mailMode } = require('../lib/mailer');
  assert.equal(mailMode(), 'console');
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await sendMail({ to: 'a@example.com', subject: '件名', text: '本文1\n本文2' });
  } finally {
    console.log = orig;
  }
  assert.equal(lines.join('\n'), '[mail] to=a@example.com subject=件名\n本文1\n本文2\n[/mail]');
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/secrets.test.js test/mailer.test.js`
Expected: FAIL（`Cannot find module '../lib/secrets'`）

- [ ] **Step 3: 実装する**

`lib/secrets.js`:

```js
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  let actual;
  try {
    actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// 存在しないメールでのログインでも scrypt を 1 回走らせて、応答時間の差を小さくする
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

module.exports = { hashPassword, verifyPassword, sha256, newToken, newCode, safeEqualHex, DUMMY_HASH };
```

`lib/mailer.js`:

```js
let transport = null;

const smtpConfigured = () => !!process.env.SMTP_HOST;
const mailMode = () => (smtpConfigured() ? 'smtp' : 'console');

function getTransport() {
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return transport;
}

// 失敗したら reject する。SMTP_HOST 未設定ならメールは送らず、コンソールに出す
async function sendMail({ to, subject, text }) {
  if (!smtpConfigured()) {
    console.log(`[mail] to=${to} subject=${subject}\n${text}\n[/mail]`);
    return;
  }
  await getTransport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}

module.exports = { sendMail, mailMode };
```

`lib/cookies.js`:

```js
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

module.exports = { readCookie };
```

`server.js`: 既存の `function readCookie(req, name) { ... }` の定義を削除し、`require` の並びに次を足す。

```js
const { readCookie } = require('./lib/cookies');
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test`
Expected: すべて pass（smoke, secrets, mailer）。

- [ ] **Step 5: Commit**

```bash
git add lib/secrets.js lib/mailer.js lib/cookies.js server.js test/secrets.test.js test/mailer.test.js
git commit -m "PW のハッシュ、トークン生成、メール送信、Cookie 読み取りを lib/ に追加" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 登録・メール確認・セッション・`/api/me`（`lib/auth.js` 前半）

**Files:**
- Create: `lib/auth.js`, `test/auth-signup.test.js`
- Modify: `server.js`（ルートの組み込み、`/logout`、起動ログ）

**Interfaces:**
- Consumes: `lib/db.js` の `db`, `inTransaction`、`lib/secrets.js` の全関数、`lib/mailer.js` の `sendMail`, `mailMode`、`lib/cookies.js` の `readCookie`、`test/helpers.js`
- Produces: `lib/auth.js` → `{ authRouter, meRouter, attachUser(req, res, next), cleanup(), destroySession(req, res), COOKIE }`
  - `req.user` = `null` または `{ id, email, person_id }`
  - `POST /api/auth/signup` body `{ email, password, person_id }` または `{ email, password, new_name, new_color }` → `200 { ok: true }`
  - `POST /api/auth/verify` body `{ email, code }` → `200 { user }` + セッション Cookie
  - `POST /api/auth/resend` body `{ email }` → `200 { ok: true }`
  - `POST /api/auth/logout` → `200 { ok: true }`
  - `GET /api/me` → `{ user: null | { id, email, person_id } }`

> Task 4 で、同じ `lib/auth.js` に `login`, `forgot`, `reset`, `POST /api/me/withdraw` を足す。この Task では `authRouter` と `meRouter` を作り、`meRouter` には `GET /` だけを置く。

- [ ] **Step 1: 失敗するテストを書く**

`test/auth-signup.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, registerUser } = require('./helpers');

const codeOf = (mail) => mail.text.match(/確認コード: (\d{6})/)[1];

test('新しい人で登録 → コード確認 → ログイン状態になる（メールは小文字化される）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);

  assert.deepEqual((await c.get('/api/me')).json, { user: null });

  const s = await c.post('/api/auth/signup', { email: ' Alice@Example.COM ', password: 'password123', new_name: 'アリス', new_color: '#112233' });
  assert.equal(s.status, 200);
  const mail = await srv.waitMail('alice@example.com');
  assert.match(mail.subject, /確認コード/);

  const v = await c.post('/api/auth/verify', { email: 'ALICE@example.com', code: codeOf(mail) });
  assert.equal(v.status, 200);
  assert.equal(v.json.user.email, 'alice@example.com');

  const me = (await c.get('/api/me')).json.user;
  assert.equal(me.email, 'alice@example.com');
  const people = (await c.get('/api/people')).json;
  const mine = people.find((p) => p.id === me.person_id);
  assert.equal(mine.name, 'アリス');
  assert.equal(mine.color, '#112233');
});

test('Cookie は HttpOnly・SameSite=Lax で、DB にはトークンの hash だけが入る', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const mail = await srv.waitMail('a@example.com');
  const v = await c.post('/api/auth/verify', { email: 'a@example.com', code: codeOf(mail) });
  const setCookie = v.headers.getSetCookie().find((l) => l.startsWith('iruinai_session='));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const token = setCookie.split(';')[0].split('=')[1];
  const db = srv.openDb();
  const row = db.prepare('SELECT token_hash FROM sessions').get();
  db.close();
  assert.notEqual(row.token_hash, token);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test('既存の未紐付けの人を選んで登録できる。紐付け済みの人は選べない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name, color) VALUES ('既存', '#abcdef')").run().lastInsertRowid);
  db.close();

  const a = await registerUser(srv, { email: 'a@example.com', person: { person_id: pid } });
  assert.equal(a.user.person_id, pid);

  const c = new Client(srv.base);
  const r = await c.post('/api/auth/signup', { email: 'b@example.com', password: 'password123', person_id: pid });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /すでに使われています/);
  assert.equal(srv.mailCount('b@example.com'), 0);
});

test('存在しない人・不正な入力は 400', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const ok = { email: 'a@example.com', password: 'password123', new_name: 'A' };
  const cases = [
    { ...ok, email: 'not-an-email' },
    { ...ok, email: 'a'.repeat(250) + '@example.com' },
    { ...ok, password: '1234567' },
    { ...ok, password: 'x'.repeat(129) },
    { ...ok, new_name: '' },
    { ...ok, new_name: 'あ'.repeat(21) },
    { email: 'a@example.com', password: 'password123', person_id: 99999 },
    { email: 'a@example.com', password: 'password123', person_id: 'abc' },
  ];
  for (const body of cases) {
    const r = await c.post('/api/auth/signup', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(srv.mails().length, 0);
});

test('登録済みのメールは登録できない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const r = await new Client(srv.base).post('/api/auth/signup', { email: 'A@example.com', password: 'password123', new_name: 'B' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /登録済み/);
});

test('コードを 5回間違えると無効になり、その後は正しいコードでも通らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const good = codeOf(await srv.waitMail('a@example.com'));
  const bad = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await c.post('/api/auth/verify', { email: 'a@example.com', code: bad });
    assert.equal(r.status, 400);
  }
  const r = await c.post('/api/auth/verify', { email: 'a@example.com', code: good });
  assert.equal(r.status, 400);
  assert.equal((await c.get('/api/me')).json.user, null);
});

test('コードの期限が切れると通らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const good = codeOf(await srv.waitMail('a@example.com'));
  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET expires_at = 1').run();
  db.close();
  const r = await c.post('/api/auth/verify', { email: 'a@example.com', code: good });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /有効期限/);
});

test('再送は 60秒空ける。再送すると古いコードは使えず、新しいコードで通る', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const first = codeOf(await srv.waitMail('a@example.com'));

  // 続けての signup・resend は 429
  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' })).status, 429);
  assert.equal((await c.post('/api/auth/resend', { email: 'a@example.com' })).status, 429);

  const db = srv.openDb();
  db.prepare('UPDATE pending_signups SET sent_at = sent_at - 61000').run();
  db.close();
  assert.equal((await c.post('/api/auth/resend', { email: 'a@example.com' })).status, 200);
  const second = codeOf(await srv.waitMail('a@example.com', 2));

  if (first !== second) {
    assert.equal((await c.post('/api/auth/verify', { email: 'a@example.com', code: first })).status, 400);
  }
  assert.equal((await c.post('/api/auth/verify', { email: 'a@example.com', code: second })).status, 200);
});

test('同じ既存の人を 2人が選んだら、先に確認した 1人だけ成功する', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name, color) VALUES ('既存', '#abcdef')").run().lastInsertRowid);
  db.close();

  const a = new Client(srv.base);
  const b = new Client(srv.base);
  assert.equal((await a.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', person_id: pid })).status, 200);
  assert.equal((await b.post('/api/auth/signup', { email: 'b@example.com', password: 'password123', person_id: pid })).status, 200);
  const codeA = codeOf(await srv.waitMail('a@example.com'));
  const codeB = codeOf(await srv.waitMail('b@example.com'));

  assert.equal((await a.post('/api/auth/verify', { email: 'a@example.com', code: codeA })).status, 200);
  const rb = await b.post('/api/auth/verify', { email: 'b@example.com', code: codeB });
  assert.equal(rb.status, 400);
  assert.match(rb.json.error, /すでに使われています/);

  const db2 = srv.openDb();
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM pending_signups WHERE email = 'b@example.com'").get().n, 0);
  db2.close();
  // b は選び直してすぐ登録し直せる（再送の待ち時間に引っかからない）
  assert.equal((await b.post('/api/auth/signup', { email: 'b@example.com', password: 'password123', new_name: 'B' })).status, 200);
});

test('コード確認の直前にメールが先に使われたら、新しい人を作らずに失敗する', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const code = codeOf(await srv.waitMail('a@example.com'));
  // コード確認の直前に、同じメールのユーザーが先に作られた状況を作る
  const db = srv.openDb();
  const pid = Number(db.prepare("INSERT INTO people (name) VALUES ('先客')").run().lastInsertRowid);
  db.prepare("INSERT INTO users (email, password_hash, person_id, created_at) VALUES ('a@example.com', 'x', ?, 0)").run(pid);
  const before = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
  db.close();
  const r = await c.post('/api/auth/verify', { email: 'a@example.com', code });
  assert.equal(r.status, 400);
  const db2 = srv.openDb();
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM people').get().n, before);
  db2.close();
});

test('SMTP に送れないときは「メールを送れませんでした」で、途中データが残らない', async (t) => {
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
  t.after(() => srv.stop());
  const r = await new Client(srv.base).post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'メールを送れませんでした');
  const db = srv.openDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_signups').get().n, 0);
  db.close();
});

test('ログアウトするとセッションが消える。期限切れのセッションは無効', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  assert.ok((await c.get('/api/me')).json.user);
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/me')).json.user, null);
  const db = srv.openDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  db.close();

  const d = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B' } });
  const db2 = srv.openDb();
  db2.prepare('UPDATE sessions SET expires_at = 1').run();
  db2.close();
  assert.equal((await d.get('/api/me')).json.user, null);
});

test('合言葉が最初の関門のまま。合言葉なしでは登録 API にも届かない', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  const r = await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  assert.equal(r.status, 401);
  assert.equal(r.json.needLogin, undefined); // 合言葉の 401 と書き込みガードの 401 は区別できる

  assert.equal((await c.postForm('/login', { password: 'himitsu' })).status, 303);
  assert.equal((await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' })).status, 200);
});

test('GET /logout は合言葉とセッションの Cookie を両方消す', async (t) => {
  const srv = await startServer({ ROOM_PASSWORD: 'himitsu' });
  t.after(() => srv.stop());
  const c = new Client(srv.base);
  await c.postForm('/login', { password: 'himitsu' });
  await c.post('/api/auth/signup', { email: 'a@example.com', password: 'password123', new_name: 'A' });
  const code = codeOf(await srv.waitMail('a@example.com'));
  await c.post('/api/auth/verify', { email: 'a@example.com', code });
  assert.ok(c.jar.has('iruinai_session') && c.jar.has('iruinai_auth'));
  const r = await c.get('/logout');
  assert.equal(r.status, 303);
  assert.equal(c.jar.size, 0);
  const db = srv.openDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  db.close();
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/auth-signup.test.js`
Expected: FAIL（`/api/auth/signup` が 404 など）。

- [ ] **Step 3: `lib/auth.js` を書く**

```js
const express = require('express');
const { db, inTransaction } = require('./db');
const { sendMail, mailMode } = require('./mailer');
const { readCookie } = require('./cookies');
const S = require('./secrets');

const COOKIE = 'iruinai_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // 延長は 1日に 1回まで
const CODE_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const validEmail = (e) => e.length <= 254 && EMAIL_RE.test(e);
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 128;
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const publicUser = (id) => db.prepare('SELECT id, email, person_id FROM users WHERE id = ?').get(id);

// ---- セッション ----
function sessionCookie(req, token, maxAgeSec) {
  return `${COOKIE}=${token}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;
}

function createSession(req, res, userId) {
  const token = S.newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(S.sha256(token), userId, Date.now() + SESSION_MS);
  res.append('Set-Cookie', sessionCookie(req, token, SESSION_MS / 1000));
}

function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(S.sha256(token));
  res.append('Set-Cookie', sessionCookie(req, '', 0));
}

// Cookie からログイン中のユーザーを読み、req.user に入れる（なければ null）
function attachUser(req, res, next) {
  req.user = null;
  const token = readCookie(req, COOKIE);
  if (token) {
    const now = Date.now();
    const hash = S.sha256(token);
    const row = db.prepare(`SELECT s.expires_at, u.id, u.email, u.person_id
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
    if (row && row.expires_at > now) {
      req.user = { id: row.id, email: row.email, person_id: row.person_id };
      if (row.expires_at - now < SESSION_MS - REFRESH_AFTER_MS) {
        db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_MS, hash);
        res.append('Set-Cookie', sessionCookie(req, token, SESSION_MS / 1000));
      }
    }
  }
  next();
}

// 期限切れの行を消す
function cleanup() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM pending_signups WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM reset_tokens WHERE expires_at < ?').run(now);
}

function personUnavailable(id) {
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) return 'その人は存在しません';
  if (db.prepare('SELECT 1 FROM users WHERE person_id = ?').get(id)) return 'その人はすでに使われています';
  return null;
}

function signupMail(code) {
  return {
    subject: '【在室カレンダー】確認コード',
    text: `在室カレンダーの確認コードです。\n\n確認コード: ${code}\n\nこのコードは10分間有効です。心当たりがない場合は、このメールを無視してください。`,
  };
}

// ---- /api/auth ----
const authRouter = express.Router();

authRouter.post('/signup', async (req, res) => {
  const b = req.body || {};
  const email = normEmail(b.email);
  if (!validEmail(email)) return bad(res, 'メールアドレスの形式が正しくありません');
  if (!validPassword(b.password)) return bad(res, 'パスワードは8文字以上128文字以下にしてください');
  let personId = null;
  let newName = null;
  let newColor = null;
  if (b.person_id != null) {
    personId = Number(b.person_id);
    if (!Number.isInteger(personId)) return bad(res, '人を選んでください');
    const msg = personUnavailable(personId);
    if (msg) return bad(res, msg);
  } else {
    newName = String(b.new_name ?? '').trim();
    if (!newName || newName.length > 20) return bad(res, '名前を入力してください（20字まで）');
    newColor = COLOR_RE.test(b.new_color) ? b.new_color : '#4f7cff';
  }
  cleanup();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'このメールアドレスは登録済みです');
  const prev = db.prepare('SELECT sent_at FROM pending_signups WHERE email = ?').get(email);
  if (prev && Date.now() - prev.sent_at < RESEND_MS) return bad(res, '確認メールを送ったばかりです。1分ほど待ってからもう一度どうぞ', 429);

  const code = S.newCode();
  const now = Date.now();
  db.prepare(`INSERT INTO pending_signups (email, password_hash, person_id, new_name, new_color, code_hash, expires_at, attempts, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, person_id = excluded.person_id,
      new_name = excluded.new_name, new_color = excluded.new_color, code_hash = excluded.code_hash,
      expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`)
    .run(email, S.hashPassword(b.password), personId, newName, newColor, S.sha256(code), now + CODE_MS, now);
  try {
    await sendMail({ to: email, ...signupMail(code) });
  } catch (err) {
    db.prepare('DELETE FROM pending_signups WHERE email = ?').run(email);
    console.log('確認メールの送信に失敗:', err.message);
    return bad(res, 'メールを送れませんでした', 502);
  }
  res.json({ ok: true });
});

authRouter.post('/verify', (req, res) => {
  const email = normEmail(req.body?.email);
  const code = String(req.body?.code ?? '').trim();
  const drop = () => db.prepare('DELETE FROM pending_signups WHERE email = ?').run(email);
  const p = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(email);
  if (!p || p.expires_at < Date.now()) {
    if (p) drop();
    return bad(res, 'コードの有効期限が切れました。もう一度登録してください');
  }
  if (!/^\d{6}$/.test(code) || !S.safeEqualHex(S.sha256(code), p.code_hash)) {
    const attempts = p.attempts + 1;
    if (attempts >= CODE_MAX_ATTEMPTS) {
      drop();
      return bad(res, '間違いが続いたので、もう一度登録してください');
    }
    db.prepare('UPDATE pending_signups SET attempts = ? WHERE email = ?').run(attempts, email);
    return bad(res, 'コードが違います');
  }
  let userId;
  try {
    inTransaction(() => {
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error('このメールアドレスは登録済みです');
      let personId = p.person_id;
      if (personId != null) {
        const msg = personUnavailable(personId);
        if (msg) throw new Error(msg);
      } else {
        personId = Number(db.prepare('INSERT INTO people (name, color) VALUES (?, ?)').run(p.new_name, p.new_color).lastInsertRowid);
      }
      userId = Number(db.prepare('INSERT INTO users (email, password_hash, person_id, created_at) VALUES (?, ?, ?, ?)')
        .run(email, p.password_hash, personId, Date.now()).lastInsertRowid);
      drop();
    });
  } catch (err) {
    drop(); // 選び直してすぐ登録し直せるように、途中データを消す
    return bad(res, err.message);
  }
  createSession(req, res, userId);
  res.json({ user: publicUser(userId) });
});

authRouter.post('/resend', async (req, res) => {
  const email = normEmail(req.body?.email);
  const p = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(email);
  if (!p || p.expires_at < Date.now()) return bad(res, '登録の手続きが見つかりません。もう一度登録してください');
  if (Date.now() - p.sent_at < RESEND_MS) return bad(res, '再送は1分ほど空けてください', 429);
  const code = S.newCode();
  try {
    await sendMail({ to: email, ...signupMail(code) });
  } catch (err) {
    console.log('確認メールの再送に失敗:', err.message);
    return bad(res, 'メールを送れませんでした', 502);
  }
  const now = Date.now();
  db.prepare('UPDATE pending_signups SET code_hash = ?, expires_at = ?, attempts = 0, sent_at = ? WHERE email = ?')
    .run(S.sha256(code), now + CODE_MS, now, email);
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// ---- /api/me ----
const meRouter = express.Router();

meRouter.get('/', (req, res) => {
  res.json({ user: req.user });
});

module.exports = { authRouter, meRouter, attachUser, cleanup, destroySession, COOKIE, mailMode };
```

- [ ] **Step 4: `server.js` に組み込む**

1. `require` の並びに次を足す。

```js
const { authRouter, meRouter, attachUser, cleanup: cleanupAuth, destroySession, COOKIE: SESSION_COOKIE, mailMode } = require('./lib/auth');
```

2. 既存の `app.get('/logout', ...)`（`if (PASSWORD) { ... }` の中）を次に置き換える。

```js
  app.get('/logout', (req, res) => {
    destroySession(req, res); // セッションの行と Cookie を消す
    res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
    res.redirect(303, '/login');
  });
```

3. `if (PASSWORD) { ... }` ブロックの直後（`app.get(['/', '/index.html'], pageIndex);` の前）に次を足す。

```js
// ---- アカウント ----
app.use(attachUser);
app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
```

4. `SESSION_COOKIE` は使わないので、`require` からは外す（上の 1 の行を `const { authRouter, meRouter, attachUser, cleanup: cleanupAuth, destroySession, mailMode } = require('./lib/auth');` にする）。

5. 末尾の `app.listen(...)` のコールバックに、合言葉のログの下へ次を足す。

```js
  console.log(mailMode() === 'smtp' ? 'メール: SMTP で送信' : 'メール: コンソール出力（SMTP_HOST 未設定）');
  if (mailMode() === 'smtp' && !PUBLIC_URL) console.warn('警告: PUBLIC_URL が未設定です。PW リセットの URL が Host ヘッダーから作られます。.env で PUBLIC_URL を設定してください');
  cleanupAuth();
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test`
Expected: すべて pass。

- [ ] **Step 6: Commit**

```bash
git add lib/auth.js server.js test/auth-signup.test.js
git commit -m "登録・メール確認(6桁コード)・セッション・/api/me を追加" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ログイン・PW リセット・退会（`lib/auth.js` 後半）

**Files:**
- Modify: `lib/auth.js`
- Create: `test/auth-session.test.js`

**Interfaces:**
- Consumes: Task 3 の `lib/auth.js`（`createSession`, `destroySession`, `normEmail`, `validEmail`, `validPassword`, `bad`, `publicUser`、`authRouter`, `meRouter`）、`test/helpers.js`
- Produces:
  - `POST /api/auth/login` body `{ email, password }` → `200 { user }` + Cookie。失敗は `400`、制限中は `429`
  - `POST /api/auth/forgot` body `{ email }` → 常に `200 { ok: true }`
  - `POST /api/auth/reset` body `{ token, password }` → `200 { ok: true }`。無効は `400`
  - `POST /api/me/withdraw` body `{ password }` → `200 { ok: true }`。未ログインは `401`、PW 違いは `400`

- [ ] **Step 1: 失敗するテストを書く**

`test/auth-session.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, registerUser } = require('./helpers');

const resetUrlOf = (mail) => mail.text.match(/(https?:\/\/\S+\/reset\?token=[\w-]+)/)[1];

test('ログイン: メールの大文字小文字・空白は無視。PW が違えば 400', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: ' Alice@Example.COM ', password: 'password123', person: { new_name: 'アリス' } });

  const c = new Client(srv.base);
  const wrong = await c.post('/api/auth/login', { email: 'alice@example.com', password: 'nope-nope' });
  assert.equal(wrong.status, 400);
  assert.equal((await c.get('/api/me')).json.user, null);

  const ok = await c.post('/api/auth/login', { email: '  ALICE@example.com ', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/me')).json.user.email, 'alice@example.com');
});

test('存在しないメールと PW 違いで、同じメッセージを返す', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const c = new Client(srv.base);
  const a = await c.post('/api/auth/login', { email: 'a@example.com', password: 'wrong-wrong' });
  const b = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-wrong' });
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
  assert.equal(a.json.error, b.json.error);
  // ダミー hash の元の PW でも、存在しないユーザーには入れない
  const d = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'dummy-password-for-timing' });
  assert.equal(d.status, 400);
});

test('同じ IP から 5回続けて失敗すると、正しい PW でも 1分は拒否される', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', password: 'password123', person: { new_name: 'A' } });
  const c = new Client(srv.base);
  for (let i = 0; i < 5; i++) {
    assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'wrong-wrong' })).status, 400);
  }
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'password123' })).status, 429);
});

test('PW リセット: 1回限り。使うと既存のセッションが全部消え、新しい PW でだけ入れる', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const old = await registerUser(srv, { email: 'a@example.com', password: 'old-password', person: { new_name: 'A' } });
  const other = new Client(srv.base);
  await other.post('/api/auth/login', { email: 'a@example.com', password: 'old-password' });

  const c = new Client(srv.base);
  const f = await c.post('/api/auth/forgot', { email: 'A@example.com' });
  assert.equal(f.status, 200);
  const url = resetUrlOf(await srv.waitMail('a@example.com', 2)); // 1通目は登録のコード
  const token = new URL(url).searchParams.get('token');
  assert.ok(url.startsWith(srv.base)); // PUBLIC_URL 未設定なら Host から組み立てる

  // 短すぎる PW では失敗し、トークンは消費されない
  assert.equal((await c.post('/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { token, password: 'brand-new-password' })).status, 200);

  // 再利用はできない
  assert.equal((await c.post('/api/auth/reset', { token, password: 'another-password' })).status, 400);
  // 既存のセッションは全部無効
  assert.equal((await old.get('/api/me')).json.user, null);
  assert.equal((await other.get('/api/me')).json.user, null);
  // 古い PW は通らず、新しい PW で入れる
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'old-password' })).status, 400);
  assert.equal((await c.post('/api/auth/login', { email: 'a@example.com', password: 'brand-new-password' })).status, 200);
});

test('PW リセット: 期限切れ・でたらめなトークンは 400', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const c = new Client(srv.base);
  await c.post('/api/auth/forgot', { email: 'a@example.com' });
  const token = new URL(resetUrlOf(await srv.waitMail('a@example.com', 2))).searchParams.get('token');
  const db = srv.openDb();
  db.prepare('UPDATE reset_tokens SET expires_at = 1').run();
  db.close();
  assert.equal((await c.post('/api/auth/reset', { token, password: 'brand-new-password' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { token: 'x'.repeat(43), password: 'brand-new-password' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { password: 'brand-new-password' })).status, 400);
});

test('PW リセット要求: 未登録のメールでも同じ応答で、メールは送らない', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  const c = new Client(srv.base);
  const known = await c.post('/api/auth/forgot', { email: 'a@example.com' });
  const unknown = await c.post('/api/auth/forgot', { email: 'nobody@example.com' });
  const garbage = await c.post('/api/auth/forgot', { email: 'garbage' });
  assert.deepEqual([known.status, unknown.status, garbage.status], [200, 200, 200]);
  assert.deepEqual(known.json, unknown.json);
  await srv.waitMail('a@example.com', 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(srv.mailCount('nobody@example.com'), 0);
  assert.equal(srv.mailCount('garbage'), 0);
});

test('PUBLIC_URL を設定すると、リセット URL はそれを元にする', async (t) => {
  const srv = await startServer({ PUBLIC_URL: 'https://room.example.com/' });
  t.after(() => srv.stop());
  await registerUser(srv, { email: 'a@example.com', person: { new_name: 'A' } });
  await new Client(srv.base).post('/api/auth/forgot', { email: 'a@example.com' });
  const url = resetUrlOf(await srv.waitMail('a@example.com', 2));
  assert.ok(url.startsWith('https://room.example.com/reset?token='), url);
});

test('退会: PW が違えば消えない。正しければ人・在室・メモ・アカウント・セッションが消える', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const a = await registerUser(srv, { email: 'a@example.com', password: 'password123', person: { new_name: 'A' } });
  const b = await registerUser(srv, { email: 'b@example.com', person: { new_name: 'B' } });
  const pid = a.user.person_id;
  const db = srv.openDb();
  db.prepare("INSERT INTO stays (person_id, start, end) VALUES (?, '2030-01-01T09:00:00', '2030-01-01T10:00:00')").run(pid);
  db.prepare("INSERT INTO memos (person_id, title, all_day, start, end) VALUES (?, 'メモ', 1, '2030-01-01', '2030-01-02')").run(pid);
  db.close();

  assert.equal((await new Client(srv.base).post('/api/me/withdraw', { password: 'password123' })).status, 401);
  const wrong = await a.post('/api/me/withdraw', { password: 'wrong-wrong' });
  assert.equal(wrong.status, 400);
  assert.ok((await a.get('/api/me')).json.user); // まだログイン中

  assert.equal((await a.post('/api/me/withdraw', { password: 'password123' })).status, 200);
  assert.equal((await a.get('/api/me')).json.user, null);
  const db2 = srv.openDb();
  const n = (sql) => db2.prepare(sql).get().n;
  assert.equal(n(`SELECT COUNT(*) AS n FROM people WHERE id = ${pid}`), 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM stays WHERE person_id = ${pid}`), 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM memos WHERE person_id = ${pid}`), 0);
  assert.equal(n("SELECT COUNT(*) AS n FROM users WHERE email = 'a@example.com'"), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM sessions'), 1); // b のセッションだけが残る
  db2.close();
  assert.ok((await b.get('/api/me')).json.user);
  assert.equal((await new Client(srv.base).post('/api/auth/login', { email: 'a@example.com', password: 'password123' })).status, 400);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/auth-session.test.js`
Expected: FAIL（`/api/auth/login` が 404 など）。

- [ ] **Step 3: `lib/auth.js` に追加する**

ファイル先頭の定数群に次を足す。

```js
const RESET_MS = 60 * 60 * 1000;
const LOGIN_LOCK_COUNT = 5;
const LOGIN_LOCK_MS = 60 * 1000;
```

`authRouter.post('/logout', ...)` の直前に次を足す。

```js
// 総当たり対策：同じ IP から 5回続けて間違えたら 1分待たせる（合言葉と同じ方式）
const loginFailures = new Map();

authRouter.post('/login', (req, res) => {
  const f = loginFailures.get(req.ip);
  if (f && f.count >= LOGIN_LOCK_COUNT && Date.now() - f.at < LOGIN_LOCK_MS) {
    return bad(res, '間違いが続いたので、1分ほど待ってからもう一度どうぞ', 429);
  }
  const email = normEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // ユーザーがいなくても scrypt を 1回走らせる（応答時間でメールの有無が分からないように）
  const verified = S.verifyPassword(password, u ? u.password_hash : S.DUMMY_HASH);
  if (!u || !verified || password.length > 128) {
    const count = f && Date.now() - f.at < LOGIN_LOCK_MS ? f.count + 1 : 1;
    loginFailures.set(req.ip, { count, at: Date.now() });
    return bad(res, 'メールアドレスまたはパスワードが違います');
  }
  loginFailures.delete(req.ip);
  cleanup();
  createSession(req, res, u.id);
  res.json({ user: publicUser(u.id) });
});

// リセット URL の元になる公開 URL（PUBLIC_URL があればそれ、なければアクセス先）
function originOf(req) {
  const fixed = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  return fixed || `${req.protocol}://${req.get('host')}`;
}

const forgotSentAt = new Map(); // メール → 最後に送った時刻（メール爆撃の防止）

authRouter.post('/forgot', async (req, res) => {
  const email = normEmail(req.body?.email);
  res.json({ ok: true }); // 登録の有無にかかわらず、先に同じ応答を返す
  try {
    if (!validEmail(email)) return;
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!u) return;
    if (Date.now() - (forgotSentAt.get(email) || 0) < RESEND_MS) return;
    forgotSentAt.set(email, Date.now());
    const token = S.newToken();
    inTransaction(() => {
      db.prepare('DELETE FROM reset_tokens WHERE user_id = ? AND used_at IS NULL').run(u.id);
      db.prepare('INSERT INTO reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(S.sha256(token), u.id, Date.now() + RESET_MS);
    });
    await sendMail({
      to: email,
      subject: '【在室カレンダー】パスワードの再設定',
      text: `パスワードを再設定するには、次のリンクを開いてください（1時間有効・1回だけ使えます）。\n\n${originOf(req)}/reset?token=${token}\n\n心当たりがない場合は、このメールを無視してください。`,
    });
  } catch (err) {
    console.log('PW リセットのメール送信に失敗:', err.message);
  }
});

authRouter.post('/reset', (req, res) => {
  const token = String(req.body?.token ?? '');
  const password = req.body?.password;
  if (!validPassword(password)) return bad(res, 'パスワードは8文字以上128文字以下にしてください'); // トークンは消費しない
  const row = db.prepare('SELECT * FROM reset_tokens WHERE token_hash = ?').get(S.sha256(token));
  if (!row || row.used_at != null || row.expires_at < Date.now()) return bad(res, 'このリンクは無効か、期限が切れています');
  inTransaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(S.hashPassword(password), row.user_id);
    db.prepare('UPDATE reset_tokens SET used_at = ? WHERE token_hash = ?').run(Date.now(), row.token_hash);
    db.prepare('DELETE FROM reset_tokens WHERE user_id = ? AND used_at IS NULL').run(row.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id); // 全端末をログアウト
  });
  res.json({ ok: true });
});
```

`meRouter.get('/', ...)` の下に次を足す。

```js
// 退会：自分の人（在室・メモごと）とアカウントを消す。元に戻せない
meRouter.post('/withdraw', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'ログインしてください', needLogin: true });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length > 128 || !S.verifyPassword(password, u.password_hash)) return bad(res, 'パスワードが違います');
  db.prepare('DELETE FROM people WHERE id = ?').run(u.person_id); // users・sessions・stays・memos は ON DELETE CASCADE
  destroySession(req, res);
  res.json({ ok: true });
});
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test`
Expected: すべて pass。

- [ ] **Step 5: Commit**

```bash
git add lib/auth.js test/auth-session.test.js
git commit -m "ログイン・PW リセット(1回限り URL)・退会を追加" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 権限の強制（`lib/guard.js` と既存ルートの変更）

**Files:**
- Create: `lib/guard.js`, `test/permissions.test.js`
- Modify: `server.js`（`// ---- people ----` から memos のルートの終わりまで）

**Interfaces:**
- Consumes: Task 3 の `attachUser`（`req.user`）、`test/helpers.js`
- Produces: `lib/guard.js` → `createGuard(db) => { deny(res, msg?), mine(req, personId), memoOk(req, personId), staysAllMine(req, ids), memosAllOk(req, ids), writeGuard(req, res, next) }`
  - `mine`: ログイン中で、`personId` が自分の `person_id` なら true（`null`, `undefined`, `''` は false）
  - `memoOk`: `personId === null`（部屋）か `mine` なら true。呼び出し側は `?? null` で正規化して渡す
  - `staysAllMine` / `memosAllOk`: `ids` のうち、DB に実在する行がすべて自分のもの（メモは部屋も可）なら true。実在しない `id` は無視する

- [ ] **Step 1: 失敗するテストを書く**

`test/permissions.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/permissions.test.js`
Expected: FAIL（未ログインの書き込みが通る、など）。

- [ ] **Step 3: `lib/guard.js` を書く**

```js
// 未ログインの書き込み拒否と、所有者の検査
function createGuard(db) {
  const deny = (res, msg = '他の人の予定やメモは変更できません') => res.status(403).json({ error: msg });

  // 自分の人か（ログイン中で、person_id が自分の人と一致）
  const mine = (req, personId) =>
    !!req.user && personId !== null && personId !== undefined && personId !== '' && Number(personId) === req.user.person_id;

  // メモの対象として許されるか（部屋 = null か、自分の人）。personId は ?? null で正規化して渡す
  const memoOk = (req, personId) => personId === null || mine(req, personId);

  const ints = (ids) => ids.filter(Number.isInteger);

  // DB にある行がすべて自分のものか（存在しない id は無視する）
  function staysAllMine(req, ids) {
    const sel = db.prepare('SELECT person_id FROM stays WHERE id = ?');
    return ints(ids).every((id) => { const r = sel.get(id); return !r || mine(req, r.person_id); });
  }

  function memosAllOk(req, ids) {
    const sel = db.prepare('SELECT person_id FROM memos WHERE id = ?');
    return ints(ids).every((id) => { const r = sel.get(id); return !r || memoOk(req, r.person_id); });
  }

  // /api の POST/PUT/DELETE はログインが必要（/api/auth/* はこの前で処理される）
  function writeGuard(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.user) return next();
    res.status(401).json({ error: 'ログインしてください', needLogin: true });
  }

  return { deny, mine, memoOk, staysAllMine, memosAllOk, writeGuard };
}

module.exports = { createGuard };
```

- [ ] **Step 4: `server.js` の `// ---- people ----` から memos の最後のルート（`app.post('/api/memos/restore', ...)`）までを、次に置き換える**

> `app.use((err, req, res, next) => {` のエラー処理から下は変えない。`restoreStays`, `restoreMemos`, `validIds`, `validStay`, `validMemoRange`, `memoTargetOk` は今のコードと同じ中身で残している。

先に、`const COLOR_RE = ...` の並び（`const app = express();` の上あたり）に次を足す。

```js
const { createGuard } = require('./lib/guard');
const guard = createGuard(db);
```

そして `app.use('/api/me', meRouter);` の直後に次を足す。

```js
app.use('/api', guard.writeGuard); // /api/auth と /api/me はこの前で処理済み
```

置き換える範囲の新しいコード:

```js
// ---- people ----
app.get('/api/people', (req, res) => {
  res.json(db.prepare(`SELECT p.*, EXISTS(SELECT 1 FROM users u WHERE u.person_id = p.id) AS claimed
    FROM people p ORDER BY p.id`).all());
});

// 人は登録時にだけ作る（POST はない）。変更は本人だけ。退会は POST /api/me/withdraw
// 画像を受け取る前に所有者を検査する（拒否した画像がディスクに残らないように）
app.put('/api/people/:id', (req, res, next) => (guard.mine(req, req.params.id) ? next() : guard.deny(res)),
  upload.single('icon'), (req, res) => {
    const p = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const name = (req.body.name || '').trim() || p.name;
    const color = COLOR_RE.test(req.body.color) ? req.body.color : p.color;
    // 古い画像は「元に戻す」で使うので消さない（使われなくなった画像は起動時に掃除する）
    let icon = p.icon_path;
    if (req.file) icon = '/uploads/' + req.file.filename;
    else if (req.body.removeIcon === '1') icon = null;
    db.prepare('UPDATE people SET name = ?, color = ?, icon_path = ? WHERE id = ?').run(name, color, icon, p.id);
    res.json({ ...db.prepare('SELECT * FROM people WHERE id = ?').get(p.id), before: p });
  });

// 「元に戻す」：自分の人の変更を元の値に戻す（削除済みの人は作り直さない）
app.post('/api/people/restore', (req, res) => {
  const { person } = req.body || {};
  const name = typeof person?.name === 'string' ? person.name.trim() : '';
  if (!Number.isInteger(person?.id) || !name || !COLOR_RE.test(person.color)) {
    return res.status(400).json({ error: '入力が不正です' });
  }
  if (!guard.mine(req, person.id)) return guard.deny(res);
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(person.id)) return res.status(404).json({ error: 'not found' });
  // 画像は残っているときだけ使う
  const file = person.icon_path && path.join(UPLOAD_DIR, path.basename(String(person.icon_path)));
  const icon = file && fs.existsSync(file) ? '/uploads/' + path.basename(file) : null;
  db.prepare('UPDATE people SET name = ?, color = ?, icon_path = ? WHERE id = ?').run(name, person.color, icon, person.id);
  res.json(db.prepare('SELECT * FROM people WHERE id = ?').get(person.id));
});

// ---- stays ----
// 「元に戻す」で消したもの・変えたものを同じ id で書き戻す
function restoreStays(items) {
  const upsert = db.prepare(`INSERT INTO stays (id, person_id, start, end, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET person_id = excluded.person_id, start = excluded.start, end = excluded.end, note = excluded.note`);
  for (const s of items) {
    if (!Number.isInteger(s?.id) || !validStay(s)) throw new Error('入力が不正です');
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(s.person_id)) throw new Error('人が存在しません');
    upsert.run(s.id, s.person_id, s.start, s.end, String(s.note || ''));
  }
}

function restoreMemos(items) {
  const upsert = db.prepare(`INSERT INTO memos (id, person_id, title, all_day, start, end) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET person_id = excluded.person_id, title = excluded.title,
      all_day = excluded.all_day, start = excluded.start, end = excluded.end`);
  for (const m of items) {
    const title = String(m?.title ?? '').trim();
    const allDay = m?.all_day ? 1 : 0;
    const personId = m?.person_id ?? null;
    if (!Number.isInteger(m?.id) || !title || title.length > 100 || !validMemoRange(allDay, m.start, m.end)) throw new Error('入力が不正です');
    if (!memoTargetOk(personId)) throw new Error('人が存在しません');
    upsert.run(m.id, personId, title, allDay, m.start, m.end);
  }
}

function validIds(ids) {
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 1000 && ids.every(Number.isInteger);
}

function validStay(b) {
  return b && Number.isInteger(Number(b.person_id)) && typeof b.start === 'string'
    && typeof b.end === 'string' && b.start < b.end;
}

app.get('/api/stays', (req, res) => {
  const { start, end } = req.query;
  const rows = start && end
    ? db.prepare('SELECT * FROM stays WHERE end > ? AND start < ? ORDER BY start').all(start, end)
    : db.prepare('SELECT * FROM stays ORDER BY start').all();
  res.json(rows);
});

app.post('/api/stays', (req, res) => {
  const b = req.body;
  if (!validStay(b)) return res.status(400).json({ error: '入力が不正です' });
  if (!guard.mine(req, b.person_id)) return guard.deny(res);
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(b.person_id)) return res.status(400).json({ error: '人が存在しません' });
  const r = db.prepare('INSERT INTO stays (person_id, start, end, note) VALUES (?, ?, ?, ?)')
    .run(b.person_id, b.start, b.end, b.note || '');
  res.status(201).json(db.prepare('SELECT * FROM stays WHERE id = ?').get(r.lastInsertRowid));
});

// 同じ時間で複数の日にまとめて追加
app.post('/api/stays/batch', (req, res) => {
  const { person_id, dates, startTime, endTime, note } = req.body || {};
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;
  if (!Array.isArray(dates) || !dates.length || dates.length > 100 || !dates.every((d) => DATE_RE.test(d))
    || !TIME_RE.test(startTime) || !TIME_RE.test(endTime) || startTime >= endTime) {
    return res.status(400).json({ error: '入力が不正です' });
  }
  if (!guard.mine(req, person_id)) return guard.deny(res);
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(person_id)) return res.status(400).json({ error: '人が存在しません' });
  const insert = db.prepare('INSERT INTO stays (person_id, start, end, note) VALUES (?, ?, ?, ?)');
  const ids = [];
  inTransaction(() => {
    for (const d of new Set(dates)) ids.push(Number(insert.run(person_id, `${d}T${startTime}:00`, `${d}T${endTime}:00`, note || '').lastInsertRowid));
  });
  res.status(201).json({ created: ids.length, ids });
});

// CSV取り込み：1人分の在室をまとめて登録（同じ人・開始・終了がすでにあれば飛ばす）
app.post('/api/stays/import', (req, res) => {
  const { person_id, items } = req.body || {};
  const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  if (!Array.isArray(items) || !items.length || items.length > 1000
    || !items.every((it) => it && STAMP_RE.test(it.start) && STAMP_RE.test(it.end) && it.start < it.end
      && it.start.slice(0, 10) === it.end.slice(0, 10))) {
    return res.status(400).json({ error: '入力が不正です' });
  }
  if (!guard.mine(req, person_id)) return guard.deny(res);
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(person_id)) return res.status(400).json({ error: '人が存在しません' });
  const exists = db.prepare('SELECT 1 FROM stays WHERE person_id = ? AND start = ? AND end = ?');
  const insert = db.prepare('INSERT INTO stays (person_id, start, end, note) VALUES (?, ?, ?, ?)');
  const ids = [];
  let skipped = 0;
  inTransaction(() => {
    for (const it of items) {
      if (exists.get(person_id, it.start, it.end)) { skipped++; continue; }
      ids.push(Number(insert.run(person_id, it.start, it.end, String(it.note || '').slice(0, 100)).lastInsertRowid));
    }
  });
  res.status(201).json({ created: ids.length, ids, skipped });
});

app.put('/api/stays/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM stays WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (!guard.mine(req, s.person_id)) return guard.deny(res);
  const b = { ...s, ...req.body };
  if (!validStay(b)) return res.status(400).json({ error: '入力が不正です' });
  if (!guard.mine(req, b.person_id)) return guard.deny(res); // 他人への付け替えは不可
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(b.person_id)) return res.status(400).json({ error: '人が存在しません' });
  db.prepare('UPDATE stays SET person_id = ?, start = ?, end = ?, note = ? WHERE id = ?')
    .run(b.person_id, b.start, b.end, b.note || '', s.id);
  res.json({ ...db.prepare('SELECT * FROM stays WHERE id = ?').get(s.id), before: s });
});

// 消したものを返す（「元に戻す」用）
app.delete('/api/stays/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM stays WHERE id = ?').get(req.params.id);
  if (!s) return res.status(204).end();
  if (!guard.mine(req, s.person_id)) return guard.deny(res);
  db.prepare('DELETE FROM stays WHERE id = ?').run(s.id);
  res.json(s);
});

app.post('/api/stays/remove', (req, res) => {
  const { ids } = req.body || {};
  if (!validIds(ids)) return res.status(400).json({ error: '入力が不正です' });
  if (!guard.staysAllMine(req, ids)) return guard.deny(res); // 他人のものが 1件でもあれば何も消さない
  const del = db.prepare('DELETE FROM stays WHERE id = ?');
  inTransaction(() => ids.forEach((id) => del.run(id)));
  res.status(204).end();
});

app.post('/api/stays/restore', (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 1000) return res.status(400).json({ error: '入力が不正です' });
  // 書き戻す先が自分の人で、同じ id の既存の行も自分のものであること
  if (!items.every((it) => guard.mine(req, it?.person_id)) || !guard.staysAllMine(req, items.map((it) => it?.id))) {
    return guard.deny(res);
  }
  inTransaction(() => restoreStays(items));
  res.status(204).end();
});

// ---- memos ----
// 終日は YYYY-MM-DD（end は翌日・排他的）、時間指定は YYYY-MM-DDTHH:MM:SS
const MEMO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEMO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function validMemoRange(allDay, start, end) {
  const re = allDay ? MEMO_DATE_RE : MEMO_DATETIME_RE;
  return re.test(start) && re.test(end) && start < end;
}

function memoTargetOk(personId) {
  return personId === null || !!db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId);
}

app.get('/api/memos', (req, res) => {
  const { start, end } = req.query;
  const rows = start && end
    ? db.prepare('SELECT * FROM memos WHERE end > ? AND start < ? ORDER BY start').all(start, end)
    : db.prepare('SELECT * FROM memos ORDER BY start').all();
  res.json(rows);
});

app.post('/api/memos/batch', (req, res) => {
  const { items } = req.body || {};
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const personId = req.body?.person_id ?? null;
  const allDay = req.body?.all_day ? 1 : 0;
  if (!title || title.length > 100) return res.status(400).json({ error: '内容を入力してください（100字まで）' });
  if (!Array.isArray(items) || !items.length || items.length > 100
    || !items.every((it) => it && validMemoRange(allDay, it.start, it.end))) {
    return res.status(400).json({ error: '入力が不正です' });
  }
  if (!guard.memoOk(req, personId)) return guard.deny(res);
  if (!memoTargetOk(personId)) return res.status(400).json({ error: '人が存在しません' });
  const insert = db.prepare('INSERT INTO memos (person_id, title, all_day, start, end) VALUES (?, ?, ?, ?, ?)');
  const ids = [];
  inTransaction(() => {
    for (const it of items) ids.push(Number(insert.run(personId, title, allDay, it.start, it.end).lastInsertRowid));
  });
  res.status(201).json({ created: ids.length, ids });
});

app.put('/api/memos/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM memos WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (!guard.memoOk(req, m.person_id)) return guard.deny(res);
  const b = { ...m, ...req.body };
  const title = String(b.title ?? '').trim();
  const allDay = b.all_day ? 1 : 0;
  const personId = b.person_id ?? null;
  if (!title || title.length > 100) return res.status(400).json({ error: '内容を入力してください（100字まで）' });
  if (!validMemoRange(allDay, b.start, b.end)) return res.status(400).json({ error: '入力が不正です' });
  if (!guard.memoOk(req, personId)) return guard.deny(res); // 他人の人への付け替えは不可
  if (!memoTargetOk(personId)) return res.status(400).json({ error: '人が存在しません' });
  db.prepare('UPDATE memos SET person_id = ?, title = ?, all_day = ?, start = ?, end = ? WHERE id = ?')
    .run(personId, title, allDay, b.start, b.end, m.id);
  res.json({ ...db.prepare('SELECT * FROM memos WHERE id = ?').get(m.id), before: m });
});

app.delete('/api/memos/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM memos WHERE id = ?').get(req.params.id);
  if (!m) return res.status(204).end();
  if (!guard.memoOk(req, m.person_id)) return guard.deny(res);
  db.prepare('DELETE FROM memos WHERE id = ?').run(m.id);
  res.json(m);
});

app.post('/api/memos/remove', (req, res) => {
  const { ids } = req.body || {};
  if (!validIds(ids)) return res.status(400).json({ error: '入力が不正です' });
  if (!guard.memosAllOk(req, ids)) return guard.deny(res);
  const del = db.prepare('DELETE FROM memos WHERE id = ?');
  inTransaction(() => ids.forEach((id) => del.run(id)));
  res.status(204).end();
});

app.post('/api/memos/restore', (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 1000) return res.status(400).json({ error: '入力が不正です' });
  if (!items.every((it) => guard.memoOk(req, it?.person_id ?? null)) || !guard.memosAllOk(req, items.map((it) => it?.id))) {
    return guard.deny(res);
  }
  inTransaction(() => restoreMemos(items));
  res.status(204).end();
});
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test`
Expected: すべて pass。`grep -n "inTransaction\|COLOR_RE\|crypto" server.js | head` で、使われなくなった `require` が残っていないかも見る（`crypto` は合言葉とアイコン縮小で使っている）。

- [ ] **Step 6: Commit**

```bash
git add lib/guard.js server.js test/permissions.test.js
git commit -m "未ログインの書き込みを拒否し、自分の予定・メモだけ編集できるようにする" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: アカウント画面（`/account`, `/reset`）

**Files:**
- Create: `public/account.html`, `public/account.js`, `test/pages.test.js`
- Modify: `server.js`（ページの配信）、`public/style.css`

**Interfaces:**
- Consumes: Task 3, 4 の `/api/auth/*`、`/api/me`、Task 5 の `GET /api/people`（`claimed`）
- Produces: `GET /account`, `GET /reset`（どちらも `account.html`。合言葉の後ろ）

- [ ] **Step 1: 失敗するテストを書く**

`test/pages.test.js`:

```js
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/pages.test.js`
Expected: FAIL（`/account` が 404）。

- [ ] **Step 3: `public/account.html` を書く**

```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ログイン | 在室カレンダー</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="account-page">
  <main class="account-card">
    <h1>在室カレンダー</h1>

    <form id="view-login" hidden>
      <h2>ログイン</h2>
      <label>メールアドレス<input type="email" name="email" required autocomplete="username"></label>
      <label>パスワード<input type="password" name="password" required autocomplete="current-password"></label>
      <p class="error" data-error></p>
      <button type="submit" class="btn primary wide">ログイン</button>
      <p class="account-links">
        <button type="button" class="btn link" data-go="forgot">パスワードを忘れた</button>
        <button type="button" class="btn link" data-go="signup">新規登録</button>
      </p>
      <p class="account-links"><a href="/">ログインせずに見る（閲覧のみ）</a></p>
    </form>

    <form id="view-signup" hidden>
      <h2>新規登録</h2>
      <label>メールアドレス<input type="email" name="email" required autocomplete="username"></label>
      <label>パスワード（8文字以上）<input type="password" name="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
      <label>パスワード（確認）<input type="password" name="password2" required minlength="8" maxlength="128" autocomplete="new-password"></label>
      <fieldset>
        <legend>あなたの人</legend>
        <label class="check"><input type="radio" name="mode" value="new" checked> 新しく作る</label>
        <div id="newPerson">
          <label>名前<input type="text" name="new_name" maxlength="20"></label>
          <label>色<input type="color" name="new_color" value="#4f7cff"></label>
        </div>
        <label class="check" id="existingLabel"><input type="radio" name="mode" value="existing"> すでにある人を選ぶ</label>
        <select name="person_id" id="existingSelect" disabled></select>
        <p class="hint" id="existingHint">まだ誰も使っていない人だけ選べます。選ぶと、今ある予定とメモを引き継げます</p>
      </fieldset>
      <p class="error" data-error></p>
      <button type="submit" class="btn primary wide">確認メールを送る</button>
      <p class="account-links"><button type="button" class="btn link" data-go="login">ログインに戻る</button></p>
    </form>

    <form id="view-code" hidden>
      <h2>確認コード</h2>
      <p class="hint" id="codeSent"></p>
      <label>6桁のコード<input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"></label>
      <p class="error" data-error></p>
      <button type="submit" class="btn primary wide">登録する</button>
      <p class="account-links">
        <button type="button" class="btn link" id="resendBtn">コードを再送する</button>
        <button type="button" class="btn link" data-go="signup">入力し直す</button>
      </p>
    </form>

    <form id="view-forgot" hidden>
      <h2>パスワードの再設定</h2>
      <p class="hint">登録したメールアドレスに、再設定用のリンクを送ります。</p>
      <label>メールアドレス<input type="email" name="email" required autocomplete="username"></label>
      <p class="error" data-error></p>
      <button type="submit" class="btn primary wide">リンクを送る</button>
      <p class="account-links"><button type="button" class="btn link" data-go="login">ログインに戻る</button></p>
    </form>

    <section id="view-forgotDone" hidden>
      <h2>メールを送りました</h2>
      <p class="hint">登録されているメールアドレスなら、再設定用のリンクが届きます（1時間有効・1回だけ使えます）。届かないときは、迷惑メールのフォルダも見てください。</p>
      <p class="account-links"><button type="button" class="btn link" data-go="login">ログインに戻る</button></p>
    </section>

    <form id="view-reset" hidden>
      <h2>新しいパスワード</h2>
      <label>パスワード（8文字以上）<input type="password" name="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
      <label>パスワード（確認）<input type="password" name="password2" required minlength="8" maxlength="128" autocomplete="new-password"></label>
      <p class="error" data-error></p>
      <button type="submit" class="btn primary wide">パスワードを変更する</button>
    </form>

    <section id="view-resetDone" hidden>
      <h2>パスワードを変更しました</h2>
      <p class="hint">すべての端末からログアウトしました。新しいパスワードでログインしてください。</p>
      <p class="account-links"><button type="button" class="btn link" data-go="login">ログインへ</button></p>
    </section>
  </main>
  <script src="/account.js"></script>
</body>
</html>
```

- [ ] **Step 4: `public/account.js` を書く**

```js
(() => {
  const $ = (s) => document.querySelector(s);
  const views = [...document.querySelectorAll('[id^="view-"]')];
  let pendingEmail = '';
  let resendTimer;

  function show(name) {
    for (const v of views) v.hidden = v.id !== 'view-' + name;
    const cur = $('#view-' + name);
    cur.querySelectorAll('[data-error]').forEach((e) => { e.textContent = ''; });
    cur.querySelector('input:not([type=radio]):not([type=color]):not(:disabled)')?.focus();
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !data.needLogin) { location.href = '/login'; throw new Error('合言葉を入力してください'); }
    if (!res.ok) throw new Error(data.error || '失敗しました');
    return data;
  }

  // フォームの送信を、エラー表示・二重送信の防止つきで扱う
  function onSubmit(id, handler) {
    const form = $('#view-' + id);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      form.querySelector('[data-error]').textContent = '';
      btn.disabled = true;
      try {
        await handler(form);
      } catch (err) {
        form.querySelector('[data-error]').textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (go) show(go);
  });

  function startCountdown(sec = 60) {
    const btn = $('#resendBtn');
    let left = sec;
    clearInterval(resendTimer);
    const tick = () => {
      btn.disabled = left > 0;
      btn.textContent = left > 0 ? `コードを再送する（${left}秒後）` : 'コードを再送する';
      if (left <= 0) clearInterval(resendTimer);
      left--;
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  // ログイン
  onSubmit('login', async (f) => {
    await post('/api/auth/login', { email: f.email.value, password: f.password.value });
    location.href = '/';
  });

  // 新規登録：未紐付けの人を選べるようにする
  async function loadExisting() {
    const people = await fetch('/api/people').then((r) => r.json()).catch(() => []);
    const free = people.filter((p) => !p.claimed);
    const sel = $('#existingSelect');
    sel.replaceChildren(...free.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.name })));
    const none = free.length === 0;
    $('#existingLabel').hidden = none;
    sel.hidden = none;
    $('#existingHint').hidden = none;
  }

  function syncPersonMode() {
    const f = $('#view-signup');
    const existing = f.mode.value === 'existing';
    f.new_name.disabled = existing;
    f.new_name.required = !existing;
    f.new_color.disabled = existing;
    $('#existingSelect').disabled = !existing;
  }
  $('#view-signup').addEventListener('change', (e) => { if (e.target.name === 'mode') syncPersonMode(); });

  onSubmit('signup', async (f) => {
    if (f.password.value !== f.password2.value) throw new Error('パスワードが一致しません');
    const body = { email: f.email.value, password: f.password.value };
    if (f.mode.value === 'existing') body.person_id = Number(f.person_id.value);
    else { body.new_name = f.new_name.value; body.new_color = f.new_color.value; }
    await post('/api/auth/signup', body);
    pendingEmail = f.email.value;
    $('#codeSent').textContent = `${pendingEmail.trim()} に6桁のコードを送りました（10分間有効）。`;
    $('#view-code').code.value = '';
    show('code');
    startCountdown();
  });

  // コード確認
  onSubmit('code', async (f) => {
    await post('/api/auth/verify', { email: pendingEmail, code: f.code.value });
    location.href = '/';
  });
  $('#resendBtn').addEventListener('click', async () => {
    try {
      await post('/api/auth/resend', { email: pendingEmail });
      $('#view-code [data-error]').textContent = '';
      startCountdown();
    } catch (err) {
      $('#view-code [data-error]').textContent = err.message;
    }
  });

  // パスワードの再設定
  onSubmit('forgot', async (f) => {
    await post('/api/auth/forgot', { email: f.email.value });
    show('forgotDone');
  });
  onSubmit('reset', async (f) => {
    if (f.password.value !== f.password2.value) throw new Error('パスワードが一致しません');
    const token = new URLSearchParams(location.search).get('token') || '';
    await post('/api/auth/reset', { token, password: f.password.value });
    show('resetDone');
  });

  (async () => {
    const isReset = location.pathname === '/reset';
    const token = new URLSearchParams(location.search).get('token');
    if (!isReset) {
      const me = await fetch('/api/me').then((r) => r.json()).catch(() => null);
      if (me?.user) { location.href = '/'; return; }
    }
    await loadExisting();
    syncPersonMode();
    show(isReset && token ? 'reset' : 'login');
  })();
})();
```

- [ ] **Step 5: `server.js` にページを足す**

`const pageLogin = sendPage('login.html');` の下に次を足す。

```js
const pageAccount = sendPage('account.html');
```

`app.use('/api/me', meRouter);` の下に次を足す。

```js
app.get(['/account', '/reset'], pageAccount);
```

- [ ] **Step 6: `public/style.css` に足す**

既存の `dialog input[type=text], dialog input[type=date], dialog input[type=time] {` の並びに `dialog input[type=password],` を足す（退会ダイアログ用）。具体的には、次のセレクタ行を

```css
dialog input[type=text], dialog input[type=date], dialog input[type=time] {
```

次に変える。

```css
dialog input[type=text], dialog input[type=password], dialog input[type=date], dialog input[type=time] {
```

ファイルの末尾に次を足す。

```css
/* アカウント画面（ログイン・登録・パスワード再設定） */
body.account-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.account-card { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
.account-card h1 { font-size: 20px; margin: 0 0 12px; }
.account-card h2 { font-size: 16px; margin: 0 0 12px; }
.account-card label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
.account-card input:not([type=radio]):not([type=color]), .account-card select {
  display: block; width: 100%; margin-top: 4px; padding: 10px 12px; font-size: 16px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text);
}
.account-card input[type=color] { display: block; margin-top: 4px; width: 60px; height: 34px; border: none; padding: 0; }
.account-card input:focus, .account-card select:focus { outline: 2px solid var(--primary); outline-offset: -1px; border-color: var(--primary); }
.account-card label.check { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 14px; }
.account-card fieldset { border: 1px solid var(--border); border-radius: 8px; margin: 14px 0 0; padding: 4px 12px 12px; }
.account-card legend { font-size: 13px; color: var(--muted); padding: 0 4px; }
.account-card .btn.wide { width: 100%; margin-top: 16px; padding: 10px; font-size: 16px; font-weight: 600; }
.account-card .btn:disabled { opacity: .5; cursor: default; }
.account-links { display: flex; justify-content: space-between; margin: 12px 0 0; font-size: 13px; }
.account-links a { color: var(--muted); }
```

- [ ] **Step 7: テストと構文チェック**

Run: `npm test && node --check public/account.js`
Expected: すべて pass。`node --check` は何も出力しない。

- [ ] **Step 8: 手動で画面を確かめる**

一時の DATA_DIR で起動する（本番の `data/` は触らない）。

```bash
DATA_DIR=$(mktemp -d) ENV_FILE=/nonexistent PORT=3111 npm start
```

別のターミナルかブラウザで `http://localhost:3111/account` を開き、次を確かめる。

1. ログイン画面が出る。「新規登録」で登録画面に切り替わる。
2. 新規登録 → サーバーのコンソールに出た6桁コードを入力 → カレンダー（`/`）に移る。
3. もう一度 `/account` を開くと、すぐ `/` に戻る（ログイン済み）。
4. 「パスワードを忘れた」→ メール入力 → コンソールのリセット URL を開く → 新しい PW を入力 → 「変更しました」が出る。

確認できたらサーバーを止める（`Ctrl+C`）。

- [ ] **Step 9: Commit**

```bash
git add public/account.html public/account.js public/style.css server.js test/pages.test.js
git commit -m "ログイン・新規登録・コード入力・PW 再設定の画面を追加" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: カレンダー画面の変更（`index.html`, `app.js`）

**Files:**
- Modify: `public/index.html`, `public/app.js`
- Test: 手動確認（このリポジトリにブラウザのテスト基盤はない）と `node --check`

**Interfaces:**
- Consumes: `GET /api/me`、`POST /api/auth/logout`、`POST /api/me/withdraw`、`needLogin` つきの `401`、`403`
- Produces: 画面の挙動（ログイン前は閲覧のみ、ログイン後は自分の分だけ編集できる）

> 行番号は変更前のものなので、編集するたびにずれる。関数名と文字列で場所を探すこと。

- [ ] **Step 1: `public/index.html` を変更する**

1. `<div class="top-actions">` の直後（`lockBtn` の前）に、ログインボタンを足す。

```html
      <button id="loginBtn" class="top-btn primary" type="button" hidden>ログイン</button>
```

2. `#actionMenu` の中の「人を追加」ボタン（`id="addPersonBtn"` の `<button>` 全体）を、次のログアウトボタンに置き換える。

```html
      <button id="logoutBtn" class="top-btn ghost" type="button" hidden title="ログアウト" aria-label="ログアウト"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg><span class="menu-label">ログアウト</span></button>
```

3. `<dialog id="kbPersonDialog">` から、それを閉じる `</dialog>` までを丸ごと削除する（「だれで操作しますか？」のダイアログ）。
4. キー一覧の表から、`<kbd>p</kbd>` の行（「操作する人を変える」）を削除する。
5. `viewDialog` の `<p class="hint">編集するにはロックを解除してください</p>` を、`id` つきに変える。

```html
      <p class="hint" id="viewHint"></p>
```

6. 人ダイアログ（`<dialog id="personDialog">`）の見出しを固定にし、「削除」ボタンを「退会」にする。

```html
      <h2 id="personTitle">人を編集</h2>
```

```html
        <button type="button" id="personDelete" class="btn danger">退会</button>
```

7. `</dialog>`（人ダイアログの閉じ）の直後に、退会ダイアログを足す。

```html
  <!-- 退会：自分の人・在室・メモ・アカウントをすべて消す -->
  <dialog id="withdrawDialog">
    <form id="withdrawForm" method="dialog">
      <h2>退会する</h2>
      <p class="hint">アカウントと、あなたの在室・メモがすべて消えます。元に戻せません。</p>
      <label>パスワード<input type="password" name="password" required autocomplete="current-password"></label>
      <p class="error" id="withdrawError"></p>
      <div class="actions">
        <span class="spacer"></span>
        <button type="button" class="btn" data-close>キャンセル</button>
        <button type="submit" class="btn danger">退会する</button>
      </div>
    </form>
  </dialog>
```

- [ ] **Step 2: `public/app.js` — 状態と `api()`**

1. `let people = [];` の下に足す。

```js
let me = null; // ログイン中のユーザー { id, email, person_id }。未ログインは null
const isMe = (personId) => !!me && personId != null && personId === me.person_id;
const myPeople = () => people.filter((p) => isMe(p.id));
const canEditStay = (st) => isMe(st.person_id);
const canEditMemo = (m) => !!me && (m.person_id === null || isMe(m.person_id)); // 部屋のメモは誰でも
```

2. `api()` の中の次の行を

```js
  if (res.status === 401) { location.href = '/login'; throw new Error('ログインしてください'); }
```

次に置き換える（書き込みガードの 401 は合言葉の画面に飛ばさない）。

```js
  if (res.status === 401 && !(await res.clone().json().catch(() => ({}))).needLogin) {
    location.href = '/login';
    throw new Error('ログインしてください');
  }
```

3. `api()` の定義の直後に足す。

```js
async function loadMe() {
  me = (await api('GET', '/api/me')).user;
  $('#loginBtn').hidden = !!me;
  $('#logoutBtn').hidden = !me;
  $('#logoutBtn').title = me ? `ログアウト（${me.email}）` : 'ログアウト';
  if (!me && !locked) setLocked(true); // ログアウトされていたらロックに戻す
}

$('#loginBtn').addEventListener('click', () => { location.href = '/account'; });
$('#logoutBtn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  location.reload();
});
```

- [ ] **Step 3: `public/app.js` — ロック**

1. `requireUnlocked()` の先頭に未ログインの検査を足す。

```js
function requireUnlocked() {
  if (!me) { showToast('ログインすると編集できます', false); return false; }
  if (!locked) return true;
  showToast('ロック中です。鍵のボタンを押すと編集できます', false);
  return false;
}
```

2. `setLocked()` の中の `$('#addPersonBtn').disabled = v;` の行を削除する。
3. `#lockBtn` のクリック処理を次に置き換える。

```js
$('#lockBtn').addEventListener('click', () => {
  if (!me) {
    if (confirm('ログインすると編集できます。ログイン画面を開きますか？')) location.href = '/account';
    return;
  }
  setLocked(!locked);
  showToast(locked ? 'ロックしました' : 'ロックを解除しました（5分操作がないと自動でロックします）', false);
});
```

- [ ] **Step 4: `public/app.js` — キーボードモード（人の選択を廃止）**

1. `enterKb()` の先頭 1 行

```js
  if (!people.length) { showToast('先に「人を追加」で人を登録してください', false); return; }
```

を次に置き換える。

```js
  if (!me) { showToast('ログインしてください', false); return; }
```

2. `enterKb()` の中の次の 2 箇所を直す。

```js
  kb.person = people.length === 1 ? people[0].id : null; // 1人のときは選ぶ必要がない
```
→
```js
  kb.person = me.person_id; // 操作する人は自分に固定
```

```js
  if (!kb.person) openKbPerson();
```
→ この行を削除する。

3. `exitKb()` の中の `if ($('#kbPersonDialog').open) $('#kbPersonDialog').close();` を削除する。
4. `function openKbPerson() { ... }` と、そのすぐ下の `$('#kbPersonDialog').addEventListener('keydown', ...)`、`$('#kbPersonDialog').addEventListener('close', ...)` の 3 つを削除する。
5. キー処理の `case 'p': e.preventDefault(); openKbPerson(); break;` の行を削除する。
6. `renderKbBadge()` の `'（人を選択中）'` を `''` に変える。
7. `kbEdit` と `kbDelete` に、他人の予定への操作を止める検査を足す。

```js
function kbEdit(ev) {
  const { kind, stay, memo } = ev.extendedProps;
  if (!(kind === 'memo' ? canEditMemo(memo) : canEditStay(stay))) { openViewDialog(kind, stay || memo, false); return; }
  if (kind === 'memo') openMemoDialog(memo);
  else openStayDialog(stay, new Date(stay.start), new Date(stay.end));
}

async function kbDelete(ev) {
  const { kind, stay, memo } = ev.extendedProps;
  if (!(kind === 'memo' ? canEditMemo(memo) : canEditStay(stay))) { showToast('他の人の予定は変更できません', false); return; }
  if (await (kind === 'memo' ? deleteMemo(memo) : deleteStay(stay))) kb.focus = null;
}
```

- [ ] **Step 5: `public/app.js` — 他人の予定は閲覧のみ**

1. `openViewDialog(kind, item)` の定義を `openViewDialog(kind, item, canEdit = false)` に変え、`$('#viewDialog').showModal();` の直前に足す。

```js
  $('#viewHint').textContent = !me ? 'ログインすると、自分の予定を編集できます'
    : canEdit ? '編集するにはロックを解除してください' : '他の人の予定は変更できません';
```

2. `initCalendar()` の在室のイベント生成（`extendedProps: { kind: 'stay', stay: st },` を含む `return { ... }`）に、他人のものはドラッグ・リサイズ不可にする指定を足す。

```js
            return {
              id: 's' + st.id, start: st.start, end: st.end,
              backgroundColor: p.color, borderColor: p.color,
              ...(canEditStay(st) ? {} : { editable: false }), // 他人の予定は動かせない（自分のものは全体の editable に従う）
              extendedProps: { kind: 'stay', stay: st },
            };
```

3. メモのイベント生成（`classNames: ['memo-event'],` を含む `return { ... }`）にも足す。

```js
              classNames: ['memo-event'],
              ...(canEditMemo(m) ? {} : { editable: false }),
              extendedProps: { kind: 'memo', memo: m },
```

4. `eventClick` を次に置き換える。

```js
    eventClick: (info) => {
      const { kind, stay, memo } = info.event.extendedProps;
      const canEdit = kind === 'memo' ? canEditMemo(memo) : canEditStay(stay);
      if (locked || !canEdit) return openViewDialog(kind, stay || memo, canEdit); // ロック中・他人のものは内容を見るだけ
      if (kind === 'memo') return openMemoDialog(memo);
      openStayDialog(stay, new Date(stay.start), new Date(stay.end));
    },
```

- [ ] **Step 6: `public/app.js` — 人の固定**

1. `renderPeople()` の編集ボタン（`const edit = document.createElement('button');` から `chip.append(edit);` まで）を、自分の人のときだけ作るようにする。

```js
    if (isMe(p.id)) {
      const edit = document.createElement('button');
      edit.className = 'edit';
      edit.append(icon('pencil'));
      edit.title = '編集';
      edit.onclick = (e) => { e.stopPropagation(); if (requireUnlocked()) openPersonDialog(p); };
      chip.append(edit);
    }
```

2. 3 つの人の選択（`renderPicker`, `renderMemoPicker`, `renderImportPicker`）が `people` を回している箇所を探す。

Run: `grep -n "of people\|people.forEach\|people.map" public/app.js`
Expected: 上の 3 関数のほか、`renderPeople`, CSV 出力（`openExportDialog`）が出る。

`renderPicker`, `renderMemoPicker`, `renderImportPicker` の 3 つだけ、回す元を `people` から `myPeople()` に変える。`renderPeople`（上部のチップ）と `openExportDialog`（CSV 出力の人の一覧）は全員のままにする。

3. `openStayDialog()` の先頭の次のブロック

```js
  if (!people.length) {
    alert('先に「＋ 人を追加」で人を登録してください');
    return;
  }
```

を次に置き換える。

```js
  if (!me) return;
```

そして `pickedPerson = ...` の行を次に置き換える。

```js
  pickedPerson = me.person_id; // 在室は自分の分だけ
```

4. `openImportDialog()` の `importPerson = people.length === 1 ? people[0].id : null;` を次に置き換える。

```js
  importPerson = me ? me.person_id : null;
```

5. `openMemoDialog()` の新規の分岐 `memoTarget = (kb.on && kb.person) || ROOM;` は、そのままでよい（`kb.person` は自分）。

- [ ] **Step 7: `public/app.js` — 人ダイアログと退会**

1. `openPersonDialog(person)` を、編集専用に簡単にする。

```js
function openPersonDialog(person) {
  editingPerson = person;
  removeIcon = false;
  resetPreviewUrl();
  const f = $('#personForm');
  f.reset();
  f.name.value = person.name;
  f.color.value = person.color;
  $('#personError').textContent = '';
  updatePreview();
  $('#personDialog').showModal();
}
```

2. 人フォームの `submit` ハンドラの `try { ... }` の中を、編集だけにする。

```js
  try {
    const r = await api('PUT', `/api/people/${editingPerson.id}`, fd);
    pushUndo(`${r.before.name}を変更しました`, () => api('POST', '/api/people/restore', { person: r.before }));
    $('#personDialog').close();
    await loadPeople();
    calendar.refetchEvents();
  } catch (err) {
    $('#personError').textContent = err.message;
  }
```

3. `$('#personDelete').addEventListener('click', ...)` のブロックと、`$('#addPersonBtn').addEventListener(...)` の 1 行を、次に置き換える。

```js
// 退会：パスワードを確かめてから、人・在室・メモ・アカウントをすべて消す（元に戻せない）
$('#personDelete').addEventListener('click', () => {
  if (!editingPerson || !isMe(editingPerson.id)) return;
  $('#withdrawForm').reset();
  $('#withdrawError').textContent = '';
  $('#personDialog').close();
  $('#withdrawDialog').showModal();
});
$('#withdrawForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/me/withdraw', { password: e.target.password.value });
    location.reload();
  } catch (err) {
    $('#withdrawError').textContent = err.message;
  }
});
```

- [ ] **Step 8: `public/app.js` — 起動**

1. ファイル末尾の起動ブロックを次にする。

```js
(async () => {
  initCalendar();
  setLocked(true);
  await loadMe();
  await loadPeople();
  calendar.refetchEvents();
})();
```

2. 「他の人の変更を拾うため、タブに戻ったときに再読込」の `visibilitychange` ハンドラの、`await loadPeople();` の前に `await loadMe();` を足す。

- [ ] **Step 9: 構文とテスト**

Run: `node --check public/app.js && npm test`
Expected: エラーなし、すべて pass。

Run: `grep -n "addPersonBtn\|kbPersonDialog\|openKbPerson" public/app.js public/index.html`
Expected: 出力なし。

- [ ] **Step 10: 手動で確かめる**

一時の DATA_DIR で、既存の人を 1 人入れて起動する。

```bash
D=$(mktemp -d)
DATA_DIR=$D ENV_FILE=/nonexistent PORT=3111 npm start &
sleep 1
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/app.db');d.exec(\"INSERT INTO people(name,color) VALUES('既存さん','#e5484d')\");d.exec(\"INSERT INTO stays(person_id,start,end,note) VALUES(1,'2030-01-07T09:00:00','2030-01-07T18:00:00','')\")" $D
```

ブラウザで `http://localhost:3111` を開き、次を確かめる。

1. **未ログイン**: ヘッダーに「ログイン」が出る。鍵を押すと確認が出る。予定を押すと内容が見られ、「ログインすると、自分の予定を編集できます」と出る。`i` を押すと「ログインしてください」と出る。
2. **登録**: 「ログイン」→ 新規登録 →「すでにある人を選ぶ」で「既存さん」を選ぶ → コンソールのコードを入力 → カレンダーに戻る。ロックされた状態で始まり、「既存さん」のチップに鉛筆が出る。
3. **編集**: 鍵を押して解除。2030年1月7日の予定を開くと編集でき、ドラッグできる。新しい在室を追加すると「だれ」は自分だけ。
4. **他人の予定**: 別のブラウザ（またはシークレット）で別のメールを登録（新しい人）。1 で作った人の予定は、ロック解除中でも内容を見るだけで、ドラッグできない。部屋のメモは、どちらからも編集できる。
5. **キーボードモード**: `i` で入ると人の選択が出ずに始まる。`Tab` で他人の予定を選んで `e` を押すと、閲覧ダイアログが出る。`x` を押すと「他の人の予定は変更できません」と出る。
6. **退会**: 自分の人の鉛筆 →「退会」→ 違う PW でエラー → 正しい PW でページが再読み込みされ、未ログインに戻る。人と予定が消えている。
7. **ログアウト**: 「…」メニュー（スマホ幅）または右上のアイコンでログアウトできる。

確認できたらサーバーを止める。

```bash
kill %1
rm -rf "$D"
```

- [ ] **Step 11: Commit**

```bash
git add public/index.html public/app.js
git commit -m "カレンダー画面: ログイン状態に応じて編集を制限し、退会とログアウトを追加" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: ドキュメントと最終確認

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-11-06-user-accounts-design.md`

- [ ] **Step 1: スペックに実装で決めた 1 点を足す**

スペックの「権限（サーバーで強制）」の最初の段落の、`未ログインは `401 {"error":"ログインしてください"}` を返す。` を次に変える。

```
未ログインは `401 {"error":"ログインしてください","needLogin":true}` を返す。`needLogin` は、合言葉の `401` と見分けるための印で、画面は `needLogin` がない `401` のときだけ合言葉の画面へ移す。
```

- [ ] **Step 2: README を更新する**

1. 「主な機能」の「ロック」の項の前に、次を足す。

```markdown
- アカウント: メールアドレスとパスワードでログインします。ログインすると、自分の予定とメモだけ編集できます（他の人のものは見るだけ）。部屋のメモは、ログインしていれば誰でも編集できます
  - 登録: メールに届く6桁のコードを入力して完了します。登録のとき、まだ誰も使っていない既存の人を選んで予定とメモを引き継ぐか、新しい人を作ります
  - パスワードを忘れたとき: メールに届く1回限りのリンクから、新しいパスワードを設定できます（設定すると全端末からログアウトされます）
  - 退会: 自分の人の編集画面から。人・予定・メモ・アカウントがすべて消え、元に戻せません
  - ログインしていなくても、合言葉を通れば閲覧できます（編集はできません）
```

2. 「ロック」の項の 1 行目を次に変える。

```markdown
- ロック: 間違って変更しないよう、ページを開いたときは必ずロックされています。ログインしているときだけ、ヘッダーの鍵ボタンで編集できます（操作がない状態が5分続くと自動でロックに戻ります）
```

3. 「キーボードモード」の項の「`i` を押すと〜操作する人を選びます」を、次のように直す。`p` のくだりを消す。

```markdown
- キーボードモード: ログイン中に `i` を押すと、キーボードだけで操作できるモードに入ります（ロックを解除し、月表示にします。操作する人は自分です）。`Esc` で終了すると、ロックに戻ります
```

「`p` で操作する人を変える、`?` でキー一覧」は「`?` でキー一覧」にする。

4. 「使い方」の手順 1 を次に変える。

```markdown
1. 右上の「ログイン」から新規登録します。メールに届く6桁のコードを入力すると、ログインした状態になります。まだ誰も使っていない既存の人があれば選べます。新しく作る場合は、名前と色を決めます（画像は、登録後に自分の人の鉛筆から設定します）。
```

5. 「設定（環境変数）」の表に行を足す。

```markdown
| `ENV_FILE` | `./.env` | 読み込む `.env` ファイル。起動時に自動で読みます（なければ何もしません。すでに設定した環境変数は上書きしません） |
| `SMTP_HOST` | （なし） | メール送信用の SMTP サーバー。未設定のときはメールを送らず、確認コードとリセット URL をサーバーのコンソールに出します |
| `SMTP_PORT` | `587` | SMTP のポート |
| `SMTP_SECURE` | `false` | `true` にすると TLS で接続します（ポート 465 のとき） |
| `SMTP_USER` / `SMTP_PASS` | （なし） | SMTP の認証情報 |
| `MAIL_FROM` | `SMTP_USER` | 送信元。例: `在室カレンダー <noreply@example.com>` |
```

`PUBLIC_URL` の説明を次に変える。

```markdown
| `PUBLIC_URL` | （自動） | 公開URL（例: `https://room.example.com`）。パスワード再設定のメールに入る URL と、共有時の画像の URL の元になります。HTTPS のプロキシの後ろでは必ず設定してください（未設定だと、URL がアクセス先の `Host` ヘッダーから作られます） |
```

「例:」の下に `.env` の説明を足す。

```markdown
`.env.example` を `.env` にコピーして書き換えると、起動のたびに環境変数を指定しなくて済みます（`.env` は Git に入りません）。
```

6. 「合言葉」の節に足す。

```markdown
- 合言葉は「閲覧用」です。アカウントの登録やログインの画面も、合言葉を通った後に開きます
- `/logout` は、合言葉とログインの両方をログアウトします
```

7. 「データ」の節の下に足す。

```markdown
ログイン情報（`users`, `sessions` など）も `data/app.db` に入ります。パスワードはハッシュ（scrypt）で保存され、元の文字列は残りません。
```

8. 「構成」の表の `server.js` の行の下と、ファイル一覧を直す。

```
server.js            API・画面ファイル・画像の配信
lib/db.js            データベースの初期化
lib/auth.js          登録・ログイン・パスワード再設定・退会
lib/guard.js         ログインの要否と、所有者の検査
lib/mailer.js        メール送信（SMTP またはコンソール出力）
lib/secrets.js       パスワードのハッシュ、トークンの生成
lib/cookies.js       Cookie の読み取り
public/index.html    画面の骨組みとダイアログ
public/account.html  ログイン・登録・パスワード再設定の画面
public/account.js    ↑の動き
public/login.html    合言葉の入力画面
```

構成の表の「バックエンド」を次に変える。

```markdown
| バックエンド | Node.js、Express、multer（画像アップロード）、nodemailer（メール送信） |
```

9. 「API」の表を直す。`POST /api/people` と `DELETE /api/people/:id` の行を削除し、`PUT /api/people/:id` の説明に「本人のみ」を足し、次を足す。

```markdown
| GET | `/api/me` | ログイン中のユーザー（未ログインは `{ "user": null }`） |
| POST | `/api/auth/signup` | 登録の申し込み（`email`, `password`, `person_id` または `new_name`/`new_color`）。確認コードをメールで送る |
| POST | `/api/auth/verify` | 6桁コードの確認（`email`, `code`）。成功するとログインする |
| POST | `/api/auth/resend` | コードの再送（60秒に1回） |
| POST | `/api/auth/login` | ログイン（`email`, `password`） |
| POST | `/api/auth/logout` | ログアウト |
| POST | `/api/auth/forgot` | パスワード再設定のメールを送る（登録の有無にかかわらず同じ応答） |
| POST | `/api/auth/reset` | 新しいパスワードを設定（`token`, `password`） |
| POST | `/api/me/withdraw` | 退会（`password`）。人・在室・メモ・アカウントを削除 |
```

表の上に1行足す。

```markdown
`GET` は誰でも（合言葉を通れば）使えます。それ以外の `/api/*` は、ログインが必要です（未ログインは `401`）。他の人の在室・メモを操作すると `403` になります。
```

10. 「注意事項」の最初の項目を次に変える。

```markdown
- `ROOM_PASSWORD` を設定しない場合、LANにつながる人なら誰でも閲覧でき、アカウントも登録できます。
- 通信は暗号化されません（HTTP）。パスワードやメールの確認コードが平文で流れるので、インターネットに公開する場合は必ず HTTPS の下で動かしてください。
- 人は登録のときにだけ作ります。誰にも紐付けられていない既存の人は、紐付けられるまで誰も編集できません（紐付けの解除はできません）。
```

- [ ] **Step 3: 全テストと最終確認**

Run: `npm test`
Expected: すべて pass、fail 0。

Run: `git status --short`
Expected: `?? .serena/` のほかに、未コミットの変更がない（`.serena/` は `git add` しない）。

Run: `ls data/`
Expected: 本番の `data/` の中身が、作業の前と変わっていない（`app.db`, `uploads/` のみ）。

Run: `git log --oneline main..HEAD`
Expected: Task 1〜8 のコミットが並ぶ。

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-11-06-user-accounts-design.md docs/superpowers/plans/2026-11-06-user-accounts.md
git commit -m "README にアカウント機能の説明を追加し、スペックを実装に合わせる" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review（プラン作成者による確認）

**1. スペックとの対応**

| スペックの節 | 担当 |
| --- | --- |
| データ（4 テーブル、値の作り方） | Task 1（表）、Task 2（`secrets`） |
| 登録（signup / verify / resend、競合、5回、再送 60秒） | Task 3 |
| ログイン、制限 | Task 4 |
| PW リセット（1回限り、全セッション破棄、応答を揃える） | Task 4 |
| セッション（Cookie、`/api/me`、logout、`GET /logout`） | Task 3 |
| 退会（PW 再入力、`DELETE /api/people/:id` の廃止） | Task 4（退会）、Task 5（廃止） |
| 権限（在室・メモ・人、`restore` の縮小、`claimed`） | Task 5 |
| 画面（ログイン前後、`account.html`、鍵、キーボードモード、他人の予定） | Task 6、Task 7 |
| 構成（`lib/` の分割） | Task 1〜5 |
| 設定（`.env`、`SMTP_*`、コンソール出力、`PUBLIC_URL` の警告） | Task 1（`loadEnvFile`）、Task 2（`mailer`）、Task 3（起動ログ） |
| エラーの扱い | Task 3〜5 |
| テスト | 全タスク |
| README | Task 8 |

**2. プレースホルダーの確認:** 「TBD」「あとで」「適切に」などは使っていない。コードの手順には、すべてコードを書いた。Task 7 の `app.js` は、変更前のコードの断片と、置き換えるコードを示している（行番号ではなく関数名で探す）。

**3. 型と名前の一致:** `req.user = { id, email, person_id }`、`guard.mine/memoOk/staysAllMine/memosAllOk/deny/writeGuard`、`createSession/destroySession`、`registerUser(srv, { email, password, person })`、`Client.user`、`srv.waitMail(to, minCount)`、`srv.mailCount(to)` を、定義したタスクと使うタスクで揃えた。クライアントの `me`, `isMe`, `myPeople`, `canEditStay`, `canEditMemo`, `loadMe` も Task 7 の中で揃っている。

**4. Review Focus:** 5 つとも担当タスクにテストがある（1: Task 3, 4 / 2, 3: Task 3 / 4: Task 4 / 5: Task 5）。

**スペックからの意図的な差分:** (a) `401` に `needLogin: true` を足した（合言葉の `401` と見分けるため。Task 8 でスペックに反映）。(b) `GET /logout` の変更は Task 3 に入れた（`destroySession` ができるタスクのため）。
