let people = [];
const ROOM = 'room'; // 部屋のメモを表すキー
const hidden = new Set(); // 非表示中の person_id（部屋は ROOM）
let locked = true; // 誤操作を防ぐため、ページを開いたときは必ずロックから始める
let calendar;

const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const toDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toLocalIso = (d) => `${toDate(d)}T${toTime(d)}:00`;

async function api(method, url, body) {
  const opts = { method };
  if (body instanceof FormData) opts.body = body;
  else if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = '/login'; throw new Error('ログインしてください'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '保存に失敗しました');
  return res.status === 204 ? null : res.json();
}

// アイコン要素（画像なしは頭文字＋色）
function avatar(p, cls = '') {
  const el = document.createElement('span');
  el.className = 'avatar ' + cls;
  el.style.backgroundColor = p.color;
  if (p.icon_path) el.style.backgroundImage = `url("${p.icon_path}")`;
  else el.textContent = p.name.slice(0, 1);
  return el;
}

const personById = (id) => people.find((p) => p.id === id);

// 線画アイコン（絵文字は使わない）
const ICONS = {
  room: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
};
function icon(name) {
  const el = document.createElement('span');
  el.className = 'ico-wrap';
  el.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return el;
}

// 部屋のアイコン（人のアバターと同じ丸）
function roomAvatar(cls = '') {
  const el = document.createElement('span');
  el.className = 'avatar room ' + cls;
  el.append(icon('room'));
  return el;
}

// #rrggbb を白と混ぜて薄くする（a = 元の色の割合）
function tint(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c * a + 255 * (1 - a));
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toDate(d);
};

// ---------- 元に戻す ----------
// この端末でした変更を新しい順に覚えておき、逆の操作で戻す（再読み込みすると消える）
const undoStack = [];
const UNDO_MAX = 30;
let undoBusy = false;
let toastTimer;

function showToast(text, withUndo) {
  $('#toastText').textContent = text;
  $('#toastUndo').hidden = !withUndo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000);
}

function renderUndoBtn() {
  const last = undoStack[undoStack.length - 1];
  $('#undoBtn').disabled = locked || !last;
  $('#undoBtn').title = last ? `元に戻す：${last.label}（Ctrl+Z）` : '元に戻せる操作はありません';
}

// label: 「在室を移動しました」など。undo: 逆の操作
function pushUndo(label, undo) {
  undoStack.push({ label, undo });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  renderUndoBtn();
  showToast(label, true);
}

async function undoLast() {
  if (!requireUnlocked()) return;
  if (undoBusy || !undoStack.length) return;
  undoBusy = true;
  const { label, undo } = undoStack.pop();
  try {
    await undo();
    showToast(`元に戻しました（${label.replace(/しました$/, '')}）`, false);
  } catch (err) {
    showToast(`元に戻せませんでした：${err.message}`, false);
  } finally {
    undoBusy = false;
    renderUndoBtn();
    await loadPeople();
    calendar.refetchEvents();
  }
}

$('#undoBtn').addEventListener('click', undoLast);
$('#toastUndo').addEventListener('click', undoLast);
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
  // 入力中の文字の取り消しやダイアログの操作はじゃましない
  if (document.querySelector('dialog[open]') || e.target.closest('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  undoLast();
});

// ---------- 印刷 ----------
// 画面用に固定した高さを外し、紙の大きさに合わせて描き直す
function preparePrint() {
  $('#printTitle').textContent = calendar.view.title;
  calendar.setOption('height', 'auto');
  calendar.setOption('dayMaxEvents', false);
  calendar.updateSize();
}
function restoreAfterPrint() {
  applyHeight(calendar.view.type);
  calendar.updateSize();
}
function printCalendar() {
  preparePrint();
  window.print();
}
window.addEventListener('beforeprint', preparePrint);
window.addEventListener('afterprint', restoreAfterPrint);
$('#printBtn').addEventListener('click', printCalendar);
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'p') return;
  // ダイアログを開いている間はブラウザ標準の印刷に任せる
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  printCalendar();
});

// ---------- ロック ----------
// ロック中は表示・CSV出力・印刷だけ使える。解除して5分操作がなければ自動でロックに戻す
const AUTO_LOCK_MS = 5 * 60 * 1000;
let lockTimer;

function requireUnlocked() {
  if (!locked) return true;
  showToast('ロック中です。鍵のボタンを押すと編集できます', false);
  return false;
}

function armAutoLock() {
  clearTimeout(lockTimer);
  if (!locked) lockTimer = setTimeout(autoLock, AUTO_LOCK_MS);
}

function autoLock() {
  // 入力の途中で消えてしまわないよう、ダイアログを閉じるまで待つ
  if (document.querySelector('dialog[open]')) { lockTimer = setTimeout(autoLock, 60 * 1000); return; }
  setLocked(true);
  showToast('操作がなかったので、自動でロックしました', false);
}

function setLocked(v) {
  locked = v;
  document.body.classList.toggle('locked', v);
  if (calendar) {
    calendar.setOption('editable', !v);
    calendar.setOption('selectable', !v);
  }
  const label = v ? 'ロック中（押すと編集できます）' : '編集できます（押すとロックします）';
  const btn = $('#lockBtn');
  btn.setAttribute('aria-pressed', String(!v));
  btn.title = label;
  btn.setAttribute('aria-label', label);
  $('#importBtn').disabled = v;
  $('#addPersonBtn').disabled = v;
  renderUndoBtn();
  armAutoLock();
}

$('#lockBtn').addEventListener('click', () => {
  setLocked(!locked);
  showToast(locked ? 'ロックしました' : 'ロックを解除しました（5分操作がないと自動でロックします）', false);
});
['pointerdown', 'keydown', 'wheel'].forEach((t) =>
  document.addEventListener(t, armAutoLock, { capture: true, passive: true }));

