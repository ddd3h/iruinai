(() => {
  const $ = (s) => document.querySelector(s);
  const views = [...document.querySelectorAll('[id^="view-"]')];
  let resendTimer;

  // 確認コードの画面は、メールもパスワードも尋ねず、6桁のコードだけを受け取る。
  // どの確認待ちかは、申し込んだブラウザの Cookie（HttpOnly）でサーバーが決める。だから、ここでは何も覚えておかず、
  // 再読み込みしたときは、サーバーに聞く（GET /api/auth/pending）。メールもパスワードも、ブラウザの保存領域には残さない
  const LOCKED_TEXT = '間違いが続いたため、このコードは使えません。10分ほど待ってから、もう一度登録してください';

  function show(name) {
    for (const v of views) v.hidden = v.id !== 'view-' + name;
    const cur = $('#view-' + name);
    cur.querySelectorAll('[data-error]').forEach((e) => { e.textContent = ''; });
    cur.querySelector('input:not([type=radio]):not([type=color]):not(:disabled)')?.focus();
  }

  // コード入力の画面を出す。email は確認コードを送った先。resendIn は再送できるまでの秒数
  // fresh: いま申し込んで確認メールを送った直後。resumed: 申し込み済みの手続きに戻ってきた（メールは送り直していない）
  function showCode({ email, resendIn = 60, locked = false, fresh = false, resumed = false }) {
    $('#view-code').code.value = '';
    show('code');
    $('#codeSent').textContent = fresh
      ? `${email} に6桁のコードを送りました（10分間有効）。届いたら、このブラウザで入力してください。`
      : resumed
        ? `${email} には、すでに確認コードを送ってあります。届いた6桁のコードを入力してください。申し込みの内容（パスワードなど）は、最初に送ったものが使われます。`
        : `${email} に送った6桁のコードを入力してください。コードは、申し込んだこのブラウザでだけ入力できます。`;
    if (locked) $('#view-code [data-error]').textContent = LOCKED_TEXT; // show() が消すので、そのあとで出す
    startCountdown(resendIn);
  }

  // サーバーが覚えているこのブラウザの確認待ち（なければ null）
  async function fetchPending() {
    try {
      const res = await fetch('/api/auth/pending');
      if (!res.ok) return null;
      return (await res.json())?.pending || null;
    } catch {
      return null;
    }
  }

  function showPending(p, flags = {}) {
    const left = Math.ceil((p.resend_available_at - Date.now()) / 1000); // 端末の時計がずれていても、0〜60秒に収める
    showCode({ email: p.email, resendIn: Number.isFinite(left) ? Math.min(60, Math.max(0, left)) : 60, locked: !!p.locked, ...flags });
  }

  // 確認待ちがなくなっていた（期限切れ・別のブラウザ・消去など）。登録の画面に戻して、理由を見せる
  function backToSignup(message) {
    show('signup');
    $('#view-signup [data-error]').textContent = message;
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !data.needLogin) { location.href = '/login'; throw new Error('合言葉を入力してください'); }
    if (!res.ok) throw Object.assign(new Error(data.error || '失敗しました'), { noPending: !!data.noPending });
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
    const data = await post('/api/auth/signup', body);
    // 申し込み直し（resumed）のときは、再送までの本当の残り時間と、ロックの有無をサーバーに聞く
    const p = data.resumed ? await fetchPending() : null;
    if (p) showPending(p, { resumed: true });
    else showCode({ email: f.email.value.trim().toLowerCase(), fresh: !data.resumed, resumed: !!data.resumed });
  });

  // コード確認。本文はコードだけ
  onSubmit('code', async (f) => {
    try {
      await post('/api/auth/verify', { code: f.code.value });
    } catch (err) {
      if (err.noPending) return backToSignup(err.message);
      throw err;
    }
    location.href = '/';
  });
  $('#resendBtn').addEventListener('click', async () => {
    try {
      await post('/api/auth/resend', {});
      $('#view-code [data-error]').textContent = '';
      startCountdown();
    } catch (err) {
      if (err.noPending) return backToSignup(err.message);
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
    // 先に画面を出す。/api/people が壊れていても、ログインや再設定は使える。
    // メールのリセットリンク（/reset?token=…）が先。そうでなければ、確認待ちがあればコード入力の画面、なければログイン
    if (isReset && token) {
      show('reset');
    } else {
      const pending = await fetchPending();
      if (pending) showPending(pending);
      else show('login');
    }
    await loadExisting();
  })();
})();
