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
const RESET_MS = 60 * 60 * 1000;
const LOGIN_LOCK_COUNT = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const LOCKED_MSG = '間違いが続いたので、10分ほど待ってからもう一度登録してください';
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const validEmail = (e) => e.length <= 254 && EMAIL_RE.test(e);
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 128;
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const publicUser = (id) => db.prepare('SELECT id, email, person_id FROM users WHERE id = ?').get(id);

// ---- セッション ----
// TLS を終端するプロキシの後ろでは req.secure が false になるので、PUBLIC_URL が https ならそれも見る
const isHttps = (req) => req.secure || /^https:\/\//i.test(process.env.PUBLIC_URL || '');

function sessionCookie(req, token, maxAgeSec) {
  return `${COOKIE}=${token}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
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
  // cleanup() で期限切れは消えているので、行が残っていれば確認待ちの登録がまだ生きている。
  // 第三者がそれを上書きして、パスワードや紐付けをすり替えられないようにする（再送は /resend で）
  const prev = db.prepare('SELECT sent_at FROM pending_signups WHERE email = ?').get(email);
  if (prev) {
    if (Date.now() - prev.sent_at < RESEND_MS) return bad(res, '確認メールを送ったばかりです。1分ほど待ってからもう一度どうぞ', 429);
    return bad(res, 'このメールアドレスには確認メールを送信済みです。届いたコードを入力するか、10分ほど待ってからやり直してください');
  }

  const code = S.newCode();
  const now = Date.now();
  db.prepare(`INSERT INTO pending_signups (email, password_hash, person_id, new_name, new_color, code_hash, expires_at, attempts, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
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
  // 間違いが続いた行は消さず、期限までロックしたまま残す（消すと sent_at も消え、すぐ登録し直してメールを送らせられる）
  if (p.attempts >= CODE_MAX_ATTEMPTS) return bad(res, LOCKED_MSG);
  if (!/^\d{6}$/.test(code) || !S.safeEqualHex(S.sha256(code), p.code_hash)) {
    const attempts = p.attempts + 1;
    db.prepare('UPDATE pending_signups SET attempts = ? WHERE email = ?').run(attempts, email);
    return bad(res, attempts >= CODE_MAX_ATTEMPTS ? LOCKED_MSG : 'コードが違います');
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

authRouter.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// ---- /api/me ----
const meRouter = express.Router();

meRouter.get('/', (req, res) => {
  res.json({ user: req.user });
});

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

module.exports = { authRouter, meRouter, attachUser, cleanup, destroySession, COOKIE, mailMode };