// スマホ：ヘッダーの機能は「…」メニューに格納
function setMenu(open) {
  $('#actionMenu').classList.toggle('open', open);
  $('#menuBtn').setAttribute('aria-expanded', String(open));
}
$('#menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(!$('#actionMenu').classList.contains('open'));
});
$('#actionMenu').addEventListener('click', () => setMenu(false));
document.addEventListener('click', (e) => { if (!e.target.closest('.top-actions')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

// 変更前の在室・メモに書き戻す（相手が消されていたら知らせる）
const putBack = (kind, row) => {
  const { id, before, ...body } = row;
  return api('PUT', `/api/${kind}/${id}`, body).catch((err) => {
    throw err.message === 'not found' ? new Error('すでに削除されています') : err;
  });
};

// ---------- 上部の人一覧 ----------
function renderPeople() {
  const box = $('#people');
  box.replaceChildren();
  // 部屋チップ：部屋のメモの表示/非表示
  const room = document.createElement('div');
  room.className = 'person-chip room-chip' + (hidden.has(ROOM) ? ' off' : '');
  room.title = 'クリックで部屋のメモを表示/非表示';
  room.append(roomAvatar(), '部屋');
  room.onclick = () => {
    hidden.has(ROOM) ? hidden.delete(ROOM) : hidden.add(ROOM);
    renderPeople();
    calendar.refetchEvents();
  };
  box.append(room);
  for (const p of people) {
    const chip = document.createElement('div');
    chip.className = 'person-chip' + (hidden.has(p.id) ? ' off' : '');
    chip.style.borderColor = p.color;
    chip.title = 'クリックで表示/非表示';
    chip.append(avatar(p), p.name);
    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.append(icon('pencil'));
    edit.title = '編集';
    edit.onclick = (e) => { e.stopPropagation(); if (requireUnlocked()) openPersonDialog(p); };
    chip.append(edit);
    chip.onclick = () => {
      hidden.has(p.id) ? hidden.delete(p.id) : hidden.add(p.id);
      renderPeople();
      calendar.refetchEvents();
    };
    box.append(chip);
  }
}

async function loadPeople() {
  people = await api('GET', '/api/people');
  renderPeople();
}

// ---------- カレンダー ----------
const isMobile = () => window.matchMedia('(max-width: 600px)').matches;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function initCalendar() {
  calendar = new FullCalendar.Calendar($('#calendar'), {
    locale: 'ja',
    initialView: 'dayGridMonth',
    headerToolbar: { left: 'prev,today,next', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' },
    buttonText: { today: '今日', month: '月', week: '週', day: '日' },
    height: 'auto',
    nowIndicator: true,
    allDayText: '終日',
    scrollTime: '08:00:00',
    slotDuration: '00:30:00',
    snapDuration: '00:15:00',
    dayMaxEvents: 4,
    eventDisplay: 'block',
    displayEventEnd: true,
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    slotEventOverlap: false, // 重ねずに横並び
    selectable: !locked,
    editable: !locked,
    selectLongPressDelay: 300,
    eventLongPressDelay: 400,
    // 日付は数字だけ（「日」を付けない）
    // 週・日の終日欄には日付を出さない
    dayCellContent: (arg) => ({ html: arg.view.type === 'dayGridMonth' ? String(arg.date.getDate()) : '' }),
    // 週・日の見出しは「曜日／日付」の2段
    dayHeaderContent: (arg) => {
      if (arg.view.type === 'dayGridMonth') return WEEKDAYS[arg.date.getDay()];
      const wrap = document.createElement('div');
      wrap.className = 'dh';
      const w = document.createElement('span');
      w.className = 'dh-w';
      w.textContent = WEEKDAYS[arg.date.getDay()];
      const d = document.createElement('span');
      d.className = 'dh-d';
      d.textContent = arg.view.type === 'timeGridDay' || !isMobile()
        ? `${arg.date.getMonth() + 1}/${arg.date.getDate()}` : arg.date.getDate();
      wrap.append(w, d);
      return { domNodes: [wrap] };
    },
    // スマホの月表示：日付タップでその日の表示へ
    dateClick: (info) => {
      if (isMobile() && info.view.type === 'dayGridMonth') calendar.changeView('timeGridDay', info.date);
    },
    eventSources: [
      // 在室
      async (info) => {
        const stays = await api('GET', `/api/stays?${rangeQuery(info)}`);
        return stays
          .filter((st) => personById(st.person_id) && !hidden.has(st.person_id))
          .map((st) => {
            const p = personById(st.person_id);
            return {
              id: 's' + st.id, start: st.start, end: st.end,
              backgroundColor: p.color, borderColor: p.color,
              extendedProps: { kind: 'stay', stay: st },
            };
          });
      },
      // メモ（人のメモは人の色を薄く、部屋のメモはグレー）
      async (info) => {
        const memos = await api('GET', `/api/memos?${rangeQuery(info)}`);
        return memos
          .filter((m) => (m.person_id === null ? !hidden.has(ROOM) : personById(m.person_id) && !hidden.has(m.person_id)))
          .map((m) => {
            const p = m.person_id === null ? null : personById(m.person_id);
            return {
              id: 'm' + m.id, start: m.start, end: m.end, allDay: !!m.all_day,
              backgroundColor: p ? tint(p.color, 0.22) : '#eef0f3',
              borderColor: p ? p.color : '#8a919c',
              textColor: '#1f2328',
              classNames: ['memo-event'],
              extendedProps: { kind: 'memo', memo: m },
            };
          });
      },
    ],
    // 祝日は赤、日曜・土曜は CSS（fc-day-sun / fc-day-sat）で色付け
    dayCellClassNames: (arg) => (holidayName(arg.date) ? ['holiday'] : []),
    dayHeaderClassNames: (arg) => (holidayName(arg.date) ? ['holiday'] : []),
    dayCellDidMount: (arg) => {
      const name = holidayName(arg.date);
      const top = arg.el.querySelector('.fc-daygrid-day-top');
      if (!name || !top || arg.view.type !== 'dayGridMonth') return;
      const label = document.createElement('span');
      label.className = 'holiday-name';
      label.textContent = name;
      top.prepend(label);
    },
    datesSet: (info) => {
      if (!calendar) return;
      const before = calendar.getOption('height');
      applyHeight(info.view.type);
      if (info.view.type !== 'dayGridMonth' && before !== calendar.getOption('height')) {
        setTimeout(() => calendar.scrollToTime('08:00:00'));
      }
    },
    windowResize: (arg) => applyHeight(arg.view.type),
    eventContent: (arg) => {
      if (arg.event.extendedProps.kind === 'memo') return memoContent(arg);
      const st = arg.event.extendedProps.stay;
      const p = personById(st.person_id);
      const wrap = document.createElement('div');
      wrap.className = 'stay';
      const head = document.createElement('div');
      head.className = 'stay-head';
      const name = document.createElement('span');
      name.className = 't';
      if (arg.view.type === 'dayGridMonth') {
        name.textContent = `${arg.timeText} ${p.name}${st.note ? '・' + st.note : ''}`;
        head.append(avatar(p, 'small'), name);
        wrap.append(head);
      } else {
        // 週・日：名前／時間／メモを縦に
        name.textContent = p.name;
        head.append(avatar(p, 'small'), name);
        const time = document.createElement('div');
        time.className = 'stay-time';
        time.textContent = arg.timeText;
        wrap.append(head, time);
        if (st.note) {
          const note = document.createElement('div');
          note.className = 'stay-note';
          note.textContent = st.note;
          wrap.append(note);
        }
      }
      return { domNodes: [wrap] };
    },
    select: (info) => {
      calendar.unselect();
      if (!requireUnlocked()) return;
      let start = info.start;
      let end = info.end;
      const dates = [];
      // 週・日の終日欄を選んだときは終日メモ
      if (info.allDay && info.view.type !== 'dayGridMonth') {
        for (const d = new Date(info.start); d < info.end; d.setDate(d.getDate() + 1)) dates.push(toDate(d));
        openMemoDialog(null, { dates, allDay: true, startTime: '09:00', endTime: '10:00' });
        return;
      }
      if (info.allDay) {
        // 月表示で日付クリック／ドラッグ：選んだ日すべてに 9:00-18:00 を初期値
        for (const d = new Date(info.start); d < info.end; d.setDate(d.getDate() + 1)) dates.push(toDate(d));
        start = new Date(info.start); start.setHours(9, 0, 0, 0);
        end = new Date(info.start); end.setHours(18, 0, 0, 0);
      }
      openStayDialog(null, start, end, dates);
    },
    eventClick: (info) => {
      if (!requireUnlocked()) return;
      const { kind, stay, memo } = info.event.extendedProps;
      if (kind === 'memo') return openMemoDialog(memo);
      openStayDialog(stay, new Date(stay.start), new Date(stay.end));
    },
    eventChange: async (info) => {
      const ev = info.event;
      const { kind, stay, memo } = ev.extendedProps;
      try {
        if (kind === 'memo') {
          let start;
          let end;
          if (ev.allDay) {
            start = toDate(ev.start);
            end = ev.end ? toDate(ev.end) : addDays(start, 1);
          } else {
            start = toLocalIso(ev.start);
            end = toLocalIso(ev.end || new Date(ev.start.getTime() + 60 * 60 * 1000));
          }
          const r = await api('PUT', `/api/memos/${memo.id}`, { start, end, all_day: ev.allDay });
          pushUndo('メモを動かしました', () => putBack('memos', r.before));
        } else {
          // 在室は終日にしない
          if (ev.allDay || !ev.end) { info.revert(); return; }
          const r = await api('PUT', `/api/stays/${stay.id}`, { start: toLocalIso(ev.start), end: toLocalIso(ev.end) });
          pushUndo(`${personById(r.person_id)?.name || ''}の在室を動かしました`, () => putBack('stays', r.before));
        }
        calendar.refetchEvents();
      } catch (err) {
        alert(err.message);
        info.revert();
      }
    },
  });
  calendar.render();
}

// カレンダーの高さ
// PC：画面の高さぴったり（ページはスクロールしない。極端に小さい画面だけ 400px を下限に）
// スマホ：月は中身に合わせる、週・日は 720px でスクロール
function calendarHeight(viewType) {
  if (isMobile()) return viewType === 'dayGridMonth' ? 'auto' : 720;
  const el = $('#calendar'); // height は余白・枠込みの高さとして効く
  const top = el.getBoundingClientRect().top + window.scrollY;
  const bottomGap = parseFloat(getComputedStyle(el.parentElement).paddingBottom);
  return Math.max(400, Math.floor(window.innerHeight - top - bottomGap));
}

function applyHeight(viewType) {
  const h = calendarHeight(viewType);
  if (calendar.getOption('height') !== h) calendar.setOption('height', h);
  // PC の月表示はマスの高さに入るだけ予定を出す
  const max = isMobile() ? 4 : true;
  if (calendar.getOption('dayMaxEvents') !== max) calendar.setOption('dayMaxEvents', max);
}

const rangeQuery = (info) =>
  `start=${encodeURIComponent(info.startStr.slice(0, 19))}&end=${encodeURIComponent(info.endStr.slice(0, 19))}`;

// メモの表示：アイコン＋内容（時間指定は時間も）
function memoContent(arg) {
  const m = arg.event.extendedProps.memo;
  const p = m.person_id === null ? null : personById(m.person_id);
  const wrap = document.createElement('div');
  wrap.className = 'memo';
  const head = document.createElement('div');
  head.className = 'stay-head';
  const text = document.createElement('span');
  text.className = 'mt';
  const timed = !arg.event.allDay;
  // 月表示の時間指定は時間も付ける（スマホは狭いので内容だけ）
  text.textContent = timed && arg.view.type === 'dayGridMonth' && !isMobile() ? `${arg.timeText} ${m.title}` : m.title;
  head.append(p ? avatar(p, 'small') : roomAvatar('small'), text);
  wrap.append(head);
  if (timed && arg.view.type !== 'dayGridMonth') {
    const time = document.createElement('div');
    time.className = 'stay-time';
    time.textContent = arg.timeText;
    wrap.append(time);
  }
  return { domNodes: [wrap] };
}

// ---------- 在室ダイアログ ----------
let editingStay = null;
let pickedPerson = null;

function renderPicker() {
  const box = $('#personPicker');
  box.replaceChildren();
  for (const p of people) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = p.id === pickedPerson ? 'selected' : '';
    b.append(avatar(p), p.name);
    b.onclick = () => { pickedPerson = p.id; renderPicker(); };
    box.append(b);
  }
}

// ---------- 複数日選択のミニカレンダー ----------
let selectedDates = new Set();
let miniMonth = new Date();
let miniTarget = { cal: '#miniCal', count: '#dateCount' }; // 在室とメモで描画先を切り替える

function renderMiniCal() {
  const box = $(miniTarget.cal);
  box.replaceChildren();
  const y = miniMonth.getFullYear();
  const m = miniMonth.getMonth();

  const head = document.createElement('div');
  head.className = 'mc-head';
  const prev = Object.assign(document.createElement('button'), { type: 'button', textContent: '‹', className: 'mc-nav' });
  const next = Object.assign(document.createElement('button'), { type: 'button', textContent: '›', className: 'mc-nav' });
  const title = Object.assign(document.createElement('span'), { textContent: `${y}年${m + 1}月` });
  prev.onclick = () => { miniMonth = new Date(y, m - 1, 1); renderMiniCal(); };
  next.onclick = () => { miniMonth = new Date(y, m + 1, 1); renderMiniCal(); };
  head.append(prev, title, next);

  const grid = document.createElement('div');
  grid.className = 'mc-grid';
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  WEEKDAYS.forEach((w, i) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: w, className: 'mc-w' });
    if (i === 0) b.classList.add('sun');
    if (i === 6) b.classList.add('sat');
    // 曜日タップ：この月の同じ曜日を全部選択（全部選択済みなら解除）
    b.onclick = () => {
      const keys = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(y, m, d);
        if (dt.getDay() === i) keys.push(toDate(dt));
      }
      const allOn = keys.every((k) => selectedDates.has(k));
      keys.forEach((k) => (allOn ? selectedDates.delete(k) : selectedDates.add(k)));
      renderMiniCal();
    };
    grid.append(b);
  });
  for (let i = 0; i < new Date(y, m, 1).getDay(); i++) grid.append(document.createElement('span'));
  const today = toDate(new Date());
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(y, m, d);
    const key = toDate(dt);
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: d, className: 'mc-d' });
    if (dt.getDay() === 0 || holidayName(dt)) b.classList.add('sun');
    else if (dt.getDay() === 6) b.classList.add('sat');
    if (key === today) b.classList.add('today');
    if (selectedDates.has(key)) b.classList.add('on');
    b.onclick = () => {
      selectedDates.has(key) ? selectedDates.delete(key) : selectedDates.add(key);
      renderMiniCal();
    };
    grid.append(b);
  }
  box.append(head, grid);
  $(miniTarget.count).textContent = selectedDates.size ? `${selectedDates.size}日 選択中` : '';
}

