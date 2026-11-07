// 反応（スタンプ・コメント）と、持ち主への通知の API
const express = require('express');
const { STAMP_IDS } = require('./stamps');

const COMMENT_MAX = 40; // 字（コードポイント）
const COMMENTS_PER_TARGET = 5; // 1 人が 1 つの対象に付けられる数
const WRITE_LIMIT = 30; // 1 人が 1 分に書き込める回数（追加と削除の合計）
const WRITE_WINDOW_MS = 60 * 1000;
const NOTIFY_MAX = 50;
const RATE_MSG = '少し待ってからやり直してください';
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.+Z-]*)?$/;

const TABLES = { stay: { table: 'stays', column: 'stay_id' }, memo: { table: 'memos', column: 'memo_id' } };

// コメントの本文を整える。空白と改行と制御文字は空白 1 つにまとめ、前後を落とす
function cleanComment(v) {
  return String(v).replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
}

// 1 人あたりの書き込み回数を、1 分ごとの窓で数える。古い記録は、窓が変わるたびにまとめて捨てる
function writeLimiter() {
  const seen = new Map();
  let sweptAt = 0;
  return function take(userId) {
    const now = Date.now();
    if (now - sweptAt >= WRITE_WINDOW_MS) {
      sweptAt = now;
      for (const [k, v] of seen) if (now - v.start >= WRITE_WINDOW_MS) seen.delete(k);
    }
    const w = seen.get(userId);
    if (!w || now - w.start >= WRITE_WINDOW_MS) { seen.set(userId, { start: now, count: 1 }); return true; }
    if (w.count >= WRITE_LIMIT) return false;
    w.count++;
    return true;
  };
}

