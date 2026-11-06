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