$('#clearDates').addEventListener('click', () => { selectedDates.clear(); renderMiniCal(); });
$('#memoClearDates').addEventListener('click', () => { selectedDates.clear(); renderMiniCal(); });

function openStayDialog(stay, start, end, dates = []) {
  if (!people.length) {
    alert('先に「＋ 人を追加」で人を登録してください');
    return;
  }
  editingStay = stay;
  pickedPerson = stay ? stay.person_id : (people.length === 1 ? people[0].id : null);
  const f = $('#stayForm');
  $('#stayTitle').textContent = stay ? '在室を編集' : '在室を追加';
  f.date.value = toDate(start);
  // 新規は複数日選択、編集は1日だけ
  $('#singleDate').hidden = !stay;
  $('#multiDate').hidden = !!stay;
  f.date.required = !!stay;
  $('#stayTabs').hidden = !!stay;
  selectedDates = new Set(dates.length ? dates : [toDate(start)]);
  miniMonth = new Date(start.getFullYear(), start.getMonth(), 1);
  miniTarget = { cal: '#miniCal', count: '#dateCount' };
  renderMiniCal();
  f.startTime.value = toTime(start);
  // 日をまたぐ選択は終了を 23:59 に丸める
  f.endTime.value = toDate(end) === toDate(start) ? toTime(end) : '23:59';
  f.note.value = stay ? stay.note : '';
  $('#stayDelete').hidden = !stay;
  $('#stayError').textContent = '';
  renderPicker();
  $('#stayDialog').showModal();
}

