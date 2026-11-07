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
const FAIL_LOCK_COUNT = 5; // ログイン・退会で、PW を間違えてよい回数
const FAIL_LOCK_MS = 60 * 1000;
const FAIL_LOCK_MSG = '間違いが続いたので、1分ほど待ってからもう一度どうぞ';
const CODE_MAX_ATTEMPTS = 5; // 間違いは、コードを送り直しても数え直さない（確認待ちの行ごとに 5回）
const RESEND_MAX = 3; // 1つの確認待ちにつき、再送は 3回まで
const LOCKED_MSG = '間違いが続いたため、このコードは使えません。10分ほど待ってから、もう一度登録してください';
const RESEND_LIMIT_MSG = '再送できる回数の上限です。10分ほど待ってから、もう一度登録してください';
const PENDING_MSG = 'このメールアドレスは、すでに登録の手続き中です。自分で申し込んだ場合は、届いた確認コードと、そのときのパスワードを入力してください。心当たりがない場合は、10分ほど待ってからやり直してください';
const MISMATCH_MSG = (left) => `確認コードかパスワードが違います（あと ${left} 回）`;
const SERVER_ERROR_MSG = 'サーバーでエラーが起きました';
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// アドレスの書式に使う記号（< > ( ) , ; : " [ ] \）と空白は入れない。メールの宛先として別のアドレスを紛れ込ませないため
const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

// 画面にそのまま見せてよいエラー。これ以外の予期しないエラーは、中身を返さずログにだけ残す
class UserError extends Error {}

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
  if (typeof b.email !== 'string') return bad(res, 'メールアドレスの形式が正しくありません');
  const email = normEmail(b.email);
  if (!validEmail(email)) return bad(res, 'メールアドレスの形式が正しくありません');
  if (!validPassword(b.password)) return bad(res, 'パスワードは8文字以上128文字以下にしてください');
  let personId = null;
  let newName = null;
  let newColor = null;
  if (b.person_id != null) {
    if (!Number.isInteger(b.person_id)) return bad(res, '人を選んでください'); // 数値の整数だけ（true や [] や '1' は不可）
    personId = b.person_id;
    const msg = personUnavailable(personId);
    if (msg) return bad(res, msg);
  } else {
    if (typeof b.new_name !== 'string') return bad(res, '名前を入力してください（20字まで）');
    newName = b.new_name.trim();
    if (!newName || newName.length > 20) return bad(res, '名前を入力してください（20字まで）');
    if (b.new_color != null && typeof b.new_color !== 'string') return bad(res, '色の指定が正しくありません');
    newColor = COLOR_RE.test(b.new_color) ? b.new_color : '#4f7cff';
  }
  cleanup();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'このメールアドレスは登録済みです');
  // cleanup() で期限切れは消えているので、行が残っていれば確認待ちの登録がまだ生きている。
  // 第三者がそれを上書きして、パスワードや紐付けをすり替えられないようにする（再送は /resend で）
  const prev = db.prepare('SELECT sent_at FROM pending_signups WHERE email = ?').get(email);
  if (prev) {
    if (Date.now() - prev.sent_at < RESEND_MS) return bad(res, '確認メールを送ったばかりです。1分ほど待ってからもう一度どうぞ', 429);
    return bad(res, PENDING_MSG);
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
  const password = req.body?.password;
  const drop = () => db.prepare('DELETE FROM pending_signups WHERE email = ?').run(email);
  const p = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(email);
  if (!p || p.expires_at < Date.now()) {
    if (p) drop();
    return bad(res, 'コードの有効期限が切れました。もう一度登録してください');
  }
  // 間違いが続いた行は消さず、期限までロックしたまま残す（消すと sent_at も消え、すぐ登録し直してメールを送らせられる）
  if (p.attempts >= CODE_MAX_ATTEMPTS) return bad(res, LOCKED_MSG);
  // コードとパスワードは、片方が違っても必ず両方調べる（どちらが違うかを、応答の文面や時間で漏らさない）。
  // パスワードも要るのは、他人のメールで自分のパスワードを使って登録を始め、本人に届いたコードを入力させて
  // 自分のパスワードのアカウントに入らせる、という乗っ取りを防ぐため。パスワードがない・文字列でなければ不一致
  const codeOk = S.safeEqualHex(S.sha256(code), p.code_hash) && /^\d{6}$/.test(code);
  const pwText = typeof password === 'string' && password.length <= 128 ? password : null;
  const passwordOk = S.verifyPassword(pwText ?? '', p.password_hash) && pwText !== null;
  if (!codeOk || !passwordOk) {
    const attempts = p.attempts + 1;
    db.prepare('UPDATE pending_signups SET attempts = ? WHERE email = ?').run(attempts, email);
    return bad(res, attempts >= CODE_MAX_ATTEMPTS ? LOCKED_MSG : MISMATCH_MSG(CODE_MAX_ATTEMPTS - attempts));
  }
  let userId;
  try {
    inTransaction(() => {
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new UserError('このメールアドレスは登録済みです');
      let personId = p.person_id;
      if (personId != null) {
        const msg = personUnavailable(personId);
        if (msg) throw new UserError(msg);
      } else {
        personId = Number(db.prepare('INSERT INTO people (name, color) VALUES (?, ?)').run(p.new_name, p.new_color).lastInsertRowid);
      }
      userId = Number(db.prepare('INSERT INTO users (email, password_hash, person_id, created_at) VALUES (?, ?, ?, ?)')
        .run(email, p.password_hash, personId, Date.now()).lastInsertRowid);
      drop();
    });
  } catch (err) {
    drop(); // 選び直してすぐ登録し直せるように、途中データを消す
    if (err instanceof UserError) return bad(res, err.message);
    console.error('確認コードの検証中にエラー:', err);
    return bad(res, SERVER_ERROR_MSG, 500);
  }
  createSession(req, res, userId);
  res.json({ user: publicUser(userId) });
});

