(() => {
  const $ = (s) => document.querySelector(s);
  const views = [...document.querySelectorAll('[id^="view-"]')];
  let pendingEmail = '';
  let resendTimer;

  function show(name) {
    for (const v of views) v.hidden = v.id !== 'view-' + name;
    const cur = $('#view-' + name);
    cur.querySelectorAll('[data-error]').forEach((e) => { e.textContent = ''; });
    cur.querySelector('input:not([type=radio]):not([type=color]):not(:disabled)')?.focus();
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !data.needLogin) { location.href = '/login'; throw new Error('合言葉を入力してください'); }
    if (!res.ok) throw new Error(data.error || '失敗しました');
    return data;
  }

  // フォームの送信を、エラー表示・二重送信の防止つきで扱う
  function onSubmit(id, handler) {
    const form = $('#view-' + id);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      form.querySelector('[data-error]').textContent = '';
      btn.disabled = true;
      try {
        await handler(form);
      } catch (err) {
        form.querySelector('[data-error]').textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (go) show(go);
  });

  function startCountdown(sec = 60) {
    const btn = $('#resendBtn');
    let left = sec;
    clearInterval(resendTimer);
    const tick = () => {
      btn.disabled = left > 0;
      btn.textContent = left > 0 ? `コードを再送する（${left}秒後）` : 'コードを再送する';
      if (left <= 0) clearInterval(resendTimer);
      left--;
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  // ログイン
  onSubmit('login', async (f) => {
    await post('/api/auth/login', { email: f.email.value, password: f.password.value });
    location.href = '/';
  });

  // 新規登録：未紐付けの人を選べるようにする
  async function loadExisting() {
    const people = await fetch('/api/people').then((r) => r.json()).catch(() => []);
    const free = people.filter((p) => !p.claimed);
    const sel = $('#existingSelect');
    sel.replaceChildren(...free.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.name })));
    const none = free.length === 0;
    $('#existingLabel').hidden = none;
    sel.hidden = none;
    $('#existingHint').hidden = none;
  }

  function syncPersonMode() {
    const f = $('#view-signup');
    const existing = f.mode.value === 'existing';
    f.new_name.disabled = existing;
    f.new_name.required = !existing;
    f.new_color.disabled = existing;
    $('#existingSelect').disabled = !existing;
  }
  $('#view-signup').addEventListener('change', (e) => { if (e.target.name === 'mode') syncPersonMode(); });

  onSubmit('signup', async (f) => {
    if (f.password.value !== f.password2.value) throw new Error('パスワードが一致しません');
    const body = { email: f.email.value, password: f.password.value };
    if (f.mode.value === 'existing') body.person_id = Number(f.person_id.value);
    else { body.new_name = f.new_name.value; body.new_color = f.new_color.value; }
    await post('/api/auth/signup', body);
    pendingEmail = f.email.value;
    $('#codeSent').textContent = `${pendingEmail.trim()} に6桁のコードを送りました（10分間有効）。`;
    $('#view-code').code.value = '';
    show('code');
    startCountdown();
  });

  // コード確認
  onSubmit('code', async (f) => {
    await post('/api/auth/verify', { email: pendingEmail, code: f.code.value });
    location.href = '/';
  });
  $('#resendBtn').addEventListener('click', async () => {
    try {
      await post('/api/auth/resend', { email: pendingEmail });
      $('#view-code [data-error]').textContent = '';
      startCountdown();
    } catch (err) {
      $('#view-code [data-error]').textContent = err.message;
    }
  });

  // パスワードの再設定
  onSubmit('forgot', async (f) => {
    await post('/api/auth/forgot', { email: f.email.value });
    show('forgotDone');
  });
  onSubmit('reset', async (f) => {
    if (f.password.value !== f.password2.value) throw new Error('パスワードが一致しません');
    const token = new URLSearchParams(location.search).get('token') || '';
    await post('/api/auth/reset', { token, password: f.password.value });
    show('resetDone');
  });

  (async () => {
    const isReset = location.pathname === '/reset';
    const token = new URLSearchParams(location.search).get('token');
    if (!isReset) {
      const me = await fetch('/api/me').then((r) => r.json()).catch(() => null);
      if (me?.user) { location.href = '/'; return; }
    }
    await loadExisting();
    syncPersonMode();
    show(isReset && token ? 'reset' : 'login');
  })();
})();