$('#stayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!pickedPerson) { $('#stayError').textContent = 'だれか選んでください'; return; }
  if (f.startTime.value >= f.endTime.value) { $('#stayError').textContent = '終了は開始より後にしてください'; return; }
  if (!editingStay && !selectedDates.size) { $('#stayError').textContent = '日付を選んでください'; return; }
  try {
    if (editingStay) {
      const r = await api('PUT', `/api/stays/${editingStay.id}`, {
        person_id: pickedPerson,
        start: `${f.date.value}T${f.startTime.value}:00`,
        end: `${f.date.value}T${f.endTime.value}:00`,
        note: f.note.value.trim(),
      });
      pushUndo(`${personById(r.before.person_id)?.name || ''}の在室を変更しました`, () => putBack('stays', r.before));
    } else {
      const r = await api('POST', '/api/stays/batch', {
        person_id: pickedPerson,
        dates: [...selectedDates].sort(),
        startTime: f.startTime.value,
        endTime: f.endTime.value,
        note: f.note.value.trim(),
      });
      pushUndo(`在室を${r.created}件追加しました`, () => api('POST', '/api/stays/remove', { ids: r.ids }));
    }
    $('#stayDialog').close();
    calendar.refetchEvents();
  } catch (err) {
    $('#stayError').textContent = err.message;
  }
});

$('#stayDelete').addEventListener('click', async () => {
  if (!editingStay || !confirm('この在室を削除しますか？')) return;
  const deleted = await api('DELETE', `/api/stays/${editingStay.id}`);
  $('#stayDialog').close();
  if (deleted) pushUndo('在室を削除しました', () => api('POST', '/api/stays/restore', { items: [deleted] }));
  calendar.refetchEvents();
});

// ---------- メモダイアログ ----------
let editingMemo = null;
let memoTarget = ROOM;

function renderMemoPicker() {
  const box = $('#memoPicker');
  box.replaceChildren();
  const room = document.createElement('button');
  room.type = 'button';
  room.className = memoTarget === ROOM ? 'selected' : '';
  room.append(roomAvatar(), '部屋');
  room.onclick = () => { memoTarget = ROOM; renderMemoPicker(); };
  box.append(room);
  for (const p of people) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = p.id === memoTarget ? 'selected' : '';
    b.append(avatar(p), p.name);
    b.onclick = () => { memoTarget = p.id; renderMemoPicker(); };
    box.append(b);
  }
}

// 終日の切替・新規/編集で入力欄の出し分け
function updateMemoFields() {
  const f = $('#memoForm');
  const allDay = f.allDay.checked;
  // 新規の終日だけミニカレンダーで複数日選択。それ以外は開始〜終了（時間指定は日付＋時間）
  const multi = !editingMemo && allDay;
  $('#memoMulti').hidden = !multi;
  $('#memoRange').hidden = multi;
  document.querySelectorAll('#memoForm .memo-time').forEach((el) => { el.hidden = allDay; });
  // 繰り返しは新規の時間指定だけ
  $('#memoRepeat').hidden = !!editingMemo || allDay;
  updateRepeatInfo();
}

const REPEAT_MAX = 100;

// 繰り返しの各回の開始日（YYYY-MM-DD）。REPEAT_MAX を超えたら REPEAT_MAX + 1 件で打ち切る
function repeatDates(startDate, kind, until) {
  const out = [];
  if (!kind) return [startDate];
  if (kind === 'monthly') {
    const s = new Date(startDate + 'T00:00:00');
    for (let k = 0; out.length <= REPEAT_MAX; k++) {
      const d = new Date(s.getFullYear(), s.getMonth() + k, s.getDate());
      if (toDate(d) > until) break;
      if (d.getDate() === s.getDate()) out.push(toDate(d)); // 31日がない月などは飛ばす
    }
    return out;
  }
  const step = { daily: 1, weekdays: 1, weekly: 7, biweekly: 14 }[kind];
  for (let d = startDate; d <= until && out.length <= REPEAT_MAX; d = addDays(d, step)) {
    const wd = new Date(d + 'T00:00:00').getDay();
    if (kind === 'weekdays' && (wd === 0 || wd === 6)) continue;
    out.push(d);
  }
  return out;
}

// 日付の差（日数）
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

