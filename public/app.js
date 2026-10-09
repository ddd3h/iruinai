let people = [];
const hidden = new Set(); // 非表示中の person_id
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

// ---------- 上部の人一覧 ----------
function renderPeople() {
  const box = $('#people');
  box.replaceChildren();
  for (const p of people) {
    const chip = document.createElement('div');
    chip.className = 'person-chip' + (hidden.has(p.id) ? ' off' : '');
    chip.style.borderColor = p.color;
    chip.title = 'クリックで表示/非表示';
    chip.append(avatar(p), p.name);
    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.textContent = '✎';
    edit.title = '編集';
    edit.onclick = (e) => { e.stopPropagation(); openPersonDialog(p); };
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
    allDaySlot: false,
    scrollTime: '08:00:00',
    slotDuration: '00:30:00',
    snapDuration: '00:15:00',
    dayMaxEvents: 4,
    eventDisplay: 'block',
    displayEventEnd: true,
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    slotEventOverlap: false, // 重ねずに横並び
    selectable: true,
    editable: true,
    selectLongPressDelay: 300,
    eventLongPressDelay: 400,
    // 日付は数字だけ（「日」を付けない）
    dayCellContent: (arg) => ({ html: String(arg.date.getDate()) }),
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
    events: async (info) => {
      const s = info.startStr.slice(0, 19);
      const e = info.endStr.slice(0, 19);
      const stays = await api('GET', `/api/stays?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
      return stays
        .filter((st) => personById(st.person_id) && !hidden.has(st.person_id))
        .map((st) => {
          const p = personById(st.person_id);
          return {
            id: String(st.id), start: st.start, end: st.end,
            backgroundColor: p.color, borderColor: p.color,
            extendedProps: { stay: st },
          };
        });
    },
    // 祝日は赤、日曜・土曜は CSS（fc-day-sun / fc-day-sat）で色付け
    dayCellClassNames: (arg) => (holidayName(arg.date) ? ['holiday'] : []),
    dayHeaderClassNames: (arg) => (holidayName(arg.date) ? ['holiday'] : []),
    dayCellDidMount: (arg) => {
      const name = holidayName(arg.date);
      const top = arg.el.querySelector('.fc-daygrid-day-top');
      if (!name || !top) return;
      const label = document.createElement('span');
      label.className = 'holiday-name';
      label.textContent = name;
      top.prepend(label);
    },
    datesSet: (info) => {
      // 月は全体表示、週・日は高さ固定でスクロール
      const h = info.view.type === 'dayGridMonth' ? 'auto' : 720;
      if (calendar && calendar.getOption('height') !== h) {
        calendar.setOption('height', h);
        if (h !== 'auto') setTimeout(() => calendar.scrollToTime('08:00:00'));
      }
    },
    eventContent: (arg) => {
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
      let start = info.start;
      let end = info.end;
      const dates = [];
      if (info.allDay) {
        // 月表示で日付クリック／ドラッグ：選んだ日すべてに 9:00-18:00 を初期値
        for (const d = new Date(info.start); d < info.end; d.setDate(d.getDate() + 1)) dates.push(toDate(d));
        start = new Date(info.start); start.setHours(9, 0, 0, 0);
        end = new Date(info.start); end.setHours(18, 0, 0, 0);
      }
      openStayDialog(null, start, end, dates);
    },
    eventClick: (info) => {
      const st = info.event.extendedProps.stay;
      openStayDialog(st, new Date(st.start), new Date(st.end));
    },
    eventChange: async (info) => {
      try {
        await api('PUT', `/api/stays/${info.event.id}`, {
          start: toLocalIso(info.event.start),
          end: toLocalIso(info.event.end),
        });
        calendar.refetchEvents();
      } catch (err) {
        alert(err.message);
        info.revert();
      }
    },
  });
  calendar.render();
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

function renderMiniCal() {
  const box = $('#miniCal');
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
  $('#dateCount').textContent = selectedDates.size ? `${selectedDates.size}日 選択中` : '';
}

$('#clearDates').addEventListener('click', () => { selectedDates.clear(); renderMiniCal(); });

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
  selectedDates = new Set(dates.length ? dates : [toDate(start)]);
  miniMonth = new Date(start.getFullYear(), start.getMonth(), 1);
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
      await api('PUT', `/api/stays/${editingStay.id}`, {
        person_id: pickedPerson,
        start: `${f.date.value}T${f.startTime.value}:00`,
        end: `${f.date.value}T${f.endTime.value}:00`,
        note: f.note.value.trim(),
      });
    } else {
      await api('POST', '/api/stays/batch', {
        person_id: pickedPerson,
        dates: [...selectedDates].sort(),
        startTime: f.startTime.value,
        endTime: f.endTime.value,
        note: f.note.value.trim(),
      });
    }
    $('#stayDialog').close();
    calendar.refetchEvents();
  } catch (err) {
    $('#stayError').textContent = err.message;
  }
});

$('#stayDelete').addEventListener('click', async () => {
  if (!editingStay || !confirm('この在室を削除しますか？')) return;
  await api('DELETE', `/api/stays/${editingStay.id}`);
  $('#stayDialog').close();
  calendar.refetchEvents();
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

$('#personForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const fd = new FormData();
  fd.append('name', f.name.value.trim());
  fd.append('color', f.color.value);
  if (f.icon.files[0]) fd.append('icon', f.icon.files[0]);
  if (removeIcon) fd.append('removeIcon', '1');
  try {
    if (editingPerson) await api('PUT', `/api/people/${editingPerson.id}`, fd);
    else await api('POST', '/api/people', fd);
    $('#personDialog').close();
    await loadPeople();
    calendar.refetchEvents();
  } catch (err) {
    $('#personError').textContent = err.message;
  }
});

$('#personDelete').addEventListener('click', async () => {
  if (!editingPerson || !confirm(`${editingPerson.name} を削除しますか？\nこの人の在室記録もすべて消えます。`)) return;
  await api('DELETE', `/api/people/${editingPerson.id}`);
  $('#personDialog').close();
  await loadPeople();
  calendar.refetchEvents();
});

$('#addPersonBtn').addEventListener('click', () => openPersonDialog(null));

// ＋ボタン：表示中の日（今日が範囲内なら今日）に 9:00-18:00 で追加
$('#addStayBtn').addEventListener('click', () => {
  const view = calendar.view;
  const now = new Date();
  const day = now >= view.currentStart && now < view.currentEnd ? now : view.currentStart;
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
  await loadPeople();
  calendar.refetchEvents();
})();
