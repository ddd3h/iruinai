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
const { readCookie } = require('./lib/cookies');
const { authRouter, meRouter, attachUser, cleanup: cleanupAuth, destroySession, mailMode } = require('./lib/auth');
const { appTitle } = require('./lib/appTitle');

const ALLOWED_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + ALLOWED_EXT[file.mimetype]),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype in ALLOWED_EXT),
});

// 画像の受け取り（multer）で起きたエラーを、受け取った内容の誤りとして 400 にそろえる。
// 壊れた multipart（Unexpected end of form・Malformed part header・Boundary not found など）は、busboy からステータスのない
// 普通の Error で届くため、そのままだと 500 とスタックのログになってしまう。
// 2MB 超過（LIMIT_FILE_SIZE）は、今までの文面を返すため末尾のエラー処理に任せる。
// ディスクの書き込み失敗などサーバー側の問題（syscall の付いたシステムエラー）も、500 のまま末尾に任せる
const uploadIcon = upload.single('icon');
function receiveIcon(req, res, next) {
  uploadIcon(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE' || err.syscall) return next(err);
    res.status(400).json({ error: 'アップロードの内容が正しくありません' });
  });
}

function removeIcon(iconPath) {
  if (!iconPath) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(iconPath)), { force: true }, () => {});
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// 画面にそのまま見せてよい入力エラー。これ以外の予期しないエラーは、中身を返さずログにだけ残す（末尾のエラー処理）
class InputError extends Error {}
const { createGuard } = require('./lib/guard');
const guard = createGuard(db);
const app = express();
app.use(compression());
app.use(express.json());

// ---- 合言葉 ----
// ROOM_PASSWORD を設定したときだけ有効。未設定なら誰でも開ける（従来どおり）
const PASSWORD = process.env.ROOM_PASSWORD || '';
const COOKIE = 'iruinai_auth';
// Cookie の値は合言葉から作る。合言葉を変えると全員ログアウトされる
const TOKEN = crypto.createHmac('sha256', PASSWORD).update('iruinai-auth').digest('hex');
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1年