function updateRepeatInfo() {
  const f = $('#memoForm');
  const kind = f.repeat.value;
  $('#memoRepeatUntilWrap').hidden = !kind;
  const info = $('#memoRepeatInfo');
  if (!kind || $('#memoRepeat').hidden) { info.textContent = ''; return; }
  if (!f.repeatUntil.value && f.startDate.value) {
    const d = new Date(f.startDate.value + 'T00:00:00');
    f.repeatUntil.value = toDate(new Date(d.getFullYear(), d.getMonth() + 1, d.getDate()));
  }
  if (!f.startDate.value || !f.repeatUntil.value || f.repeatUntil.value < f.startDate.value) {
    info.textContent = '「いつまで」は開始日以降にしてください';
    return;
  }
  const n = repeatDates(f.startDate.value, kind, f.repeatUntil.value).length;
  info.textContent = n > REPEAT_MAX ? `${REPEAT_MAX}件までです。「いつまで」を短くしてください` : `${n}件のメモを作成します`;
}

['repeat', 'repeatUntil', 'startDate'].forEach((n) => $('#memoForm')[n].addEventListener('change', updateRepeatInfo));

// opts: { dates, allDay, startTime, endTime }（新規のときの初期値）
function openMemoDialog(memo, opts = {}) {
  editingMemo = memo;
  const f = $('#memoForm');
  f.reset();
  $('#memoTitle').textContent = memo ? 'メモを編集' : 'メモを追加';
  $('#memoTabs').hidden = !!memo;
  $('#memoDelete').hidden = !memo;
  $('#memoError').textContent = '';
  if (memo) {
    memoTarget = memo.person_id === null ? ROOM : memo.person_id;
    f.title.value = memo.title;
    f.allDay.checked = !!memo.all_day;
    f.startDate.value = memo.start.slice(0, 10);
    if (memo.all_day) {
      f.endDate.value = addDays(memo.end, -1); // 保存は翌日（排他的）、表示は最終日
      f.startTime.value = '09:00';
      f.endTime.value = '10:00';
    } else {
      f.endDate.value = memo.end.slice(0, 10);
      f.startTime.value = memo.start.slice(11, 16);
      f.endTime.value = memo.end.slice(11, 16);
    }
  } else {
    memoTarget = ROOM;
    f.allDay.checked = opts.allDay ?? true;
    f.startTime.value = opts.startTime || '09:00';
    f.endTime.value = opts.endTime || '10:00';
    const first = opts.dates?.length ? opts.dates : [toDate(defaultDay())];
    selectedDates = new Set(first);
    const d0 = new Date([...selectedDates].sort()[0] + 'T00:00:00');
    miniMonth = new Date(d0.getFullYear(), d0.getMonth(), 1);
    miniTarget = { cal: '#memoMiniCal', count: '#memoDateCount' };
    renderMiniCal();
    // 時間指定に切り替えたときの初期値（選んだ最初の日）
    f.startDate.value = f.endDate.value = [...selectedDates].sort()[0];
  }
  renderMemoPicker();
  updateMemoFields();
  $('#memoDialog').showModal();
}

$('#memoForm').allDay.addEventListener('change', updateMemoFields);

// 連続した日付をまとめて [{start, end(翌日)}] にする
function dateRuns(dates) {
  const runs = [];
  for (const d of [...dates].sort()) {
    const last = runs[runs.length - 1];
    if (last && last.end === d) last.end = addDays(d, 1);
    else runs.push({ start: d, end: addDays(d, 1) });
  }
  return runs;
}

$('#memoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = (msg) => { $('#memoError').textContent = msg; };
  const title = f.title.value.trim();
  if (!title) return err('内容を入力してください');
  const allDay = f.allDay.checked;
  const person_id = memoTarget === ROOM ? null : memoTarget;
  // 開始〜終了の1件（新規の終日はミニカレンダーから複数件）
  let items;
  if (!editingMemo && allDay) {
    if (!selectedDates.size) return err('日付を選んでください');
    items = dateRuns(selectedDates);
  } else if (allDay) {
    if (!f.startDate.value || !f.endDate.value) return err('日付を入力してください');
    if (f.endDate.value < f.startDate.value) return err('終了日は開始日以降にしてください');
    items = [{ start: f.startDate.value, end: addDays(f.endDate.value, 1) }];
  } else {
    if (!f.startDate.value || !f.endDate.value || !f.startTime.value || !f.endTime.value) return err('日付と時間を入力してください');
    const start = `${f.startDate.value}T${f.startTime.value}:00`;
    const end = `${f.endDate.value}T${f.endTime.value}:00`;
    if (start >= end) return err('終了は開始より後にしてください');
    const kind = editingMemo ? '' : f.repeat.value;
    if (kind && (!f.repeatUntil.value || f.repeatUntil.value < f.startDate.value)) return err('「いつまで」は開始日以降にしてください');
    // 繰り返し：各回を開始日からずらして作る（日をまたぐメモも同じ長さで）
    const span = dayDiff(f.startDate.value, f.endDate.value);
    const days = repeatDates(f.startDate.value, kind, f.repeatUntil.value);
    if (days.length > REPEAT_MAX) return err(`繰り返しは${REPEAT_MAX}件までです`);
    items = days.map((d) => ({ start: `${d}T${f.startTime.value}:00`, end: `${addDays(d, span)}T${f.endTime.value}:00` }));
  }
  try {
    if (editingMemo) {
      const r = await api('PUT', `/api/memos/${editingMemo.id}`, { person_id, title, all_day: allDay, ...items[0] });
      pushUndo('メモを変更しました', () => putBack('memos', r.before));
    } else {
      const r = await api('POST', '/api/memos/batch', { person_id, title, all_day: allDay, items });
      pushUndo(`メモを${r.created}件追加しました`, () => api('POST', '/api/memos/remove', { ids: r.ids }));
    }
    $('#memoDialog').close();
    calendar.refetchEvents();
  } catch (e2) {
    err(e2.message);
  }
});

$('#memoDelete').addEventListener('click', async () => {
  if (!editingMemo || !confirm('このメモを削除しますか？')) return;
  const deleted = await api('DELETE', `/api/memos/${editingMemo.id}`);
  $('#memoDialog').close();
  if (deleted) pushUndo('メモを削除しました', () => api('POST', '/api/memos/restore', { items: [deleted] }));
  calendar.refetchEvents();
});

// 在室⇄メモの切替（選んだ日付と時間を引き継ぐ）
$('#toMemoTab').addEventListener('click', () => {
  const f = $('#stayForm');
  const dates = [...selectedDates];
  $('#stayDialog').close();
  openMemoDialog(null, { dates, allDay: true, startTime: f.startTime.value, endTime: f.endTime.value });
});
$('#toStayTab').addEventListener('click', () => {
  const f = $('#memoForm');
  const dates = f.allDay.checked ? [...selectedDates].sort() : [f.startDate.value].filter(Boolean);
  $('#memoDialog').close();
  const day = dates[0] || toDate(defaultDay());
  const times = f.allDay.checked ? ['09:00', '18:00'] : [f.startTime.value, f.endTime.value];
  openStayDialog(null, new Date(`${day}T${times[0]}:00`), new Date(`${day}T${times[1]}:00`), dates);
});

