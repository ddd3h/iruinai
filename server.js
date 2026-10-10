const express = require('express');
const compression = require('compression');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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
`);

const ALLOWED_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + ALLOWED_EXT[file.mimetype]),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype in ALLOWED_EXT),
});

function removeIcon(iconPath) {
  if (!iconPath) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(iconPath)), { force: true }, () => {});
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
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

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// 総当たり対策：同じ IP から5回続けて間違えたら1分待たせる
const failures = new Map();
const LOCK_COUNT = 5;
const LOCK_MS = 60 * 1000;

if (PASSWORD) {
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));

  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const f = failures.get(req.ip);
    if (f && f.count >= LOCK_COUNT && Date.now() - f.at < LOCK_MS) return res.redirect(303, '/login?e=wait');
    if (!sameText(String(req.body.password || ''), PASSWORD)) {
      const count = f && Date.now() - f.at < LOCK_MS ? f.count + 1 : 1;
      failures.set(req.ip, { count, at: Date.now() });
      return res.redirect(303, '/login?e=wrong');
    }
    failures.delete(req.ip);
    res.setHeader('Set-Cookie', `${COOKIE}=${TOKEN}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
    res.redirect(303, '/');
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
    res.redirect(303, '/login');
  });

  app.use((req, res, next) => {
    if (sameText(readCookie(req, COOKIE), TOKEN)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'ログインしてください' });
    res.redirect(303, '/login');
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/vendor/fullcalendar', express.static(path.join(__dirname, 'node_modules/fullcalendar')));
app.use('/vendor/locales', express.static(path.join(__dirname, 'node_modules/@fullcalendar/core/locales')));

// ---- people ----
app.get('/api/people', (req, res) => {
  res.json(db.prepare('SELECT * FROM people ORDER BY id').all());
});

app.post('/api/people', upload.single('icon'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '名前は必須です' });
  const color = COLOR_RE.test(req.body.color) ? req.body.color : '#4f7cff';
  const icon = req.file ? '/uploads/' + req.file.filename : null;
  const r = db.prepare('INSERT INTO people (name, color, icon_path) VALUES (?, ?, ?)').run(name, color, icon);
  res.status(201).json(db.prepare('SELECT * FROM people WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/api/people/:id', upload.single('icon'), (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const name = (req.body.name || '').trim() || p.name;
  const color = COLOR_RE.test(req.body.color) ? req.body.color : p.color;
  let icon = p.icon_path;
  if (req.file) {
    removeIcon(p.icon_path);
    icon = '/uploads/' + req.file.filename;
  } else if (req.body.removeIcon === '1') {
    removeIcon(p.icon_path);
    icon = null;
  }
  db.prepare('UPDATE people SET name = ?, color = ?, icon_path = ? WHERE id = ?').run(name, color, icon, p.id);
  res.json(db.prepare('SELECT * FROM people WHERE id = ?').get(p.id));
});

app.delete('/api/people/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM people WHERE id = ?').run(p.id);
  removeIcon(p.icon_path);
  res.status(204).end();
});

// ---- stays ----
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
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(person_id)) return res.status(400).json({ error: '人が存在しません' });
  const insert = db.prepare('INSERT INTO stays (person_id, start, end, note) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const d of new Set(dates)) insert.run(person_id, `${d}T${startTime}:00`, `${d}T${endTime}:00`, note || '');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.status(201).json({ created: new Set(dates).size });
});

app.put('/api/stays/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM stays WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const b = { ...s, ...req.body };
  if (!validStay(b)) return res.status(400).json({ error: '入力が不正です' });
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(b.person_id)) return res.status(400).json({ error: '人が存在しません' });
  db.prepare('UPDATE stays SET person_id = ?, start = ?, end = ?, note = ? WHERE id = ?')
    .run(b.person_id, b.start, b.end, b.note || '', s.id);
  res.json(db.prepare('SELECT * FROM stays WHERE id = ?').get(s.id));
});

app.delete('/api/stays/:id', (req, res) => {
  db.prepare('DELETE FROM stays WHERE id = ?').run(req.params.id);
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
  if (!memoTargetOk(personId)) return res.status(400).json({ error: '人が存在しません' });
  const insert = db.prepare('INSERT INTO memos (person_id, title, all_day, start, end) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const it of items) insert.run(personId, title, allDay, it.start, it.end);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.status(201).json({ created: items.length });
});

app.put('/api/memos/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM memos WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const b = { ...m, ...req.body };
  const title = String(b.title ?? '').trim();
  const allDay = b.all_day ? 1 : 0;
  const personId = b.person_id ?? null;
  if (!title || title.length > 100) return res.status(400).json({ error: '内容を入力してください（100字まで）' });
  if (!validMemoRange(allDay, b.start, b.end)) return res.status(400).json({ error: '入力が不正です' });
  if (!memoTargetOk(personId)) return res.status(400).json({ error: '人が存在しません' });
  db.prepare('UPDATE memos SET person_id = ?, title = ?, all_day = ?, start = ?, end = ? WHERE id = ?')
    .run(personId, title, allDay, b.start, b.end, m.id);
  res.json(db.prepare('SELECT * FROM memos WHERE id = ?').get(m.id));
});

app.delete('/api/memos/:id', (req, res) => {
  db.prepare('DELETE FROM memos WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.use((err, req, res, next) => {
  const msg = err.code === 'LIMIT_FILE_SIZE' ? '画像は2MBまでです' : err.message;
  res.status(400).json({ error: msg });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`在室カレンダー: http://localhost:${PORT}`);
  console.log(PASSWORD ? '合言葉: 有効' : '合言葉: 無効（ROOM_PASSWORD 未設定）');
  shrinkExistingIcons().catch((err) => console.log('アイコンの縮小に失敗:', err.message));
});