function sameText(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 総当たり対策：同じ IP から5回続けて間違えたら1分待たせる
const failures = new Map();
const LOCK_COUNT = 5;
const LOCK_MS = 60 * 1000;

// OGP の画像は URL が絶対でないと読まれないため、HTML の __ORIGIN__ をアクセス先の URL に置き換えて返す
// リバースプロキシの後ろで URL が違って見えるときは PUBLIC_URL（例: https://room.example.com）を設定する
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// __TITLE__ は、アプリの名前（APP_TITLE。既定は「在室カレンダー」）に置き換える。HTML に escape して入れる。
// vars(req) があれば、そこで返した { '__名前__': '値' } も置き換える（値は呼び出し側で HTML に escape しておく）。
// 置き換えは 1回の走査で行い、関数で値を返す。値の中の `$&` などが特別な意味に解釈されたり、
// 値の中の `__NEXT__` のような文字がもう一度置き換えられたりしないため
function sendPage(file, vars) {
  const html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  return (req, res) => {
    const subs = {
      __ORIGIN__: PUBLIC_URL || `${req.protocol}://${req.get('host')}`,
      __TITLE__: escapeHtml(appTitle()),
      ...(vars ? vars(req) : {}),
    };
    res.type('html').send(html.replace(new RegExp(Object.keys(subs).join('|'), 'g'), (key) => subs[key]));
  };
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 合言葉のあとに戻る場所（next）として使ってよいのは、このサイトの中の道だけ。
// 外部サイト（//host, \host, scheme:）・ヘッダー注入（制御文字、%0d%0a など）・長すぎる値・合言葉の画面自身（ループ）は使わない
const NEXT_MAX = 2000;
function safeNext(v) {
  if (typeof v !== 'string' || v.length > NEXT_MAX) return null;
  if (v[0] !== '/' || v[1] === '/' || v[1] === '\\') return null;
  if (v.includes('\\') || v.includes('://')) return null;
  if (/[\u0000-\u001f\u007f]|%[01][0-9a-f]|%7f/i.test(v)) return null;
  const route = v.split(/[?#]/)[0].toLowerCase().replace(/\/+$/, '');
  if (route === '/login' || route === '/logout') return null;
  return v;
}
const loginWithNext = (flag, next) => `/login${flag ? `?e=${flag}` : ''}${next ? `${flag ? '&' : '?'}next=${encodeURIComponent(next)}` : ''}`;

// 合言葉の前に開いた画面（ページ）は、合言葉のあとにそこへ戻れるよう next に控える（メールのリセットリンクのトークンを失わないため）。
// API や画像・スクリプトなどには付けない
const NEXT_PAGES = new Set(['/', '/index.html', '/account', '/reset']);
function loginUrlFor(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return '/login';
  if (!NEXT_PAGES.has(req.path.toLowerCase().replace(/\/+$/, '') || '/')) return '/login';
  const next = safeNext(req.originalUrl);
  return loginWithNext('', next && next !== '/' ? next : null);
}
const pageIndex = sendPage('index.html');
const pageLogin = sendPage('login.html', (req) => ({ __NEXT__: escapeHtml(safeNext(req.query.next) || '') }));
const pageAccount = sendPage('account.html');
const pageLogout = sendPage('logout.html');

// SNS のプレビュー用クローラーはログインできないので、OGP 画像だけは合言葉なしで配る
app.get('/iruinai-ogp.png', (req, res) => res.sendFile(path.join(__dirname, 'public/iruinai-ogp.png')));

if (PASSWORD) {
  app.get('/login', (req, res) => pageLogin(req, res));

  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const next = safeNext(req.body.next); // 合言葉が合ったあとに戻る場所。安全でなければ `/`
    const f = failures.get(req.ip);
    if (f && f.count >= LOCK_COUNT && Date.now() - f.at < LOCK_MS) return res.redirect(303, loginWithNext('wait', next));
    if (!sameText(String(req.body.password || ''), PASSWORD)) {
      const count = f && Date.now() - f.at < LOCK_MS ? f.count + 1 : 1;
      failures.set(req.ip, { count, at: Date.now() });
      return res.redirect(303, loginWithNext('wrong', next));
    }
    failures.delete(req.ip);
    res.setHeader('Set-Cookie', `${COOKIE}=${TOKEN}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
    res.redirect(303, next || '/');
  });

  function logout(req, res) {
    destroySession(req, res); // セッションの行と Cookie を消す
    res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
    res.redirect(303, '/login');
  }
  // GET は、アドレス欄・ブックマーク・同じサイトのリンクから開いたとき（Sec-Fetch-Site が same-origin か none）だけログアウトする。
  // 他のサイトのリンクや画像で勝手にログアウトさせられないよう、cross-site・same-site・ヘッダーなしは確認の画面を出す
  app.get('/logout', (req, res) => {
    const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
    if (fetchSite === 'same-origin' || fetchSite === 'none') return logout(req, res);
    pageLogout(req, res);
  });
  // 確認の画面のボタンから送られる。他のサイトから送られたと分かるもの（ヘッダーあり・same-origin 以外）は実行せず、確認の画面を返す。
  // ヘッダーのないクライアント（curl など）は、そのまま実行する
  app.post('/logout', (req, res) => {
    const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin') return pageLogout(req, res);
    logout(req, res);
  });

  app.use((req, res, next) => {
    if (sameText(readCookie(req, COOKIE), TOKEN)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'ログインしてください' });
    res.redirect(303, loginUrlFor(req));
  });
}

// ---- アカウント ----
app.use(attachUser);
app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
app.get(['/account', '/account.html', '/reset'], pageAccount);
// プレースホルダー（__TITLE__ など）を持つ HTML は、.html のアドレスで開かれても置き換えて返す（下の express.static が生のまま配らないように）
app.get('/login.html', pageLogin);
app.get('/logout.html', pageLogout);
app.use('/api', guard.writeGuard); // /api/auth と /api/me はこの前で処理済み

app.get(['/', '/index.html'], pageIndex);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/vendor/fullcalendar', express.static(path.join(__dirname, 'node_modules/fullcalendar')));
app.use('/vendor/locales', express.static(path.join(__dirname, 'node_modules/@fullcalendar/core/locales')));

// ---- people ----
app.get('/api/people', (req, res) => {
  res.json(db.prepare(`SELECT p.*, EXISTS(SELECT 1 FROM users u WHERE u.person_id = p.id) AS claimed
    FROM people p ORDER BY p.id`).all());
});

// 人は登録時にだけ作る（POST はない）。変更は本人だけ。退会は POST /api/me/withdraw
// 画像を受け取る前に所有者を検査する（拒否した画像がディスクに残らないように）
app.put('/api/people/:id', (req, res, next) => (guard.mine(req, req.params.id) ? next() : guard.deny(res)),
  receiveIcon, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: '送信内容が正しくありません' });
    const p = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const name = (typeof body.name === 'string' ? body.name.trim() : '') || p.name;
    const color = typeof body.color === 'string' && COLOR_RE.test(body.color) ? body.color : p.color;
    // 古い画像は「元に戻す」で使うので消さない（使われなくなった画像は起動時に掃除する）
    let icon = p.icon_path;
    if (req.file) icon = '/uploads/' + req.file.filename;
    else if (body.removeIcon === '1') icon = null;
    db.prepare('UPDATE people SET name = ?, color = ?, icon_path = ? WHERE id = ?').run(name, color, icon, p.id);
    res.json({ ...db.prepare('SELECT * FROM people WHERE id = ?').get(p.id), before: p });
  });

// 「元に戻す」：自分の人の変更を元の値に戻す（削除済みの人は作り直さない）
app.post('/api/people/restore', (req, res) => {
  const { person } = req.body || {};
  const name = typeof person?.name === 'string' ? person.name.trim() : '';
  if (!Number.isInteger(person?.id) || !name || typeof person.color !== 'string' || !COLOR_RE.test(person.color)) {
    return res.status(400).json({ error: '入力が不正です' });
  }
  if (!guard.mine(req, person.id)) return guard.deny(res);
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(person.id)) return res.status(404).json({ error: 'not found' });
  // 画像は残っているときだけ使う
  const file = person.icon_path && path.join(UPLOAD_DIR, path.basename(String(person.icon_path)));
  let icon = file && fs.existsSync(file) ? '/uploads/' + path.basename(file) : null;
  // 他の人が使っている画像は取り込まない（起動時の縮小で元の画像が消え、その人のアイコンが壊れるため）
  if (icon && db.prepare('SELECT 1 FROM people WHERE icon_path = ? AND id != ?').get(icon, person.id)) icon = null;
  db.prepare('UPDATE people SET name = ?, color = ?, icon_path = ? WHERE id = ?').run(name, person.color, icon, person.id);
  res.json(db.prepare('SELECT * FROM people WHERE id = ?').get(person.id));
});

// ---- stays ----
// 「元に戻す」で消したもの・変えたものを同じ id で書き戻す
function restoreStays(items) {
  const upsert = db.prepare(`INSERT INTO stays (id, person_id, start, end, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET person_id = excluded.person_id, start = excluded.start, end = excluded.end, note = excluded.note`);
  for (const s of items) {
    if (!Number.isInteger(s?.id) || !validStay(s)) throw new InputError('入力が不正です');
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(s.person_id)) throw new InputError('人が存在しません');
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
    if (!Number.isInteger(m?.id) || !title || title.length > 100 || !validMemoRange(allDay, m.start, m.end)) throw new InputError('入力が不正です');
    if (!memoTargetOk(personId)) throw new InputError('人が存在しません');
    upsert.run(m.id, personId, title, allDay, m.start, m.end);
  }
}

// 「元に戻す」で書き戻せるのは、今までに採番された id（AUTOINCREMENT の seq 以下）だけ。
// 大きな id を入れられると、次の追加が採番できずに壊れる
function idsAllIssued(table, items) {
  const seq = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq ?? 0;
  return items.every((it) => !(it?.id > seq));
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
  if (!idsAllIssued('stays', items)) return res.status(400).json({ error: '入力が不正です' });
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
  if (!idsAllIssued('memos', items)) return res.status(400).json({ error: '入力が不正です' });
  inTransaction(() => restoreMemos(items));
  res.status(204).end();
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '画像は2MBまでです' });
  if (err instanceof InputError) return res.status(400).json({ error: err.message });
  // 壊れた JSON・不正なアップロードなど、リクエストの形そのものの誤り（英語の技術的な文面は返さない）
  if (err instanceof multer.MulterError || (err.status >= 400 && err.status < 500)) return res.status(400).json({ error: '送信内容が正しくありません' });
  console.error(err);
  res.status(500).json({ error: 'サーバーでエラーが起きました' });
});

// ---- 起動時: 既存アイコンを 144px の WebP に縮小 ----
// 変換済み（.webp かつ小さい）のものは触らない。何度起動しても同じ結果になる
const ICON_SIZE = 144;
const ICON_OK_BYTES = 30 * 1024;

async function shrinkExistingIcons() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.log('アイコンの縮小: sharp が無いためスキップ（npm install で入ります）');
    return;
  }
  let done = 0;
  for (const p of db.prepare('SELECT id, icon_path FROM people WHERE icon_path IS NOT NULL').all()) {
    const file = path.join(UPLOAD_DIR, path.basename(p.icon_path));
    try {
      if (!fs.existsSync(file)) continue;
      if (path.extname(file) === '.webp' && fs.statSync(file).size <= ICON_OK_BYTES) continue;
      const name = crypto.randomUUID() + '.webp';
      await sharp(file).rotate().resize(ICON_SIZE, ICON_SIZE, { fit: 'cover' }).webp({ quality: 80 }).toFile(path.join(UPLOAD_DIR, name));
      db.prepare('UPDATE people SET icon_path = ? WHERE id = ?').run('/uploads/' + name, p.id);
      removeIcon(p.icon_path); // DB を更新してから古い画像を消す
      done++;
    } catch (err) {
      console.log(`アイコンの縮小に失敗（元の画像のまま）: person ${p.id}: ${err.message}`);
    }
  }
  console.log(done ? `アイコンを縮小: ${done}件` : 'アイコンの縮小: 対象なし');
}

// ---- 起動時: どの人にも使われていない画像を消す ----
// 編集・削除した人の古い画像は「元に戻す」のために残しているので、ここでまとめて片付ける
function removeUnusedIcons() {
  const used = new Set(db.prepare('SELECT icon_path FROM people WHERE icon_path IS NOT NULL').all()
    .map((p) => path.basename(p.icon_path)));
  let n = 0;
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (used.has(name)) continue;
    fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
    n++;
  }
  if (n) console.log(`使われていない画像を削除: ${n}件`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', (err) => {
  // ポートがすでに使われているときなど。起動したふりをせず、理由を出して止まる（Express 5 は、待ち受けの失敗もこの引数で渡す）
  if (err) {
    console.error(`起動できません: ${err.message}`);
    process.exit(1);
  }
  console.log(`在室カレンダー: http://localhost:${PORT}`);
  console.log(PASSWORD ? '合言葉: 有効' : '合言葉: 無効（ROOM_PASSWORD 未設定）');
  console.log(mailMode() === 'smtp' ? 'メール: SMTP で送信' : 'メール: コンソール出力（SMTP_HOST 未設定）');
  if (mailMode() === 'smtp' && !PUBLIC_URL) console.warn('警告: SMTP を使うときは PUBLIC_URL の設定が必要です。未設定のままだと、パスワード再設定のメールは送られません。.env で PUBLIC_URL（例: https://room.example.com）を設定してください');
  cleanupAuth();
  removeUnusedIcons();
  shrinkExistingIcons().catch((err) => console.log('アイコンの縮小に失敗:', err.message));
});