function reactionsRouter(db) {
  const router = express.Router();
  const takeWrite = writeLimiter();
  const fail = (res, status, error) => res.status(status).json(status === 401 ? { error, needLogin: true } : { error });

  // 対象（予定かメモ）の持ち主の person_id（部屋のメモは null）。なければ undefined
  function findTarget(type, id) {
    const t = TABLES[type];
    const row = db.prepare(`SELECT id, person_id FROM ${t.table} WHERE id = ?`).get(id);
    return row ? { type, id: row.id, personId: row.person_id, column: t.column } : undefined;
  }
  const ownsTarget = (req, target) => !!req.user && target.personId !== null && target.personId === req.user.person_id;

  function itemOf(req, target, r) {
    const mine = !!req.user && r.user_id === req.user.id;
    return {
      id: r.id,
      kind: r.stamp !== null ? 'stamp' : 'comment',
      stamp: r.stamp,
      body: r.body,
      created_at: r.created_at,
      user: { person_id: r.person_id, name: r.name, color: r.color, icon_path: r.icon_path },
      mine,
      deletable: mine, // 消せるのは、した本人だけ（持ち主も消せない）
    };
  }
  const ITEM_SELECT = `SELECT r.id, r.user_id, r.stamp, r.body, r.created_at, p.id AS person_id, p.name, p.color, p.icon_path
    FROM reactions r JOIN users u ON u.id = r.user_id JOIN people p ON p.id = u.person_id`;

  // 期間内の予定・メモごとの要約。反応のない対象は含めない
  router.get('/reactions/summary', (req, res) => {
    const { from, to } = req.query;
    if (typeof from !== 'string' || typeof to !== 'string' || !DATE_RE.test(from) || !DATE_RE.test(to)) {
      return fail(res, 400, '入力が不正です');
    }
    const out = { stays: {}, memos: {} };
    for (const [type, key] of [['stay', 'stays'], ['memo', 'memos']]) {
      const { table, column } = TABLES[type];
      const rows = db.prepare(`SELECT r.${column} AS tid, r.user_id, r.stamp FROM reactions r
        JOIN ${table} t ON t.id = r.${column} WHERE t.end > ? AND t.start < ?`).all(from, to);
      for (const r of rows) {
        const e = out[key][r.tid] || (out[key][r.tid] = { stamps: {}, mine: [], comments: 0 });
        if (r.stamp === null) { e.comments++; continue; }
        e.stamps[r.stamp] = (e.stamps[r.stamp] || 0) + 1;
        if (req.user && r.user_id === req.user.id) e.mine.push(r.stamp);
      }
    }
    res.json(out);
  });

  router.get('/reactions/:type/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!TABLES[req.params.type] || !Number.isInteger(id)) return fail(res, 400, '入力が不正です');
    const target = findTarget(req.params.type, id);
    if (!target) return fail(res, 404, '見つかりません');
    const rows = db.prepare(`${ITEM_SELECT} WHERE r.${target.column} = ? ORDER BY r.id`).all(id);
    res.json(rows.map((r) => itemOf(req, target, r)));
  });

  router.post('/reactions', (req, res) => {
    if (!req.user) return fail(res, 401, 'ログインしてください');
    if (!takeWrite(req.user.id)) return fail(res, 429, RATE_MSG);
    const { type, id, stamp, body } = req.body || {};
    const hasStamp = stamp !== undefined && stamp !== null;
    const hasBody = body !== undefined && body !== null;
    if (!TABLES[type] || !Number.isInteger(id) || hasStamp === hasBody) return fail(res, 400, '入力が不正です');
    if (hasStamp && !(typeof stamp === 'string' && STAMP_IDS.includes(stamp))) return fail(res, 400, '入力が不正です');
    if (hasBody && typeof body !== 'string') return fail(res, 400, '入力が不正です');
    const target = findTarget(type, id);
    if (!target) return fail(res, 404, '見つかりません');
    if (ownsTarget(req, target)) return fail(res, 400, `自分の${type === 'stay' ? '予定' : 'メモ'}には反応できません`);

    let status = 201;
    let reactionId;
    if (hasStamp) {
      const r = db.prepare(`INSERT OR IGNORE INTO reactions (user_id, ${target.column}, stamp, created_at) VALUES (?, ?, ?, ?)`)
        .run(req.user.id, id, stamp, Date.now());
      if (r.changes === 0) {
        status = 200; // すでに付いている。そのまま返す
        reactionId = db.prepare(`SELECT id FROM reactions WHERE user_id = ? AND ${target.column} = ? AND stamp = ?`).get(req.user.id, id, stamp).id;
      } else {
        reactionId = Number(r.lastInsertRowid);
      }
    } else {
      const text = cleanComment(body);
      const len = [...text].length;
      if (len < 1 || len > COMMENT_MAX) return fail(res, 400, `コメントは1〜${COMMENT_MAX}字で書いてください`);
      const n = db.prepare(`SELECT COUNT(*) AS n FROM reactions WHERE user_id = ? AND ${target.column} = ? AND body IS NOT NULL`)
        .get(req.user.id, id).n;
      if (n >= COMMENTS_PER_TARGET) return fail(res, 400, `この${type === 'stay' ? '予定' : 'メモ'}へのコメントは${COMMENTS_PER_TARGET}件までです`);
      reactionId = Number(db.prepare(`INSERT INTO reactions (user_id, ${target.column}, body, created_at) VALUES (?, ?, ?, ?)`)
        .run(req.user.id, id, text, Date.now()).lastInsertRowid);
    }
    res.status(status).json(itemOf(req, target, db.prepare(`${ITEM_SELECT} WHERE r.id = ?`).get(reactionId)));
  });

  router.delete('/reactions/:id', (req, res) => {
    if (!req.user) return fail(res, 401, 'ログインしてください');
    if (!takeWrite(req.user.id)) return fail(res, 429, RATE_MSG);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return fail(res, 400, '入力が不正です');
    const r = db.prepare('SELECT id, user_id, stay_id, memo_id FROM reactions WHERE id = ?').get(id);
    if (!r) return fail(res, 404, '見つかりません');
    if (r.user_id !== req.user.id) return fail(res, 403, '他の人の反応は消せません'); // した本人だけ。予定の持ち主でも消せない
    db.prepare('DELETE FROM reactions WHERE id = ?').run(id);
    res.status(204).end();
  });

  // ---- 通知: 自分の予定・メモに、自分以外の人が付けた反応 ----
  // 部屋のメモ（持ち主なし）と、アカウントのない人の予定は、受け取る人がいないので対象外
  const MINE_FROM = `FROM reactions r
    LEFT JOIN stays s ON s.id = r.stay_id
    LEFT JOIN memos m ON m.id = r.memo_id
    WHERE r.user_id <> ? AND COALESCE(s.person_id, m.person_id) = ?`;

  function unreadOf(user) {
    const seen = db.prepare('SELECT reactions_seen_id AS id FROM users WHERE id = ?').get(user.id).id;
    return db.prepare(`SELECT COUNT(*) AS n ${MINE_FROM} AND r.id > ?`).get(user.id, user.person_id, seen).n;
  }

  router.get('/notifications', (req, res) => {
    if (!req.user) return fail(res, 401, 'ログインしてください');
    const me = db.prepare('SELECT name FROM people WHERE id = ?').get(req.user.person_id);
    const rows = db.prepare(`SELECT r.id, r.stamp, r.body, r.created_at, r.stay_id, r.memo_id,
        p.name AS from_name, p.color AS from_color, p.icon_path AS from_icon, s.start AS s_start, m.start AS m_start, m.title AS m_title
      FROM reactions r
      JOIN users u ON u.id = r.user_id JOIN people p ON p.id = u.person_id
      LEFT JOIN stays s ON s.id = r.stay_id
      LEFT JOIN memos m ON m.id = r.memo_id
      WHERE r.user_id <> ? AND COALESCE(s.person_id, m.person_id) = ?
      ORDER BY r.id DESC LIMIT ?`).all(req.user.id, req.user.person_id, NOTIFY_MAX);
    res.json({
      unread: unreadOf(req.user),
      items: rows.map((r) => {
        const isStay = r.stay_id !== null;
        return {
          id: r.id,
          kind: r.stamp !== null ? 'stamp' : 'comment',
          stamp: r.stamp,
          body: r.body,
          created_at: r.created_at,
          from: { name: r.from_name, color: r.from_color, icon_path: r.from_icon },
          target: {
            type: isStay ? 'stay' : 'memo',
            id: isStay ? r.stay_id : r.memo_id,
            date: (isStay ? r.s_start : r.m_start).slice(0, 10),
            label: isStay ? `${me.name}の在室` : r.m_title,
          },
        };
      }),
    });
  });

  // 既読を、自分宛ての最新の反応まで進める（戻さない）
  router.post('/notifications/seen', (req, res) => {
    if (!req.user) return fail(res, 401, 'ログインしてください');
    const max = db.prepare(`SELECT MAX(r.id) AS id ${MINE_FROM}`).get(req.user.id, req.user.person_id).id;
    if (max) db.prepare('UPDATE users SET reactions_seen_id = MAX(reactions_seen_id, ?) WHERE id = ?').run(max, req.user.id);
    res.json({ unread: unreadOf(req.user) });
  });

  return router;
}

module.exports = { reactionsRouter, cleanComment, COMMENT_MAX, COMMENTS_PER_TARGET, WRITE_LIMIT };