// ---------- 人ダイアログ ----------
let editingPerson = null;
let removeIcon = false;

let previewUrl = null; // 選んだ画像のプレビュー用URL（ファイル選択時だけ作り直す）

// 要素を作り直さずにその場で更新する（入力のたびに画像を読み直すとチカチカするため）
function updatePreview() {
  const f = $('#personForm');
  const preview = $('#iconPreview');
  const icon = previewUrl || (removeIcon ? null : editingPerson?.icon_path);
  preview.style.backgroundColor = f.color.value;
  const bg = icon ? `url("${icon}")` : '';
  if (preview.style.backgroundImage !== bg) preview.style.backgroundImage = bg;
  preview.textContent = icon ? '' : (f.name.value || '?').slice(0, 1);
}

function resetPreviewUrl() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function openPersonDialog(person) {
  editingPerson = person;
  removeIcon = false;
  resetPreviewUrl();
  const f = $('#personForm');
  f.reset();
  $('#personTitle').textContent = person ? '人を編集' : '人を追加';
  f.name.value = person ? person.name : '';
  f.color.value = person ? person.color : ['#4f7cff', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6'][people.length % 5];
  $('#personDelete').hidden = !person;
  $('#personError').textContent = '';
  updatePreview();
  $('#personDialog').showModal();
}

$('#personForm').icon.addEventListener('change', (e) => {
  resetPreviewUrl();
  const file = e.target.files[0];
  if (file) previewUrl = URL.createObjectURL(file);
  removeIcon = false;
  updatePreview();
});
$('#personForm').name.addEventListener('input', updatePreview);
$('#personForm').color.addEventListener('input', updatePreview);
$('#removeIconBtn').addEventListener('click', () => {
  removeIcon = true;
  resetPreviewUrl();
  $('#personForm').icon.value = '';
  updatePreview();
});

// アイコンは最大表示（72px）の2倍の正方形に縮小して WebP にする（通信と保存を軽くするため）
const ICON_SIZE = 144;
async function shrinkIcon(file) {
  try {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ICON_SIZE;
    canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
    bmp.close();
    const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
    let blob = await toBlob('image/webp', 0.8);
    if (blob?.type !== 'image/webp') {
      // WebP 非対応のブラウザ向け。JPEG は透明を持てないので白で塗ってから
      const ctx = canvas.getContext('2d');
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
      blob = await toBlob('image/jpeg', 0.85);
    }
    return blob ? { blob, name: blob.type === 'image/webp' ? 'icon.webp' : 'icon.jpg' } : null;
  } catch {
    return null; // 読み込めない形式などは元のファイルをそのまま送る
  }
}

$('#personForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const fd = new FormData();
  fd.append('name', f.name.value.trim());
  fd.append('color', f.color.value);
  const file = f.icon.files[0];
  if (file) {
    const small = await shrinkIcon(file);
    if (small) fd.append('icon', small.blob, small.name);
    else fd.append('icon', file);
  }
  if (removeIcon) fd.append('removeIcon', '1');
  try {
    if (editingPerson) {
      const r = await api('PUT', `/api/people/${editingPerson.id}`, fd);
      pushUndo(`${r.before.name}を変更しました`, () => api('POST', '/api/people/restore', { person: r.before }));
    } else {
      const r = await api('POST', '/api/people', fd);
      pushUndo(`${r.name}を追加しました`, () => api('DELETE', `/api/people/${r.id}`));
    }
    $('#personDialog').close();
    await loadPeople();
    calendar.refetchEvents();
  } catch (err) {
    $('#personError').textContent = err.message;
  }
});

$('#personDelete').addEventListener('click', async () => {
  if (!editingPerson || !confirm(`${editingPerson.name} を削除しますか？\nこの人の在室記録とメモもすべて消えます。`)) return;
  const deleted = await api('DELETE', `/api/people/${editingPerson.id}`);
  $('#personDialog').close();
  pushUndo(`${deleted.person.name}を削除しました`, () => api('POST', '/api/people/restore', deleted));
  await loadPeople();
  calendar.refetchEvents();
});

$('#addPersonBtn').addEventListener('click', () => { if (requireUnlocked()) openPersonDialog(null); });

// 表示中の日（今日が範囲内なら今日）
function defaultDay() {
  const view = calendar.view;
  const now = new Date();
  return now >= view.currentStart && now < view.currentEnd ? now : view.currentStart;
}

// ---------- CSV取り込み（Googleカレンダー形式） ----------
// 引用符・引用符内の改行とカンマに対応した最小限のCSVパーサー
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const IMPORT_COLS = {
  subject: ['subject', '件名', 'タイトル'],
  startDate: ['start date', '開始日'],
  startTime: ['start time', '開始時刻', '開始時間'],
  endDate: ['end date', '終了日'],
  endTime: ['end time', '終了時刻', '終了時間'],
  allDay: ['all day event', '終日イベント', '終日'],
  description: ['description', '説明', '備考'],
};

