(() => {
  const $ = (s) => document.querySelector(s);
  const views = [...document.querySelectorAll('[id^="view-"]')];
  let resendTimer;

  // 確認待ちのメールアドレスは、再読み込みやタブの復元のあとでもコード入力に戻れるよう sessionStorage にも残す。
  // 保存できない環境（プライベートモードなど）でも動くように、読み書きは必ず try/catch で囲む
  const PENDING_KEY = 'iruinai_pending_email';
  function readPending() {
    try { return sessionStorage.getItem(PENDING_KEY) || ''; } catch { return ''; }
  }
  let pendingEmail = readPending();
  function setPending(email) {
    pendingEmail = email;
    try {
      if (email) sessionStorage.setItem(PENDING_KEY, email);
      else sessionStorage.removeItem(PENDING_KEY);
    } catch { /* 保存できなくても、このページの中では覚えている */ }
  }

  // 登録で入れたパスワードは、このページを開いている間だけ変数に持つ（確認コードの画面に入れておくため）。
  // sessionStorage / localStorage には絶対に残さない。再読み込みしたら消えるので、そのときは入力し直してもらう
  let signupPassword = '';

  // fresh は「いま登録して、確認メールを送った直後」のとき true（そうでなければ、メールを送ったとは言わない）
  function show(name, fresh = false) {
    for (const v of views) v.hidden = v.id !== 'view-' + name;
    const cur = $('#view-' + name);
    cur.querySelectorAll('[data-error]').forEach((e) => { e.textContent = ''; });
    let first = cur.querySelector('input:not([type=radio]):not([type=color]):not(:disabled)');
    if (name === 'code') {
      const saved = pendingEmail || readPending();
      if (saved) cur.email.value = saved;
      $('#codeSent').textContent = fresh && saved
        ? `${saved} に6桁のコードを送りました（10分間有効）。`
        : '届いた6桁のコードと、登録のときに決めたパスワードを入力してください（10分間有効）。';
      if (signupPassword && !$('#codePassword').value) $('#codePassword').value = signupPassword;
      if (cur.email.value) first = cur.code; // メールが入っていれば、コードの欄から始める
    }
    first?.focus();
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
    let free = [];
    try {
      const res = await fetch('/api/people');
      const people = res.ok ? await res.json() : [];
      if (Array.isArray(people)) free = people.filter((p) => !p.claimed);
    } catch { /* 取れなければ「すでにある人」は選べないことにする（ほかの操作は止めない） */ }
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
    setPending(f.email.value.trim());
    signupPassword = f.password.value;
    $('#view-code').code.value = '';
    $('#codePassword').value = signupPassword;
    show('code', true);
    startCountdown();
  });

  // コード確認
  onSubmit('code', async (f) => {
    await post('/api/auth/verify', { email: f.email.value.trim(), code: f.code.value, password: f.password.value });
    setPending('');
    signupPassword = '';
    f.password.value = '';
    location.href = '/';
  });
  $('#resendBtn').addEventListener('click', async () => {
    try {
      await post('/api/auth/resend', { email: $('#view-code').email.value.trim() });
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
      const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (me?.user) { location.href = '/'; return; }
    }
    syncPersonMode();
    show(isReset && token ? 'reset' : 'login'); // 先に画面を出す。/api/people が壊れていても、ログインや再設定は使える
    await loadExisting();
  })();
})();