authRouter.post('/resend', async (req, res) => {
  const email = normEmail(req.body?.email);
  const p = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(email);
  if (!p || p.expires_at < Date.now()) return bad(res, '登録の手続きが見つかりません。もう一度登録してください');
  // 間違いの回数は再送で戻さない。ロックされた行は、新しいコードを送っても使えるようにならないので、メールも送らない
  if (p.attempts >= CODE_MAX_ATTEMPTS) return bad(res, LOCKED_MSG);
  if (p.resend_count >= RESEND_MAX) return bad(res, RESEND_LIMIT_MSG, 429);
  const now = Date.now();
  if (now - p.sent_at < RESEND_MS) return bad(res, '再送は1分ほど空けてください', 429);
  // ここから送信の前まで await しない。メールを送る前に DB に予約（新しいコード・期限・送信時刻・回数）を書いておくので、
  // 続けて届いた 2つ目のリクエストは、送信が終わるのを待たずに上の 60秒の判定で止まる
  const code = S.newCode();
  const codeHash = S.sha256(code);
  db.prepare('UPDATE pending_signups SET code_hash = ?, expires_at = ?, sent_at = ?, resend_count = resend_count + 1 WHERE email = ?')
    .run(codeHash, now + CODE_MS, now, email);
  try {
    await sendMail({ to: email, ...signupMail(code) });
  } catch (err) {
    // 送れなかったので予約を元に戻す（メールが届かないまま 1分待たされたり、再送の回数だけ減ったりしないように）。
    // 送信の間に行が消えた・置き換わったときは触らない。間違いの回数（attempts）も触らない
    db.prepare('UPDATE pending_signups SET code_hash = ?, expires_at = ?, sent_at = ?, resend_count = ? WHERE email = ? AND code_hash = ?')
      .run(p.code_hash, p.expires_at, p.sent_at, p.resend_count, email, codeHash);
    console.log('確認メールの再送に失敗:', err.message);
    return bad(res, 'メールを送れませんでした', 502);
  }
  res.json({ ok: true });
});