// 'MM/DD/YYYY' 'YYYY-MM-DD' 'YYYY/MM/DD' → 'YYYY-MM-DD'（読めなければ null）
function importDate(v) {
  v = (v || '').trim();
  let y, m, d, mt;
  if ((mt = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [m, d, y] = [mt[1], mt[2], mt[3]];
  else if ((mt = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) [y, m, d] = [mt[1], mt[2], mt[3]];
  else return null;
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  if (dt.getMonth() !== Number(m) - 1 || dt.getDate() !== Number(d)) return null;
  return toDate(dt);
}

// '9:00 AM' '09:00 PM' '21:00' → 'HH:MM'（読めなければ null）
function importTime(v) {
  const mt = (v || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!mt) return null;
  let h = Number(mt[1]);
  const min = Number(mt[2]);
  if (mt[3]) {
    if (h < 1 || h > 12) return null;
    h = h % 12 + (/p/i.test(mt[3]) ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

// kind: ok=取り込める / allDay=終日 / multi=日またぎ / bad=時刻が読めない・終了が開始以前
function parseImportEvents(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (!rows.length) throw new Error('CSVが空です');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(IMPORT_COLS)) col[key] = header.findIndex((h) => names.includes(h));
  if (col.subject < 0 || col.startDate < 0) throw new Error('Googleカレンダー形式のCSVではありません（Subject と Start Date の列が必要です）');
  const get = (r, k) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '');
  return rows.slice(1).map((r) => {
    const ev = { title: get(r, 'subject'), note: get(r, 'description').slice(0, 100) };
    const sd = importDate(get(r, 'startDate'));
    if (/^(true|yes|1|はい)$/i.test(get(r, 'allDay'))) return { ...ev, kind: 'allDay' };
    const ed = importDate(get(r, 'endDate')) || sd;
    const st = importTime(get(r, 'startTime'));
    const et = importTime(get(r, 'endTime'));
    if (!sd || !st || !et) return { ...ev, kind: 'bad' };
    if (sd !== ed) return { ...ev, kind: 'multi' };
    if (st >= et) return { ...ev, kind: 'bad' };
    return { ...ev, kind: 'ok', start: `${sd}T${st}:00`, end: `${ed}T${et}:00` };
  });
}

let importEvents = [];
let importTitleList = []; // { title, ok, skipped }
let importPerson = null;
const SKIP_LABEL = { allDay: '終日', multi: '日またぎ', bad: '時刻が不正' };

function renderImportPicker() {
  const box = $('#importPicker');
  box.replaceChildren();
  for (const p of people) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = p.id === importPerson ? 'selected' : '';
    b.append(avatar(p), p.name);
    b.onclick = () => { importPerson = p.id; renderImportPicker(); updateImportSummary(); };
    box.append(b);
  }
}

function checkedImportTitles() {
  return new Set([...document.querySelectorAll('#importTitles input:checked')].map((c) => importTitleList[Number(c.value)].title));
}

function updateImportSummary() {
  const titles = checkedImportTitles();
  const chosen = importEvents.filter((e) => titles.has(e.title));
  const ok = chosen.filter((e) => e.kind === 'ok').length;
  const skips = {};
  chosen.forEach((e) => { if (e.kind !== 'ok') skips[e.kind] = (skips[e.kind] || 0) + 1; });
  $('#importCount').textContent = `${ok}件`;
  $('#importSkipped').textContent = Object.keys(skips).length
    ? '取り込めない予定：' + Object.entries(skips).map(([k, n]) => `${SKIP_LABEL[k]}${n}件`).join('、')
    : '';
  $('#importSubmit').disabled = !ok || !importPerson;
}

function openImportDialog(name, events, error) {
  importEvents = events;
  importPerson = people.length === 1 ? people[0].id : null;
  $('#importFileName').textContent = name;
  $('#importError').textContent = error || '';
  const byTitle = new Map();
  for (const e of events) {
    const t = byTitle.get(e.title) || { title: e.title, ok: 0, skipped: 0 };
    if (e.kind === 'ok') t.ok++; else t.skipped++;
    byTitle.set(e.title, t);
  }
  importTitleList = [...byTitle.values()];
  const box = $('#importTitles');
  box.replaceChildren(...importTitleList.map((t, i) => {
    const l = document.createElement('label');
    l.className = 'check';
    const c = document.createElement('input');
    c.type = 'checkbox'; c.value = i;
    c.checked = t.ok > 0 && t.title.includes('在室');
    c.disabled = t.ok === 0;
    l.append(c, document.createTextNode(` ${t.title || '（タイトルなし）'}  ${t.ok}件${t.skipped ? `（取り込めない${t.skipped}件）` : ''}`));
    return l;
  }));
  renderImportPicker();
  updateImportSummary();
  $('#importDialog').showModal();
}

async function readImportFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('shift_jis').decode(buf); }
}

$('#importBtn').addEventListener('click', () => { if (requireUnlocked()) $('#importFile').click(); });
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // 同じファイルをもう一度選べるように
  if (!file) return;
  try {
    openImportDialog(file.name, parseImportEvents(await readImportFile(file)));
  } catch (err) {
    openImportDialog(file.name, [], err.message);
  }
});
$('#importForm').addEventListener('change', (e) => {
  if (e.target.closest('#importTitles')) updateImportSummary();
});
$('#importForm').addEventListener('click', (e) => {
  const all = 'importAll' in e.target.dataset;
  if (!all && !('importNone' in e.target.dataset)) return;
  document.querySelectorAll('#importTitles input:not(:disabled)').forEach((c) => { c.checked = all; });
  updateImportSummary();
});
$('#importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const titles = checkedImportTitles();
  const items = importEvents.filter((ev) => ev.kind === 'ok' && titles.has(ev.title))
    .map(({ start, end, note }) => ({ start, end, note }));
  if (!importPerson || !items.length) return;
  $('#importSubmit').disabled = true;
  try {
    const r = await api('POST', '/api/stays/import', { person_id: importPerson, items });
    $('#importDialog').close();
    calendar.refetchEvents();
    const dup = r.skipped ? `（取り込み済みの${r.skipped}件は除く）` : '';
    if (r.created) pushUndo(`在室を${r.created}件取り込みました${dup}`, () => api('POST', '/api/stays/remove', { ids: r.ids }));
    else showToast(`すべて取り込み済みでした（${r.skipped}件）`, false);
  } catch (err) {
    $('#importError').textContent = err.message;
    $('#importSubmit').disabled = false;
  }
});

// ---------- CSV出力（Googleカレンダー形式） ----------
const exportState = { stays: [], memos: [] };

function openExportDialog() {
  const f = $('#exportForm');
  const view = calendar.view;
  f.from.value = toDate(view.currentStart);
  f.to.value = addDays(toDate(view.currentEnd), -1);
  const box = $('#exportPeople');
  box.innerHTML = '';
  people.forEach((p) => {
    const l = document.createElement('label');
    l.className = 'check';
    const c = document.createElement('input');
    c.type = 'checkbox'; c.value = p.id; c.checked = true;
    l.append(c, document.createTextNode(' ' + p.name));
    box.append(l);
  });
  $('#exportError').textContent = '';
  exportState.stays = []; exportState.memos = [];
  $('#exportStays').replaceChildren();
  $('#exportMemos').replaceChildren();
  $('#exportDialog').showModal();
  refreshExportLists().catch((err) => { $('#exportError').textContent = err.message; });
}

const exportPersonIds = () =>
  [...document.querySelectorAll('#exportPeople input:checked')].map((c) => Number(c.value));

