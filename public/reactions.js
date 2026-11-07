// 反応（スタンプ・コメント）の画面。スペック: docs/superpowers/specs/2026-11-07-reactions-design.md
// app.js より先に読み込み、起動時に Reactions.init() で app.js の関数を受け取る。
// ユーザーの入力は innerHTML に入れない（textContent と createElement だけで組む）。
(function (root) {
  'use strict';

  // lib/stamps.js と同じ ID・順序（テストで一致を確かめる）
  const STAMPS = [
    { id: 'like', label: 'いいね' },
    { id: 'angry', label: 'おこ' },
    { id: 'sad', label: 'かなしい' },
    { id: 'thanks', label: 'ありがとう' },
    { id: 'otsu', label: 'おつかれ' },
    { id: 'laugh', label: 'わらい' },
  ];
  const COMMENT_MAX = 40;
  const POLL_MS = 30 * 1000;
  const BUBBLE_MS = 3000;
  const SOUND_KEY = 'iruinai.sound';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------- 内蔵のスタンプ絵（public/stamps/<id>.png がなければこれを使う） ----------
  // [タグ, 属性] の並び。顔の色だけがスタンプごとに違う
  const INK = '#5d4037';
  const line = (d) => ['path', { d, fill: 'none', stroke: INK, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }];
  const dot = (cx, cy) => ['circle', { cx, cy, r: 1.8, fill: INK }];
  const cheek = (cx) => ['circle', { cx, cy: 20, r: 2.6, fill: '#ff8a9a', opacity: 0.45 }];
  const FACES = {
    like: ['#ffd966', [line('M8.5 14.5q2.5-3.5 5 0'), line('M18.5 14.5q2.5-3.5 5 0'), line('M10.5 19.5q5.5 6 11 0'), cheek(7), cheek(25)]],
    angry: ['#ff8a80', [line('M7.5 9.5l6.5 3'), line('M24.5 9.5l-6.5 3'), dot(11, 16), dot(21, 16), line('M11 24q5-4.5 10 0')]],
    sad: ['#90caf9', [line('M8 11.5l5-2'), line('M24 11.5l-5-2'), dot(11, 15.5), dot(21, 15.5), line('M11 24q5-4.5 10 0'),
      ['path', { d: 'M23.5 18.5q2 3 0 4.5q-2-1.5 0-4.5z', fill: '#4fc3f7' }]]],
    thanks: ['#f8bbd0', [line('M8.5 15q2.5-3 5 0'), line('M18.5 15q2.5-3 5 0'), line('M12 20q4 4 8 0'), cheek(7), cheek(25),
      ['path', { d: 'M25 6.5q-1.8-2.2-3.2-.6q-1.3 1.7 3.2 4.6q4.5-2.9 3.2-4.6q-1.4-1.6-3.2.6z', fill: '#ef5350' }]]],
    otsu: ['#c5e1a5', [line('M8.5 14.5q2.5 2.8 5 0'), line('M18.5 14.5q2.5 2.8 5 0'), line('M12.5 22q3.5 2.5 7 0'),
      ['path', { d: 'M25 6q-2.6 3.4-1.2 4.8q2.2.8 2.6-1.4q.3-1.6-1.4-3.4z', fill: '#81d4fa' }]]],
    laugh: ['#ffcc80', [line('M8 11.5l5 3l-5 3'), line('M24 11.5l-5 3l5 3'),
      ['path', { d: 'M10 21q6 8 12 0z', fill: '#6d4c41', stroke: INK, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }]]],
  };

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    return el;
  }
  // 人のアイコン（丸）。画像があれば画像、なければ人の色と頭文字（app.js の avatar() と同じ見た目）
  function personAvatar(p) {
    const el = document.createElement('span');
    el.className = 'avatar';
    el.style.backgroundColor = p.color;
    if (p.icon_path) el.style.backgroundImage = `url("${String(p.icon_path).replace(/["\\\n\r]/g, '')}")`;
    else el.textContent = String(p.name || '?').slice(0, 1);
    return el;
  }
  function faceSvg(id) {
    const f = FACES[id];
    const svg = svgEl('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false' });
    svg.append(svgEl('circle', { cx: 16, cy: 16, r: 15, fill: f[0], stroke: 'rgba(0,0,0,.08)', 'stroke-width': 1 }));
    for (const [tag, attrs] of f[1]) svg.append(svgEl(tag, attrs));
    return svg;
  }

  // スタンプの要素。画像があればそれを、なければ（読み込みに失敗したら）内蔵の絵を出す
  function stampEl(id, size) {
    const wrap = document.createElement('span');
    wrap.className = 'stamp';
    if (size) wrap.style.setProperty('--stamp-size', `${size}px`);
    const label = (STAMPS.find((s) => s.id === id) || {}).label || id;
    wrap.title = label;
    if (!FACES[id]) { wrap.textContent = '?'; return wrap; }
    wrap.append(faceSvg(id));
    const img = new Image();
    img.alt = label;
    img.decoding = 'async';
    img.addEventListener('load', () => wrap.replaceChildren(img)); // 画像が読めたときだけ内蔵の絵と差し替える
    img.src = `/stamps/${id}.png`;
    return wrap;
  }

  // ---------- 音（音声ファイル /sounds/pop.wav を鳴らす） ----------
  // g にブラウザの window を渡す。Audio がなければ何もしない。
  // pop() は Promise<boolean>（鳴らせたら true）。ブラウザは、ページを開いてから最初の操作より前の再生を止める（play() が拒否される）ので、
  // そのときは false を返す。呼び出し側は、最初の操作のあとにもう一度鳴らす
  const POP_SRC = '/sounds/pop.wav';
  function makeSound(g, src = POP_SRC) {
    const AudioCtor = g && g.Audio;
    let audio = null;
    let muted = false;
    const load = () => {
      if (audio || !AudioCtor) return;
      try { audio = new AudioCtor(src); audio.preload = 'auto'; } catch { audio = null; }
    };
    return {
      setMuted(v) { muted = !!v; },
      isMuted() { return muted; },
      unlock() { load(); }, // 最初の操作で、先に読み込んでおく
      async pop() {
        if (muted) return false;
        load();
        if (!audio) return false;
        try {
          audio.currentTime = 0;
          await audio.play();
          return true;
        } catch { return false; } // 操作前の自動再生の制限・読み込み失敗など
      },
    };
  }

  // ---------- app.js から受け取るもの ----------
  let ctxApi = {
    api: null, // (method, url, body) => Promise
    getMe: () => null,
    getRange: () => null, // () => { from, to }（今の表示期間。ローカル時刻の ISO）
    gotoDate: () => {},
  };
  const sound = makeSound(typeof window !== 'undefined' ? window : null);
  const $ = (sel) => document.querySelector(sel);

  function init(c) { ctxApi = { ...ctxApi, ...c }; }

  // ---------- 反応欄 ----------
  // container に反応欄を描く。ownerPersonId は対象の持ち主（部屋のメモは null）。自分の対象には付けられない
  function mountPane(container, { type, id, ownerPersonId, onChange }) {
    let destroyed = false;
    let items = [];
    let busy = false;
    const me = () => ctxApi.getMe();
    const isOwn = () => !!me() && ownerPersonId !== null && ownerPersonId !== undefined && ownerPersonId === me().person_id;

    const root = document.createElement('div');
    root.className = 'rx-pane';
    container.replaceChildren(root);

    const errEl = document.createElement('p');
    errEl.className = 'error rx-error';
    errEl.setAttribute('role', 'status');

    function fail(err) {
      if (destroyed) return;
      errEl.textContent = err && err.message ? err.message : '反応を送れませんでした';
      if (err && err.status === 404 && onChange) onChange({ gone: true });
    }

    async function call(method, url, body) {
      // app.js の api() は Error しか返さないので、404 だけは文面で見分けず、サーバーの文言（見つかりません）で判定する
      try {
        return await ctxApi.api(method, url, body);
      } catch (err) {
        if (err && err.message === '見つかりません') err.status = 404;
        throw err;
      }
    }

    async function refresh() {
      try {
        items = await call('GET', `/api/reactions/${type}/${id}`);
        if (!destroyed) render();
      } catch (err) { fail(err); }
    }

    async function act(fn) {
      if (busy) return;
      busy = true;
      errEl.textContent = '';
      try { await fn(); } catch (err) { fail(err); }
      busy = false;
      await refresh();
      if (onChange && !destroyed) onChange({});
    }

    function render() {
      const children = [];
      const user = me();
      const own = isOwn();

      if (!user) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = '反応するにはログインしてください';
        children.push(p);
      } else if (!own) {
        const bar = document.createElement('div');
        bar.className = 'rx-stamps';
        for (const s of STAMPS) {
          const mineRow = items.find((x) => x.mine && x.stamp === s.id);
          const count = items.filter((x) => x.stamp === s.id).length;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'rx-stamp-btn';
          b.setAttribute('aria-pressed', mineRow ? 'true' : 'false');
          b.setAttribute('aria-label', `${s.label}${count ? `（${count}）` : ''}`);
          b.title = s.label;
          b.append(stampEl(s.id, 28));
          if (count) {
            const n = document.createElement('span');
            n.className = 'rx-count';
            n.textContent = String(count);
            b.append(n);
          }
          b.addEventListener('click', () => act(() => (mineRow
            ? call('DELETE', `/api/reactions/${mineRow.id}`)
            : call('POST', '/api/reactions', { type, id, stamp: s.id }))));
          bar.append(b);
        }
        children.push(bar);

        const form = document.createElement('form');
        form.className = 'rx-comment';
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = COMMENT_MAX;
        input.placeholder = `ひとこと（${COMMENT_MAX}字まで）`;
        input.setAttribute('aria-label', 'コメント');
        input.autocomplete = 'off';
        const left = document.createElement('span');
        left.className = 'rx-left';
        left.textContent = String(COMMENT_MAX);
        input.addEventListener('input', () => { left.textContent = String(COMMENT_MAX - [...input.value].length); });
        const send = document.createElement('button');
        send.type = 'submit';
        send.className = 'btn primary rx-send';
        send.textContent = '送る';
        form.append(input, left, send);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          act(async () => { await call('POST', '/api/reactions', { type, id, body: text }); input.value = ''; });
        });
        children.push(form);
      }

      const list = document.createElement('ul');
      list.className = 'rx-list';
      for (const r of items) {
        const li = document.createElement('li');
        li.className = 'rx-item';
        const dot = personAvatar(r.user);
        const who = document.createElement('span');
        who.className = 'rx-who';
        who.textContent = r.user.name;
        const what = r.kind === 'stamp' ? stampEl(r.stamp, 22) : document.createElement('span');
        if (r.kind === 'comment') { what.className = 'rx-body'; what.textContent = r.body; }
        li.append(dot, who, what);
        if (r.deletable) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'rx-del';
          del.textContent = '×';
          del.setAttribute('aria-label', 'この反応を消す');
          del.addEventListener('click', () => act(() => call('DELETE', `/api/reactions/${r.id}`)));
          li.append(del);
        }
        list.append(li);
      }
      if (!items.length && user && own) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = 'まだ反応はありません';
        children.push(p);
      }
      children.push(list, errEl);
      root.replaceChildren(...children);
    }

    render();
    refresh();
    return { refresh, destroy() { destroyed = true; container.replaceChildren(); } };
  }

  // ---------- カレンダー上の反応数 ----------
  let summary = { stays: {}, memos: {} };
  let summaryTimer = 0;
  let summarySeq = 0;

  function entryFor(eid) {
    if (!eid) return null;
    const bucket = eid[0] === 's' ? summary.stays : eid[0] === 'm' ? summary.memos : null;
    return bucket ? bucket[eid.slice(1)] || null : null;
  }
  function totalOf(e) {
    return e.comments + Object.values(e.stamps).reduce((a, b) => a + b, 0);
  }
  function decorateEl(el) {
    const old = el.querySelector(':scope > .rx-badge');
    if (old) old.remove();
    const e = entryFor(el.dataset.eid);
    if (!e) return;
    const n = totalOf(e);
    if (!n) return;
    const b = document.createElement('span');
    b.className = 'rx-badge';
    b.title = `反応 ${n}件`;
    const ico = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    ico.append(svgEl('path', { d: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', fill: 'currentColor' }));
    const t = document.createElement('span');
    t.textContent = String(n);
    b.append(ico, t);
    el.append(b);
  }
  function decorateAll() {
    document.querySelectorAll('#calendar [data-eid]').forEach(decorateEl);
  }
  // 今の表示期間の要約を取り直す（続けて呼ばれても 1 回にまとめる）
  function refreshSummary() {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(async () => {
      const range = ctxApi.getRange();
      if (!range || !ctxApi.api) return;
      const seq = ++summarySeq;
      try {
        const s = await ctxApi.api('GET', `/api/reactions/summary?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`);
        if (seq !== summarySeq) return; // もっと新しい取得が走っている
        summary = s;
        decorateAll();
      } catch { /* 要約が取れなくても予定は出す */ }
    }, 120);
  }

  // ---------- ベル・履歴・吹き出し ----------
  let items = [];
  let lastShownId = null; // これまでに見せた最大の反応 id。最初の取得で初期化するだけで、何も出さない
  let pollTimer = 0;
  let started = false;
  let panelOpen = false;

  const ago = (ms) => {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return 'たった今';
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}日前`;
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  function setBadge(n) {
    const badge = $('#bellBadge');
    const btn = $('#bellBtn');
    if (!badge || !btn) return;
    badge.hidden = n <= 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    btn.setAttribute('aria-label', n > 0 ? `通知（未読 ${n}件）` : '通知');
  }

  function renderList() {
    const ul = $('#bellList');
    if (!ul) return;
    ul.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'bell-empty';
      li.textContent = 'まだ反応はありません';
      ul.append(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bell-row' + (it.unread ? ' unread' : '');
      const dot = personAvatar(it.from); // 送った人のアイコン（丸）を左に
      const main = document.createElement('span');
      main.className = 'bell-main';
      const head = document.createElement('span');
      head.className = 'bell-head-line';
      const who = document.createElement('strong');
      who.textContent = it.from.name;
      head.append(who);
      if (it.kind === 'stamp') head.append(stampEl(it.stamp, 20));
      const when = document.createElement('span');
      when.className = 'bell-when';
      when.textContent = ago(it.created_at);
      head.append(when);
      main.append(head);
      if (it.kind === 'comment') {
        const body = document.createElement('span');
        body.className = 'bell-body';
        body.textContent = it.body;
        main.append(body);
      }
      const target = document.createElement('span');
      target.className = 'bell-target';
      target.textContent = `${it.target.date.slice(5).replace('-', '/')} ${it.target.label}`;
      main.append(target);
      b.append(dot, main);
      b.addEventListener('click', () => { closePanel(false); ctxApi.gotoDate(it.target.date); });
      li.append(b);
      ul.append(li);
    }
  }

  async function markSeen() {
    try {
      const r = await ctxApi.api('POST', '/api/notifications/seen');
      setBadge(r.unread);
    } catch { /* 次の取得でまた試す */ }
  }

  function openPanel() {
    const panel = $('#bellPanel');
    if (!panel) return;
    panelOpen = true;
    panel.hidden = false;
    $('#bellBtn').setAttribute('aria-expanded', 'true');
    // 開いた瞬間の未読を強調してから、既読にする
    renderList();
    panel.focus();
    markSeen();
    poll();
  }
  function closePanel(restoreFocus = true) {
    const panel = $('#bellPanel');
    if (!panel || !panelOpen) return;
    panelOpen = false;
    panel.hidden = true;
    const btn = $('#bellBtn');
    btn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) btn.focus();
    items = items.map((i) => ({ ...i, unread: false }));
  }

  function findEventEl(type, id) {
    return document.querySelector(`#calendar [data-eid="${type === 'stay' ? 's' : 'm'}${id}"]`);
  }

  // 新着の反応を、予定の上に吹き出しで出す。予定が画面に見えていないときは何も出さない（ベルの数だけ増える）。
  // wait: 開いた直後は予定がまだ描かれていないことがあるので、描かれるまで少し待つ
  // onShown(b): 吹き出しが実際に出た瞬間に呼ばれる。消すタイミングは、呼び出し側が決める（返り値が true ならそちらが消す）
  function showBubble(it, delay, wait = false, onShown = null) {
    const attempt = (n) => {
      const el = findEventEl(it.target.type, it.target.id);
      if (!el) { if (wait && n < 20) setTimeout(() => attempt(n + 1), 300); return; }
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth || (r.width === 0 && r.height === 0)) return;
      setTimeout(() => {
        const b = document.createElement('div');
        b.className = 'rx-bubble';
        b.setAttribute('role', 'status');
        b.append(it.kind === 'stamp' ? stampEl(it.stamp, 30) : Object.assign(document.createElement('span'), { className: 'rx-bubble-text', textContent: it.body }));
        const rect = el.getBoundingClientRect();
        b.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 60), window.innerWidth - 60)}px`;
        b.style.top = `${Math.max(rect.top, 8)}px`;
        document.body.append(b);
        if (!(onShown && onShown(b))) b._t = setTimeout(() => b.remove(), BUBBLE_MS);
      }, delay);
    };
    attempt(0);
  }

  // 吹き出しと音で知らせる。音は 1 回だけ。ブラウザが操作前の再生を止めているときは、最初の操作のあとに鳴らす
  // 音は、最初の吹き出しが実際に出た瞬間に鳴らす（吹き出しとそろう）。ブラウザが止めたときは、吹き出しを出したまま（最長 HOLD_MS）にして、
  // 最初の操作で鳴らし、そこから BUBBLE_MS で消す。操作がないまま音だけあとで鳴ったり、音のない吹き出しが消えたりしない
  const HOLD_MS = 20000;
  let pendingPop = false;
  const held = new Set();
  function holdBubble(b) {
    clearTimeout(b._t);
    held.add(b);
    b._t = setTimeout(() => { held.delete(b); b.remove(); }, HOLD_MS);
  }
  function releaseHeld() {
    for (const b of held) { clearTimeout(b._t); b._t = setTimeout(() => b.remove(), BUBBLE_MS); }
    held.clear();
  }
  function announce(list, opening) {
    const shown = [];
    let cued = false;
    const onShown = (b) => {
      shown.push(b);
      if (!cued) {
        cued = true;
        sound.pop().then((ok) => {
          if (ok) { pendingPop = false; releaseHeld(); return; }
          if (sound.isMuted()) return;
          pendingPop = true;
          shown.forEach((x) => { if (x.isConnected) holdBubble(x); });
        });
        return false;
      }
      if (pendingPop) { b._t = 0; holdBubble(b); return true; } // 止められている間に出る吹き出しも、音といっしょに消す
      return false;
    };
    list.forEach((it, i) => showBubble(it, i * (opening ? 800 : 450), opening, onShown));
  }

  async function poll() {
    if (!ctxApi.getMe() || !ctxApi.api) return;
    let data;
    try { data = await ctxApi.api('GET', '/api/notifications'); } catch { return; } // 取れなくても画面は壊さず、次の周期でやり直す
    const maxId = data.items.length ? data.items[0].id : 0;
    const prevMax = lastShownId;
    // 未読の行は、サーバーの未読数の分だけ新しい側から数える。パネルを開いている間は、すでに分かっている印を保つ
    const flags = new Map(items.map((i) => [i.id, i.unread]));
    items = data.items.map((it, idx) => ({ ...it, unread: panelOpen ? (flags.has(it.id) ? flags.get(it.id) : true) : idx < data.unread }));
    setBadge(panelOpen ? 0 : data.unread);
    if (panelOpen) { renderList(); if (data.unread > 0) markSeen(); }
    if (prevMax === null) {
      // 開いた直後: まだ見ていない（未読の）反応を、この端末でまだ見せていないものだけ、吹き出しと音で出す
      lastShownId = maxId;
      const stored = readShown();
      writeShown(maxId);
      const unseen = data.items.slice(0, data.unread).filter((i) => i.id > stored).reverse();
      if (unseen.length) announce(unseen.slice(-5), true);
      return;
    }
    const fresh = data.items.filter((i) => i.id > prevMax).reverse();
    if (!fresh.length) return;
    lastShownId = Math.max(prevMax, maxId);
    writeShown(lastShownId);
    announce(fresh.slice(-3), false); // 1 回の取得につき、音は 1 回だけ
    refreshSummary();
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') poll();
  }

  function startNotifications() {
    const btn = $('#bellBtn');
    if (btn) btn.hidden = false;
    if (started) return;
    started = true;
    lastShownId = null;
    poll();
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') poll(); }, POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
  }
  function stopNotifications() {
    const btn = $('#bellBtn');
    if (btn) btn.hidden = true;
    closePanel(false);
    setBadge(0);
    items = [];
    if (!started) return;
    started = false;
    clearInterval(pollTimer);
    document.removeEventListener('visibilitychange', onVisibility);
  }
  // app.js の loadMe() から、ログイン状態が分かるたびに呼ぶ
  function onMe(user) { if (user) startNotifications(); else stopNotifications(); }

  // ---------- 画面の部品をつなぐ（DOM があるときだけ） ----------
  function readSoundPref() {
    try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
  }
  function writeSoundPref(on) {
    try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* 保存できなくても動く */ }
  }

  // 画面を開いたときに見せた反応の最大 id（ユーザーごと）。同じ端末で開き直しても、同じ反応をもう一度は出さない
  const shownKey = () => `iruinai.shown.${(ctxApi.getMe() || {}).id}`;
  function readShown() {
    try { return Number(localStorage.getItem(shownKey())) || 0; } catch { return 0; }
  }
  function writeShown(id) {
    try { localStorage.setItem(shownKey(), String(id)); } catch { /* 保存できなくても動く */ }
  }

  function wire() {
    const btn = $('#bellBtn');
    const panel = $('#bellPanel');
    if (!btn || !panel) return;
    const toggle = $('#soundToggle');
    const on = readSoundPref();
    toggle.checked = on;
    sound.setMuted(!on);
    toggle.addEventListener('change', () => { sound.setMuted(!toggle.checked); writeSoundPref(toggle.checked); });
    btn.addEventListener('click', () => (panelOpen ? closePanel() : openPanel()));
    $('#bellClose').addEventListener('click', () => closePanel());
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } });
    document.addEventListener('pointerdown', (e) => {
      if (panelOpen && !panel.contains(e.target) && !btn.contains(e.target)) closePanel(false);
    });
    // 音は、最初の操作のあとから鳴らせる（ブラウザの自動再生の制限）
    const unlock = () => {
      sound.unlock();
      if (pendingPop) sound.pop().then((ok) => { if (ok || sound.isMuted()) { pendingPop = false; releaseHeld(); } }); // 操作の中で呼ぶので、再生が許される
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }

  const api = {
    personAvatar, STAMPS, init, stampEl, mountPane, refreshSummary, decorateEl, onMe, startNotifications, stopNotifications, makeSound,
  };
  if (typeof document !== 'undefined' && document.getElementById) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }
  root.Reactions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
