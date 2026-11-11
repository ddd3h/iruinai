const express = require('express');
const { db, inTransaction } = require('./db');
const { sendMail, mailMode } = require('./mailer');
const { readCookie } = require('./cookies');
const S = require('./secrets');
const { appTitle } = require('./appTitle');

const COOKIE = 'iruinai_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // 延長は 1日に 1回まで
const API_TOKEN_PREFIX = 'iruinai_';
const API_TOKEN_IDLE_MS = 7 * 24 * 60 * 60 * 1000; // 最後に使ってから 7日で無効
const CODE_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const RESET_MS = 60 * 60 * 1000;
const FAIL_LOCK_COUNT = 5; // ログイン・退会で、PW を間違えてよい回数
const FAIL_LOCK_MS = 60 * 1000;
const FAIL_LOCK_MSG = '間違いが続いたので、1分ほど待ってからもう一度どうぞ';
// メールを送る API（signup・resend・forgot）の上限。IP ごとに 1時間で 10回、全体で 1時間に 100回（どちらも要求の回数）。
// 環境変数は、上限を変えたいとき・テスト用（起動時に読む）。10進の数字だけの正の整数を受け付ける。
// 設定してあるのに受け付けない値（0・負の数・文字・0x10・1e3 など）は、既定の値を使い、起動時に警告を出す（0 は「無効」ではない）
const configWarnings = [];
function positiveInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (/^\d+$/.test(v) && Number(v) > 0 && Number.isSafeInteger(Number(v))) return Number(v);
  configWarnings.push(`警告: ${name}=${JSON.stringify(v)} は使えない値です（1以上の整数だけ）。既定の ${fallback} を使います`);
  return fallback;
}
const MAIL_IP_LIMIT = positiveInt('MAIL_IP_LIMIT', 10);
const MAIL_IP_WINDOW_MS = 60 * 60 * 1000;
const MAIL_GLOBAL_LIMIT = positiveInt('MAIL_GLOBAL_LIMIT', 100);
const MAIL_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
// IP ごとの上限が全体の上限以上だと、IP ごとの上限は役に立たない（1つの IP が全体を使い切れる）
if (MAIL_IP_LIMIT >= MAIL_GLOBAL_LIMIT) {
  configWarnings.push(`警告: MAIL_IP_LIMIT（${MAIL_IP_LIMIT}）が MAIL_GLOBAL_LIMIT（${MAIL_GLOBAL_LIMIT}）以上です。1つの IP が全体の上限を使い切れるので、IP ごとの上限は働きません`);
}
const MAIL_CAP_MSG = '送信の回数が多すぎます。しばらくしてからやり直してください';
const CODE_MAX_ATTEMPTS = 5; // 間違いは、コードを送り直しても数え直さない（確認待ちの行ごとに 5回）
const RESEND_MAX = 3; // 1つの確認待ちにつき、再送は 3回まで
const LOCKED_MSG = '間違いが続いたため、このコードは使えません。10分ほど待ってから、もう一度登録してください';
const RESEND_LIMIT_MSG = '再送できる回数の上限です。10分ほど待ってから、もう一度登録してください';
const PENDING_MSG = 'このメールアドレスは、すでに登録の手続き中です。自分で申し込んだ場合は、申し込んだブラウザで、届いた確認コードを入力してください。別のブラウザで申し込んだ場合や、心当たりがない場合は、10分ほど待ってからやり直してください';
const NO_PENDING_MSG = '確認の手続きが見つかりません。もう一度、登録から始めてください';
const MISMATCH_MSG = (left) => `確認コードが違います（あと ${left} 回）`;
// 登録の確認待ちは、申し込んだブラウザに結び付ける。申し込みに成功したとき、ランダムなトークンを Cookie で渡し、
// DB にはその SHA-256 だけを置く（pending_signups.browser_hash）。確認と再送は、この Cookie の行だけが対象で、本文のメールは見ない。
// 他人が被害者のメールで自分のパスワードで申し込んでも（pre-hijacking）、被害者のブラウザにはこの Cookie がないので、確認できない
const SIGNUP_COOKIE = 'iruinai_signup';
const SIGNUP_COOKIE_MS = 60 * 60 * 1000;
const SIGNUP_COOKIE_PATH = '/api/auth';
// 確認コードを確認したあと、人を選ぶまでの猶予。人を選ばないまま放っておいた登録は、アカウントを作らずに消える
const PERSON_STEP_MS = 30 * 60 * 1000;
const NOT_VERIFIED_MSG = '先に、メールに届いた確認コードを入力してください';
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