const fmtDate = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
function fmtTime(s) {
  const h = Number(s.slice(11, 13));
  return `${pad(h % 12 || 12)}:${s.slice(14, 16)} ${h < 12 ? 'AM' : 'PM'}`;
}
const csvCell = (v) => {
  v = String(v ?? '');
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
const hhmm = (s) => (s.length > 10 ? s.slice(11, 16) : '');

// kind: 'stay' | 'memo'。person は person_id（部屋のメモは ROOM）
function exportRow(kind, label, index, person, checked) {
  const l = document.createElement('label');
  l.className = 'check';
  l.dataset.person = person;
  const c = document.createElement('input');
  c.type = 'checkbox'; c.value = index; c.checked = checked;
  l.append(c, document.createTextNode(' ' + label));
  return l;
}

const exportKey = (kind, row) => `${kind}${row.id}`;
let exportReq = 0;

// 期間が変わったときだけ取得し直す。人の絞り込みは applyExportPeople が表示の切り替えだけで行う
async function refreshExportLists() {
  const f = $('#exportForm');
  if (!f.from.value || !f.to.value || f.from.value > f.to.value) return;
  const req = ++exportReq;
  const q = `?start=${f.from.value}T00:00:00&end=${addDays(f.to.value, 1)}T00:00:00`;
  const [stays, memos] = await Promise.all([api('GET', '/api/stays' + q), api('GET', '/api/memos' + q)]);
  if (req !== exportReq) return; // もっと新しい取得が走っている

  // 同じ予定・メモなら、チェックの状態を引き継ぐ
  const prev = new Map();
  document.querySelectorAll('#exportStays input, #exportMemos input').forEach((c) => {
    const row = (c.closest('#exportStays') ? exportState.stays : exportState.memos)[Number(c.value)];
    if (row) prev.set(exportKey(c.closest('#exportStays') ? 'stay' : 'memo', row), c.dataset.prev ?? String(c.checked));
  });
  exportState.stays = stays;
  exportState.memos = memos;
  const stayRows = stays.map((st, i) => {
    const name = personById(st.person_id)?.name || '';
    const want = prev.get(exportKey('stay', st));
    return exportRow('stay', `${st.start.slice(5, 10)} ${hhmm(st.start)}-${hhmm(st.end)} ${name}`, i, st.person_id, want == null ? true : want === 'true');
  });
  const memoRows = memos.map((m, i) => {
    const who = m.person_id == null ? '部屋' : (personById(m.person_id)?.name || '');
    const want = prev.get(exportKey('memo', m));
    return exportRow('memo', `${m.start.slice(5, 10)} ${m.title}（${who}）`, i, m.person_id ?? ROOM, want == null ? false : want === 'true');
  });
  const empty = (msg) => {
    const p = document.createElement('p');
    p.className = 'hint empty';
    p.textContent = msg;
    return p;
  };
  $('#exportStays').replaceChildren(...stayRows, empty('該当する在室予定はありません'));
  $('#exportMemos').replaceChildren(...memoRows, empty('該当するメモはありません'));
  applyExportPeople();
}

// 選ばれていない人の行は隠してチェックも外す。戻したときは外す前の状態に戻す
function applyExportPeople() {
  const ids = new Set(exportPersonIds().map(String));
  document.querySelectorAll('#exportStays, #exportMemos').forEach((box) => {
    let shown = 0;
    box.querySelectorAll('label').forEach((l) => {
      const c = l.querySelector('input');
      const show = l.dataset.person === String(ROOM) ? ids.size > 0 : ids.has(l.dataset.person);
      if (show && l.hidden) {
        c.checked = c.dataset.prev === 'true';
        delete c.dataset.prev;
      } else if (!show && !l.hidden) {
        c.dataset.prev = String(c.checked);
        c.checked = false;
      }
      l.hidden = !show;
      if (show) shown++;
    });
    const empty = box.querySelector('.empty');
    if (empty) empty.hidden = shown > 0;
  });
  updateExportCounts();
}

function updateExportCounts() {
  $('#exportStayCount').textContent = `${document.querySelectorAll('#exportStays input:checked').length}件`;
  $('#exportMemoCount').textContent = `${document.querySelectorAll('#exportMemos input:checked').length}件`;
}

function buildCsv(f) {
  const subject = f.subject.value.trim();
  const rows = [['Subject', 'Start Date', 'Start Time', 'End Date', 'End Time', 'All Day Event', 'Description', 'Location', 'Private']];
  const picked = (sel) => [...document.querySelectorAll(sel + ' input:checked')].map((c) => Number(c.value));
  for (const i of picked('#exportStays')) {
    const s = exportState.stays[i];
    const name = personById(s.person_id)?.name;
    rows.push([f.withName.checked && name ? `${subject} - ${name}` : subject,
      fmtDate(s.start), fmtTime(s.start), fmtDate(s.end), fmtTime(s.end),
      'False', f.description.value.trim(), f.location.value.trim(), 'False']);
  }
  for (const i of picked('#exportMemos')) {
    const m = exportState.memos[i];
    if (m.all_day) {
      rows.push([m.title, fmtDate(m.start), '', fmtDate(addDays(m.end, -1)), '', 'True', '', '', 'False']);
    } else {
      rows.push([m.title, fmtDate(m.start), fmtTime(m.start), fmtDate(m.end), fmtTime(m.end), 'False', '', '', 'False']);
    }
  }
  return { count: rows.length - 1, text: rows.map((r) => r.map(csvCell).join(',')).join('\r\n') };
}

$('#exportBtn').addEventListener('click', openExportDialog);
$('#exportForm').addEventListener('change', (e) => {
  if (e.target.name === 'from' || e.target.name === 'to') {
    refreshExportLists().catch((err) => { $('#exportError').textContent = err.message; });
  } else if (e.target.closest('#exportPeople')) applyExportPeople();
  else updateExportCounts();
});
$('#exportForm').addEventListener('click', (e) => {
  const kind = e.target.dataset?.all || e.target.dataset?.none;
  if (!kind) return;
  document.querySelectorAll(`${kind === 'stay' ? '#exportStays' : '#exportMemos'} label:not([hidden]) input`)
    .forEach((c) => { c.checked = 'all' in e.target.dataset; });
  updateExportCounts();
});
$('#exportForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const { count, text } = buildCsv(f);
  if (!count) { $('#exportError').textContent = '出力する予定がありません'; return; }
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `zaishitsu_${f.from.value.replace(/-/g, '')}-${f.to.value.replace(/-/g, '')}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  $('#exportDialog').close();
  showToast(`${count}件をCSVに出力しました`, false);
});

$('#addMemoBtn').addEventListener('click', () => { if (requireUnlocked()) openMemoDialog(null); });

// ＋ボタン：表示中の日に 9:00-18:00 で追加
$('#addStayBtn').addEventListener('click', () => {
  if (!requireUnlocked()) return;
  const day = defaultDay();
  const start = new Date(day); start.setHours(9, 0, 0, 0);
  const end = new Date(day); end.setHours(18, 0, 0, 0);
  openStayDialog(null, start, end, []);
});
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('dialog').close()));

// 他の人の変更を拾うため、タブに戻ったときに再読込
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await loadPeople();
    calendar.refetchEvents();
  }
});

(async () => {
  initCalendar();
  setLocked(true);
  await loadPeople();
  calendar.refetchEvents();
})();