// 総当たり対策（合言葉と同じ方式）：同じキーで 5回続けて間違えたら 1分待たせる。回数は最後の間違いから 1分で数え直す。
// ロック中の試行は数えず、時間も延ばさない。成功しても回数は戻さない（自分のアカウントで成功を挟んで、他人への総当たりの回数を戻せないように）。
// 古い記録は、間違いのたびにまとめて捨てるので、Map が増え続けることはない
function failureLimiter() {
  const seen = new Map();
  let sweptAt = 0;
  return {
    locked(key) {
      const f = seen.get(key);
      return !!f && f.count >= FAIL_LOCK_COUNT && Date.now() - f.at < FAIL_LOCK_MS;
    },
    fail(key) {
      const now = Date.now();
      const f = seen.get(key);
      seen.set(key, { count: f && now - f.at < FAIL_LOCK_MS ? f.count + 1 : 1, at: now });
      if (now - sweptAt >= FAIL_LOCK_MS) {
        sweptAt = now;
        for (const [k, v] of seen) if (now - v.at >= FAIL_LOCK_MS) seen.delete(k);
      }
    },
  };
}
const loginLimiter = failureLimiter(); // キーは IP
const withdrawLimiter = failureLimiter(); // キーはユーザー ID（セッションを持っている相手が PW を当てに来るので、アカウントごとに数える）

authRouter.post('/login', (req, res) => {
  if (loginLimiter.locked(req.ip)) return bad(res, FAIL_LOCK_MSG, 429);
  const email = normEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // ユーザーがいなくても scrypt を 1回走らせる（応答時間でメールの有無が分からないように）
  const verified = S.verifyPassword(password, u ? u.password_hash : S.DUMMY_HASH);
  if (!u || !verified || password.length > 128) {
    loginLimiter.fail(req.ip);
    return bad(res, 'メールアドレスまたはパスワードが違います');
  }
  // 成功しても失敗の回数は消さない（上の failureLimiter のとおり）。回数は 1分で自然に切れる
  cleanup();
  createSession(req, res, u.id);
  res.json({ user: publicUser(u.id) });
});

// リセット URL の元になる公開 URL（PUBLIC_URL があればそれ、なければアクセス先）
const publicUrl = () => (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
function originOf(req) {
  return publicUrl() || `${req.protocol}://${req.get('host')}`;
}

const forgotSentAt = new Map(); // メール → 最後に送った時刻（メール爆撃の防止）

authRouter.post('/forgot', async (req, res) => {
  const email = normEmail(req.body?.email);
  res.json({ ok: true }); // 登録の有無にかかわらず、先に同じ応答を返す
  try {
    if (!validEmail(email)) return;
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!u) return;
    // SMTP で実際にメールを送るときは、Host ヘッダー（相手が好きに書ける）から URL を作らない。
    // 攻撃者が本人宛てに「偽のドメインへのリンク」入りの本物のメールを送らせられるため
    if (mailMode() === 'smtp' && !publicUrl()) {
      console.log('エラー: PUBLIC_URL が未設定のため、パスワード再設定のメールを送れません。.env で PUBLIC_URL を設定してください');
      return;
    }
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
  // ロック中は PW を調べない（正しい PW でも通さない）。scrypt を走らせないので、連打で CPU を使わせることもできない
  if (withdrawLimiter.locked(req.user.id)) return bad(res, FAIL_LOCK_MSG, 429);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length > 128 || !S.verifyPassword(password, u.password_hash)) {
    withdrawLimiter.fail(req.user.id);
    return bad(res, 'パスワードが違います');
  }
  db.prepare('DELETE FROM people WHERE id = ?').run(u.person_id); // users・sessions・stays・memos は ON DELETE CASCADE
  destroySession(req, res);
  res.json({ ok: true });
});

module.exports = { authRouter, meRouter, attachUser, cleanup, destroySession, COOKIE, mailMode };