function signupCookie(req, token, maxAgeSec) {
  return `${SIGNUP_COOKIE}=${token}; Max-Age=${maxAgeSec}; Path=${SIGNUP_COOKIE_PATH}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
}

// この要求の Cookie が結び付いている確認待ちの行（なければ undefined）。Cookie がなければ DB も引かない
function pendingOf(req) {
  const token = readCookie(req, SIGNUP_COOKIE);
  if (!token) return undefined;
  return db.prepare('SELECT * FROM pending_signups WHERE browser_hash = ?').get(S.sha256(token));
}

const noPending = (res) => res.status(400).json({ error: NO_PENDING_MSG, noPending: true });

function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ? AND kind = 'web'").run(S.sha256(token));
  res.append('Set-Cookie', sessionCookie(req, '', 0));
}

// Authorization: Bearer <API トークン> を読む。合っていれば req.user を入れ、req.viaToken を真にする（合言葉の門もこれで通る）。
// 合わないとき（書式の崩れ・知らない・期限切れ）は何もせず、普通の未認証として続ける（ここでは 401 を返さない）。
// 使うたびに期限を「今から 7日」に延ばす。Cookie のセッションと違い、1日に 1回の間引きはしない
const BEARER_RE = /^bearer (\S{1,200})$/i;
function bearerAuth(req, res, next) {
  const m = BEARER_RE.exec(req.get('authorization') || '');
  if (m) {
    const now = Date.now();
    const hash = S.sha256(m[1]);
    const row = db.prepare(`SELECT s.expires_at, u.id, u.email, u.person_id
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.kind = 'api'`).get(hash);
    if (row && row.expires_at > now) {
      req.user = { id: row.id, email: row.email, person_id: row.person_id };
      req.viaToken = true;
      db.prepare('UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE token_hash = ?').run(now + API_TOKEN_IDLE_MS, now, hash);
    }
  }
  next();
}

// トークンでできるのは、GET /api/me（誰としてのトークンか）だけ。退会・ログイン・パスワード・トークン自身は Cookie のログインだけ
function noToken(req, res, next) {
  if (!req.viaToken) return next();
  if (req.method === 'GET' && req.originalUrl.split('?')[0].replace(/\/+$/, '') === '/api/me') return next();
  res.status(403).json({ error: 'この操作は、トークンではできません' });
}

// Cookie からログイン中のユーザーを読み、req.user に入れる（なければ null）
function attachUser(req, res, next) {
  if (req.viaToken) return next(); // API トークンで認証済み（bearerAuth）。Cookie は見ない
  req.user = null;
  const token = readCookie(req, COOKIE);
  if (token) {
    const now = Date.now();
    const hash = S.sha256(token);
    const row = db.prepare(`SELECT s.expires_at, u.id, u.email, u.person_id
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.kind = 'web'`).get(hash);
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

// 人の選び方（既存の人 person_id か、新しい人 new_name/new_color）を検査する。通れば { personId, newName, newColor }、通らなければ { error }
function readPersonChoice(b) {
  if (b.person_id != null) {
    if (!Number.isInteger(b.person_id)) return { error: '人を選んでください' }; // 数値の整数だけ（true や [] や '1' は不可）
    const msg = personUnavailable(b.person_id);
    return msg ? { error: msg } : { personId: b.person_id, newName: null, newColor: null };
  }
  if (typeof b.new_name !== 'string') return { error: '名前を入力してください（20字まで）' };
  const newName = b.new_name.trim();
  if (!newName || newName.length > 20) return { error: '名前を入力してください（20字まで）' };
  if (b.new_color != null && typeof b.new_color !== 'string') return { error: '色の指定が正しくありません' };
  return { personId: null, newName, newColor: COLOR_RE.test(b.new_color) ? b.new_color : '#4f7cff' };
}

function signupMail(code) {
  const title = appTitle(); // メールは HTML ではないので、escape しない
  return {
    subject: `【${title}】確認コード`,
    text: `${title}の確認コードです。\n\n確認コード: ${code}\n\nこのコードは10分間有効です。心当たりがない場合は、このメールを無視してください。`,
  };
}

// メールを送る（または送ろうとする）要求ごとに 1つ数える。上限を超えていれば false を返し、何も数えない。
// 数えるのは、送信の直前まで進んだ要求だけ（入力の誤りなど、送らずに終わる要求は呼ばない）。
// 記録は「送った時刻」の配列。上限に達したら足さないので、IP ごとの配列も全体の配列も上限より長くならない。
// IP の Map は、記録を足せた（＝全体の上限の内側の）IP にしか作らず、1時間ごとに古いものをまとめて捨てる
const mailByIp = new Map();
let mailAll = [];
let mailSweptAt = 0;
function takeMailSlot(ip) {
  const now = Date.now();
  mailAll = mailAll.filter((t) => now - t < MAIL_GLOBAL_WINDOW_MS);
  const mine = (mailByIp.get(ip) || []).filter((t) => now - t < MAIL_IP_WINDOW_MS);
  const ok = mine.length < MAIL_IP_LIMIT && mailAll.length < MAIL_GLOBAL_LIMIT;
  if (ok) {
    mine.push(now);
    mailAll.push(now);
  }
  if (mine.length) mailByIp.set(ip, mine);
  else mailByIp.delete(ip);
  if (now - mailSweptAt >= MAIL_IP_WINDOW_MS) {
    mailSweptAt = now;
    for (const [k, times] of mailByIp) if (!times.some((t) => now - t < MAIL_IP_WINDOW_MS)) mailByIp.delete(k);
  }
  return ok;
}

// ---- /api/auth ----
const authRouter = express.Router();

authRouter.post('/signup', async (req, res) => {
  const b = req.body || {};
  if (typeof b.email !== 'string') return bad(res, 'メールアドレスの形式が正しくありません');
  const email = normEmail(b.email);
  if (!validEmail(email)) return bad(res, 'メールアドレスの形式が正しくありません');
  if (!validPassword(b.password)) return bad(res, 'パスワードは8文字以上128文字以下にしてください');
  cleanup();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'このメールアドレスは登録済みです');
  // cleanup() で期限切れは消えているので、行が残っていれば確認待ちの登録がまだ生きている。
  // 第三者がそれを上書きして、パスワードや紐付けをすり替えられないようにする（再送は /resend で）
  const prev = db.prepare('SELECT sent_at, browser_hash FROM pending_signups WHERE email = ?').get(email);
  if (prev) {
    // 申し込んだブラウザ自身が、もう一度送ってきたとき（戻るボタンや再読み込みなど）は、メールを送らず、何も数えず、続きの画面へ進ませる。
    // 申し込みの内容は、最初のまま（ここで書き換えると、Cookie を持っていれば何度でも scrypt を走らせられてしまう）
    const mine = readCookie(req, SIGNUP_COOKIE);
    if (mine && prev.browser_hash && S.safeEqualHex(S.sha256(mine), prev.browser_hash)) return res.json({ ok: true, resumed: true });
    if (Date.now() - prev.sent_at < RESEND_MS) return bad(res, '確認メールを送ったばかりです。1分ほど待ってからもう一度どうぞ', 429);
    return bad(res, PENDING_MSG);
  }

  // ここまでの検査を通った要求は、メールを送る。上限を超えていれば、行も作らず、メールも送らない
  if (!takeMailSlot(req.ip)) return bad(res, MAIL_CAP_MSG, 429);
  const code = S.newCode();
  const browserToken = S.newToken();
  const now = Date.now();
  // 人（既存の人か、新しい人）は、コードを確認したあとに選ぶ（/complete）。ここでは決めない
  db.prepare(`INSERT INTO pending_signups (email, password_hash, code_hash, expires_at, attempts, sent_at, browser_hash)
    VALUES (?, ?, ?, ?, 0, ?, ?)`)
    .run(email, S.hashPassword(b.password), S.sha256(code), now + CODE_MS, now, S.sha256(browserToken));
  try {
    await sendMail({ to: email, ...signupMail(code) });
  } catch (err) {
    db.prepare('DELETE FROM pending_signups WHERE email = ?').run(email);
    console.log('確認メールの送信に失敗:', err.message);
    return bad(res, 'メールを送れませんでした', 502);
  }
  // 送れたときだけ、この申し込みを結び付けるブラウザに Cookie を渡す。前の iruinai_signup は、これで置き換わる
  res.append('Set-Cookie', signupCookie(req, browserToken, SIGNUP_COOKIE_MS / 1000));
  res.json({ ok: true });
});

// 確認待ちは、本文のメールではなく、申し込んだブラウザの Cookie だけで決める（本文の email・password は読まない）。
// Cookie がない・合う行がないときは、何も数えずに断る
authRouter.post('/verify', (req, res) => {
  const code = String(req.body?.code ?? '').trim();
  const p = pendingOf(req);
  if (!p) return noPending(res);
  const email = p.email;
  const drop = () => db.prepare('DELETE FROM pending_signups WHERE email = ?').run(email);
  if (p.expires_at < Date.now()) {
    drop();
    res.append('Set-Cookie', signupCookie(req, '', 0));
    return bad(res, 'コードの有効期限が切れました。もう一度登録してください');
  }
  if (p.verified_at) return res.json({ ok: true, verified: true }); // 確認済み。人の選択へ（コードは見ない）
  // 間違いが続いた行は消さず、期限までロックしたまま残す（消すと sent_at も消え、すぐ登録し直してメールを送らせられる）
  if (p.attempts >= CODE_MAX_ATTEMPTS) return bad(res, LOCKED_MSG);
  const codeOk = S.safeEqualHex(S.sha256(code), p.code_hash) && /^\d{6}$/.test(code);
  if (!codeOk) {
    const attempts = p.attempts + 1;
    db.prepare('UPDATE pending_signups SET attempts = ? WHERE email = ?').run(attempts, email);
    return bad(res, attempts >= CODE_MAX_ATTEMPTS ? LOCKED_MSG : MISMATCH_MSG(CODE_MAX_ATTEMPTS - attempts));
  }
  // コードが合っただけでは、アカウントは作らない。確認済みの印を付け、人を選ぶ画面へ進ませる（/complete で人を選んで初めて登録が済む）。
  // 人を選ばないまま放っておくと、期限（PERSON_STEP_MS）で消える。ユーザーも人も作られない
  db.prepare('UPDATE pending_signups SET verified_at = ?, expires_at = ? WHERE email = ?').run(Date.now(), Date.now() + PERSON_STEP_MS, email);
  res.json({ ok: true, verified: true });
});

// 人を選んで、登録を完了する。確認コードを確認した（verified_at がある）このブラウザの行だけが対象
authRouter.post('/complete', (req, res) => {
  const p = pendingOf(req);
  if (!p) return noPending(res);
  const email = p.email;
  const drop = () => db.prepare('DELETE FROM pending_signups WHERE email = ?').run(email);
  if (p.expires_at < Date.now()) {
    drop();
    res.append('Set-Cookie', signupCookie(req, '', 0));
    return bad(res, '時間が過ぎました。もう一度登録してください');
  }
  if (!p.verified_at) return bad(res, NOT_VERIFIED_MSG);
  const choice = readPersonChoice(req.body || {});
  if (choice.error) return bad(res, choice.error); // 選び直せるように、行は残す
  let userId;
  try {
    inTransaction(() => {
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new UserError('このメールアドレスは登録済みです');
      let personId = choice.personId;
      if (personId != null) {
        const msg = personUnavailable(personId);
        if (msg) throw new UserError(msg);
      } else {
        personId = Number(db.prepare('INSERT INTO people (name, color) VALUES (?, ?)').run(choice.newName, choice.newColor).lastInsertRowid);
      }
      userId = Number(db.prepare('INSERT INTO users (email, password_hash, person_id, created_at) VALUES (?, ?, ?, ?)')
        .run(email, p.password_hash, personId, Date.now()).lastInsertRowid);
      drop();
    });
  } catch (err) {
    // その人が先に使われた・メールがすでに登録された、など。UserError は選び直せるよう、確認済みの行を残す
    if (err instanceof UserError) return bad(res, err.message);
    console.error('登録の完了中にエラー:', err);
    return bad(res, SERVER_ERROR_MSG, 500);
  }
  createSession(req, res, userId);
  res.append('Set-Cookie', signupCookie(req, '', 0)); // 登録が済んだので、申し込みの Cookie は要らない
  res.json({ user: publicUser(userId) });
});

// 登録をやめる（確認待ちを消す）。人を選ぶ画面の「やめる」から
authRouter.post('/cancel', (req, res) => {
  const p = pendingOf(req);
  if (p) db.prepare('DELETE FROM pending_signups WHERE email = ?').run(p.email);
  res.append('Set-Cookie', signupCookie(req, '', 0));
  res.json({ ok: true });
});

// 再送も、Cookie の行だけが対象（本文の email は読まない）
authRouter.post('/resend', async (req, res) => {
  const p = pendingOf(req);
  if (!p || p.expires_at < Date.now()) return noPending(res);
  const email = p.email;
  if (p.verified_at) return bad(res, '確認はすでに済んでいます。人を選んでください');
  // 間違いの回数は再送で戻さない。ロックされた行は、新しいコードを送っても使えるようにならないので、メールも送らない
  if (p.attempts >= CODE_MAX_ATTEMPTS) return bad(res, LOCKED_MSG);
  if (p.resend_count >= RESEND_MAX) return bad(res, RESEND_LIMIT_MSG, 429);
  const now = Date.now();
  if (now - p.sent_at < RESEND_MS) return bad(res, '再送は1分ほど空けてください', 429);
  if (!takeMailSlot(req.ip)) return bad(res, MAIL_CAP_MSG, 429); // ここまで通れば送る。上限を超えていれば、予約も書かない
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

// 申し込んだブラウザ（Cookie）の確認待ち。画面を開き直したあとに、コード入力の画面へ戻るために使う。
// Cookie がない・合う行がない・期限切れのときは null（メールアドレスなど、何も見せない）
authRouter.get('/pending', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const p = pendingOf(req);
  if (!p || p.expires_at < Date.now()) return res.json({ pending: null });
  res.json({
    pending: { email: p.email, expires_at: p.expires_at, resend_available_at: p.sent_at + RESEND_MS, locked: !p.verified_at && p.attempts >= CODE_MAX_ATTEMPTS, verified: !!p.verified_at },
  });
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
const tokenLimiter = failureLimiter(); // トークンの発行。キーはユーザー ID（退会と同じ理由）

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
  // 書式が正しい要求は、宛先が登録済みかどうかにかかわらず全部数える。上限を超えたら、誰に対しても同じ 429 を返す
  // （登録の有無は、応答からも、上限の減り方からも分からない）。書式が正しくない要求は、送る元になりえないので数えない
  if (validEmail(email) && !takeMailSlot(req.ip)) return bad(res, MAIL_CAP_MSG, 429);
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
      subject: `【${appTitle()}】パスワードの再設定`,
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

// ---- API トークン（Cookie のログインだけで使う。トークンからは noToken が止める） ----
const loginRequired = (res) => res.status(401).json({ error: 'ログインしてください', needLogin: true });

// 状態。本体は返さない（返せない: DB には SHA-256 しかない）。期限切れの行は「ない」として返す
meRouter.get('/token', (req, res) => {
  if (!req.user) return loginRequired(res);
  res.set('Cache-Control', 'no-store');
  const row = db.prepare("SELECT created_at, last_used_at, expires_at FROM sessions WHERE user_id = ? AND kind = 'api' AND expires_at > ?")
    .get(req.user.id, Date.now());
  res.json({ token: row ? { created_at: row.created_at, last_used_at: row.last_used_at, expires_at: row.expires_at } : null });
});

// 発行・再発行。パスワードが要る（退会と同じ作り）。本体が見えるのは、この応答だけ
meRouter.post('/token', (req, res) => {
  if (!req.user) return loginRequired(res);
  if (tokenLimiter.locked(req.user.id)) return bad(res, FAIL_LOCK_MSG, 429);
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length > 128 || !S.verifyPassword(password, u.password_hash)) {
    tokenLimiter.fail(req.user.id);
    return bad(res, 'パスワードが違います');
  }
  const token = API_TOKEN_PREFIX + S.newToken();
  const now = Date.now();
  const expires_at = now + API_TOKEN_IDLE_MS;
  inTransaction(() => {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'api'").run(req.user.id);
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, kind, created_at) VALUES (?, ?, ?, 'api', ?)")
      .run(S.sha256(token), req.user.id, expires_at, now);
  });
  res.set('Cache-Control', 'no-store');
  res.json({ token, created_at: now, expires_at });
});

// 失効。パスワードは要らない（無効にする方向の操作なので）。なくてもエラーにしない
meRouter.delete('/token', (req, res) => {
  if (!req.user) return loginRequired(res);
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'api'").run(req.user.id);
  res.json({ ok: true });
});

module.exports = { authRouter, meRouter, attachUser, bearerAuth, noToken, cleanup, destroySession, COOKIE, mailMode, configWarnings };
