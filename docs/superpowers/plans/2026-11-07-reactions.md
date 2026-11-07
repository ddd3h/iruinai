# 反応（スタンプ・コメント・通知）実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 予定とメモにスタンプとコメントを付けられるようにし、持ち主には吹き出し・音・ベルの履歴で知らせる。

**Architecture:** `reactions` 表と `users.reactions_seen_id` を足し、`lib/reactions.js` に API をまとめる。クライアントは `public/reactions.js` 1 本に、反応欄・ベル・吹き出し・音を入れ、`app.js` からは数か所の呼び出しだけにする。更新は 30 秒ごとのポーリング。

**Tech Stack:** Node 22.13+、Express 5、`node:sqlite`、`node:test`、素の JavaScript（FullCalendar 6 は既存）、Web Audio API。

**Spec:** `docs/superpowers/specs/2026-11-07-reactions-design.md`（この計画の根拠。食い違ったらスペックが優先）

## Global Constraints

- 返答文言・画面文言は日本語。コミットメッセージも日本語の普通の文章で、末尾にセッションの Co-Authored-By 行を付ける。
- 本番の `/home/ddd3h/iruinai/data` には触らない。試すときは `DATA_DIR=<mktemp -d>` と `ENV_FILE=/nonexistent`。
- push しない。`.serena/` `.superpowers/` `.env` `.env.swp` を `git add` しない。`git add` は明示したパスだけ。
- 新しい依存パッケージを足さない。音声・画像ファイルを新規に同梱しない（音は合成、画像は `public/stamps/` に後から置く）。
- 描画は `textContent` / `createElement` で行い、ユーザー入力を `innerHTML` に入れない。
- 既存の権限の作法に従う: 書き込みは `guard.writeGuard`（未ログイン 401 `{needLogin:true}`）を通る。500 は一般的な日本語文言で、`InputError`・`UserError` だけ通す。
- 既存テスト（`npm test`、現在 143 件）は壊さない。テストは `test/helpers.js` の `startServer` / `Client`、時計は `test/fake-clock.js`（`srv.advanceClock(ms)`）を使う。
- スタンプ ID は `like` `angry` `sad` `thanks` `otsu` `laugh`（順序固定）。コメントは 1〜40 字（コードポイント）、1 人 1 対象 5 件まで。書き込みは 1 人 1 分 30 回まで。
- 印刷表示（`@media print`）は変えない。

## Review Focus

1. 自分の予定・メモへの反応が、API を直接叩いても拒否される（画面で隠すだけにしない）。
2. 他人の反応を、持ち主でも第三者でもない人が消せない。持ち主は消せる。
3. 通知の対象が、自分宛て（自分の人の予定・メモ）で、自分以外の人の反応だけになっている。部屋のメモと持ち主のいない予定は通知を作らない。
4. 既読が人ごとに独立している（他人が開いても自分の未読が減らない）。
5. 退会・予定の削除・メモの削除で、反応が孤児にならず、既存 DB への列の追加で壊れない。
6. 最初の取得では吹き出しも音も出ない。タブが隠れているときは取得しない。

---

## File Structure

- 新規 `lib/stamps.js`: スタンプ定数（ID・表示名）。
- 新規 `lib/reactions.js`: `reactionsRouter(db, guard)` を返す。検証・書き込み上限・要約・通知。
- 変更 `lib/db.js`: `reactions` 表・索引、`users.reactions_seen_id` の列。
- 変更 `server.js`: ルーターを `/api` に登録（`writeGuard` のあと）。
- 新規 `public/reactions.js`: スタンプ描画、反応欄、要約バッジ、ベル、吹き出し、音。
- 新規 `public/stamps/.gitkeep`、`docs/stamps.md`。
- 変更 `public/index.html`（ベルとパネル、閲覧ダイアログの反応欄、`reactions.js` の読み込み）、`public/app.js`（呼び出し）、`public/style.css`。
- 新規テスト `test/reactions-api.test.js`、`test/reactions-notify.test.js`、`test/reactions-page.test.js`。
- 変更 `README.md`、`docs/superpowers/specs/2026-11-06-user-accounts-design.md`（末尾に参照）。

---

### Task 1: データと、反応の追加・削除・一覧の API

**Files:**
- Create: `lib/stamps.js`, `lib/reactions.js`, `test/reactions-api.test.js`
- Modify: `lib/db.js`, `server.js`

**Interfaces:**
- Consumes: `guard.mine(req, personId)`、`req.user = {id, email, person_id}`、`InputError` / `UserError`（`server.js` の既存の定義の場所を確認して同じものを使う）、`db`。
- Produces:
  - `lib/stamps.js`: `module.exports = { STAMPS: [{id:'like', label:'いいね'}, …6 件], STAMP_IDS }`。
  - `lib/reactions.js`: `module.exports = { reactionsRouter(db, guard) }`。Task 2 が同じファイルにルートを足す。
  - `GET /api/reactions/:type/:id`、`POST /api/reactions`、`DELETE /api/reactions/:id`（仕様は下記）。

- [ ] **Step 1: 失敗するテストを書く**（`test/reactions-api.test.js`）。ログイン済みの 2 人（A・B）と、A の予定 1 件を用意するヘルパを作り、次を書く。
  - B が A の予定に `like` を付けると 201。もう一度付けると 200 で件数は増えない。
  - 不明なスタンプ ID は 400。型が `stay`/`memo` 以外は 400。存在しない対象は 404。
  - コメント: 前後の空白を除く、改行は空白 1 つ、空は 400、41 字は 400、40 字は 201（日本語の文字・絵文字をコードポイントで数える）、6 件目は 400 `この予定へのコメントは5件までです`。
  - A が自分の予定に付けると 400 `自分の予定には反応できません`（メモも同様）。
  - 部屋のメモ（`person_id` NULL）には誰でも付けられる。持ち主のいない人（ユーザーのいない人）の予定にも付けられる。
  - `GET /api/reactions/stay/:id` は古い順で、`mine` と `deletable` が呼び出した人ごとに正しい。未ログインでも読める（`mine`/`deletable` は偽）。
  - `DELETE`: 書いた本人 → 204。対象の持ち主 → 204。第三者 → 403。存在しない → 404。
  - 未ログインの POST/DELETE は 401 `{needLogin:true}`。
  - 書き込み上限: 1 人が 30 回目まで通り、31 回目は 429 `少し待ってからやり直してください`。`srv.advanceClock(60_000)` のあとはまた通る。別のユーザーは影響を受けない。
- [ ] **Step 2: 実行して、正しい理由で失敗することを確かめる。** `node --test test/reactions-api.test.js`（`/api/reactions` がまだ 404 になる）。
- [ ] **Step 3: 実装する。**
  - `lib/db.js`: スペックの SQL どおり `reactions` 表と索引 4 本を足す。`users` に `reactions_seen_id INTEGER NOT NULL DEFAULT 0` を、`PRAGMA table_info(users)` で調べてから `ALTER TABLE` で足す（新しい DB の `CREATE TABLE users` にも列を入れる）。
  - `lib/stamps.js`: 定数。
  - `lib/reactions.js`: 対象の読み込み（`type` が `stay` なら `stays`、`memo` なら `memos`。持ち主の `person_id` を得る）、検証、書き込み上限（Map＋固定窓、時刻は `Date.now()`。`failureLimiter` と同じ作法で、定期的に掃除する）、3 本のルート。コメント本文の整形は 1 関数にまとめる。
  - `server.js`: `app.use('/api/reactions', reactionsRouter(db, guard))` を、`guard.writeGuard` を使っている既存の並びの中に置く（書き込みガードより後ろ）。
- [ ] **Step 4: テストが通ることを確かめる。** `node --test test/reactions-api.test.js`、続けて `npm test`（143 件が壊れていないこと）。
- [ ] **Step 5: コミット。** `git add lib/stamps.js lib/reactions.js lib/db.js server.js test/reactions-api.test.js` → `反応（スタンプ・コメント）を付けて消す API を作る`。

---

### Task 2: 要約と通知の API、連鎖削除

**Files:**
- Modify: `lib/reactions.js`
- Create: `test/reactions-notify.test.js`

**Interfaces:**
- Consumes: Task 1 の `reactionsRouter`、`reactions` 表、`users.reactions_seen_id`。
- Produces:
  - `GET /api/reactions/summary?from=&to=`（ISO 日付 `YYYY-MM-DD`。`:type/:id` のルートより前に登録する）→ `{stays:{"<id>":{stamps:{like:2},mine:["like"],comments:1}}, memos:{…}}`。期間は `stays.end > from AND stays.start < to`（既存の `/api/stays` と同じ重なり判定。メモも同様）。反応のない対象は含めない。未ログインでも読める（`mine` は空）。
  - `GET /api/notifications` → `{unread, items:[{id,kind,stamp,body,created_at,from:{name,color},target:{type,id,date,label}}]}`。最大 50 件、新しい順、`id` の降順。ログインが必要（未ログインは 401）。
  - `POST /api/notifications/seen` → `{unread:0}`。`reactions_seen_id` を自分宛ての反応の最大 `id` に進める（自分宛てがなければ 0 のまま。減らさない）。

- [ ] **Step 1: 失敗するテストを書く**（`test/reactions-notify.test.js`）。
  - 要約: 期間内外の予定、スタンプの数、`mine`、コメント数、反応のない対象が出ないこと、メモも同様、不正な日付は 400。
  - 通知の対象: A の予定・メモへの B の反応は A の通知に出る。A 自身の反応は出ない（自分の対象には付けられないので、持ち主のいない人の予定・部屋のメモで確かめる）。部屋のメモと持ち主のいない人の予定への反応は、誰の通知にも出ない。B の通知には A 宛てのものが出ない。
  - 並びと上限: 60 件付けると 50 件だけ返り、新しい順。`unread` は 60 と数える。
  - 既読: `seen` のあと `unread` が 0。新しい反応が付くと 1 になる。A が `seen` しても B の `unread` は変わらない。`seen` は戻らない（2 回目も同じ）。
  - `target.label`: 予定は「<人の名前>の在室」、メモは題名。`target.date` は開始日。
  - 連鎖削除: 予定を `DELETE /api/stays/:id` で消すとその反応も消える（`reactions` を直接数える）。メモも同様。ユーザーが退会すると、その人が付けた反応が消え、その人の予定へ他人が付けた反応も（予定の連鎖で）消える。
  - 既存 DB への列の追加: `reactions_seen_id` のない `users` を持つ DB ファイルを作ってサーバーを起動しても落ちず、列が足されている（`test/auth-*` の既存の旧 DB テストの作り方を探して真似る。なければ `node:sqlite` で旧スキーマを手で作る）。
- [ ] **Step 2: 失敗を確かめる。**
- [ ] **Step 3: 実装する。** 通知の抽出は 1 本の SQL にまとめる（`reactions` を `stays` / `memos` と `LEFT JOIN` し、持ち主の `person_id = req.user.person_id` かつ `reactions.user_id <> req.user.id`、`users`・`people` を JOIN して `from` を得る）。
- [ ] **Step 4: 通ることを確かめる。** `npm test` 全体。
- [ ] **Step 5: コミット。** `反応の要約と通知の API を作る`。

---

### Task 3: スタンプの描画と、閲覧ダイアログの反応欄

**Files:**
- Create: `public/reactions.js`, `public/stamps/.gitkeep`, `test/reactions-page.test.js`
- Modify: `public/index.html`, `public/app.js`, `public/style.css`

**Interfaces:**
- Consumes: Task 1・2 の API。`app.js` の `api(method, url, body)`、`me`（ログイン中のユーザーか null）、`personById`、`avatar()`、`openViewDialog(kind, item, canEdit)`。
- Produces（`public/reactions.js` が `window.Reactions` に出す）:
  - `Reactions.STAMPS`（サーバーと同じ ID・表示名・順）。
  - `Reactions.stampEl(id, size)` → 画像（`/stamps/<id>.png`、読み込み失敗なら内蔵 SVG）を入れた `span.stamp`。
  - `Reactions.mountPane(container, {type, id, ownerPersonId, onChange})` → 反応欄を描画し、`{refresh(), destroy()}` を返す。
  - `Reactions.init({ api, getMe, personById })` は app.js の起動時に 1 回。
  - 後続タスクが追加で出すもの: `Reactions.badge(summaryEntry)`（Task 4）、`Reactions.startNotifications()` / `Reactions.stopNotifications()`（Task 5）。

- [ ] **Step 1: 失敗するテストを書く**（`test/reactions-page.test.js`）。`account.js` の既存テスト（`test/pages.test.js`）と同じ作りで、文字列の突き合わせをする。
  - `public/reactions.js` が参照する `#id` が `public/index.html` にある。
  - `reactions.js` の `STAMPS` の ID と順が `lib/stamps.js` と一致する。
  - `index.html` が `/reactions.js` を `app.js` より前に読み込む。
  - `reactions.js` に `innerHTML` が出てこない（ユーザー入力を入れない決まりの簡易チェック。許す例外があるなら、理由をテスト内のコメントで書く）。
  - `GET /reactions.js` と `GET /stamps/.gitkeep` ではなく `/stamps/like.png` が無いときは 404 になること（画像がなくても落ちない）を確かめる。
- [ ] **Step 2: 失敗を確かめる。**
- [ ] **Step 3: 実装する。**
  - 内蔵 SVG: 6 種を、丸い顔の簡単なイラストとして `reactions.js` 内の定数に持つ（`<svg viewBox="0 0 32 32">`、`createElementNS` で組む。文字列を `innerHTML` に入れない）。色は既存のトークン（`style.css` の `:root`）に合わせる。
  - `mountPane`: スタンプボタン 6 個（押された状態は `aria-pressed`、数をボタンの横に）、コメント入力（`maxlength=40`、残り字数）、一覧（付けた人の色の丸＋名前＋スタンプかコメント＋削除ボタン）。自分の対象（`ownerPersonId === me.person_id`）ではスタンプとコメント入力を出さない。未ログインでは操作部分を出さず「反応するにはログインしてください」を出す。通信失敗は欄の中に赤字。429 は上限の文言。404 は欄を閉じる合図として `onChange({gone:true})` を呼ぶ。
  - `index.html`: 閲覧ダイアログ（`#viewDialog`）の中に `<section id="viewReactions">` を足す。`openViewDialog` が `Reactions.mountPane` を呼び、ダイアログを閉じるとき `destroy()` する。反応を付けたら `onChange` で、カレンダーの要約を取り直す（Task 4 で結ぶ。ここでは呼び出しだけ用意する）。
  - スタイル: `style.css` に反応欄のスタイル（丸いスタンプボタン、押された状態、コメントの吹き出し風の行）。電話の幅でも 16px 以上の入力、はみ出しなし。
- [ ] **Step 4: テストと、スクラッチのサーバーでの目視。** `npm test`。`DATA_DIR=<mktemp -d> ENV_FILE=/nonexistent PORT=3177 node server.js` を立て、2 人でログインして、反応欄が出ること・付けられること・消せることを Playwright（`/home/ddd3h/kurawaku/node_modules/playwright`）で確かめ、スクリーンショットを撮って見る。サーバーは自分で立てたものだけを PID で止める（`pkill -f "node server.js"` は使わない）。
- [ ] **Step 5: コミット。** `閲覧ダイアログにスタンプとコメントの反応欄を付ける`。

---

### Task 4: カレンダー上の反応数と、編集ダイアログの一覧

**Files:**
- Modify: `public/reactions.js`, `public/app.js`, `public/style.css`, `test/reactions-page.test.js`

**Interfaces:**
- Consumes: Task 2 の要約 API、Task 3 の `Reactions.*`。`app.js` の `initCalendar` の `events` 取得部、`eventContent`（`app.js` 約 701 行）、`memoContent`（約 814 行）、`openStayDialog` / `openMemoDialog`。
- Produces: `Reactions.setSummary(summary)`、`Reactions.badge(type, id)` → 要素または null。

- [ ] **Step 1: 失敗するテストを書く。** 突き合わせテストに、`app.js` が `Reactions.setSummary` を呼ぶ箇所と `.reaction-badge` のスタイルがあることを足す。サーバー側の追加はない。
- [ ] **Step 2: 失敗を確かめる。**
- [ ] **Step 3: 実装する。**
  - 予定を読み込むたび（`events` の取得）に、同じ期間で `GET /api/reactions/summary` を取り、`Reactions.setSummary` に渡して、描画済みの予定の要素にバッジを足す（`eventDidMount` でも、要約が遅れて届いたときの再描画でも付く作りにする）。要約の取得に失敗しても予定は出す。
  - バッジ: 予定の右下に、吹き出しアイコンと合計数（スタンプ＋コメント）の小さな表示。0 件なら出さない。`@media print` では隠す。
  - 反応を付けた・消した直後（`onChange`）に、要約を取り直す。
  - 自分の予定・メモの編集ダイアログ（既存のものを開いたとき）の下に、読み取り専用の反応一覧を出す（`mountPane` に `readonly: true` を渡す。新規作成のときは出さない）。
- [ ] **Step 4: 通ることと目視を確かめる。** `npm test`、Playwright で 2 人のログインから、反応が付くとバッジの数が増え、消すと減ることを確かめる。月・週表示のスクリーンショットを見る。
- [ ] **Step 5: コミット。** `カレンダーの予定に反応の数を出す`。

---

### Task 5: ベル・履歴・吹き出し・音

**Files:**
- Modify: `public/reactions.js`, `public/index.html`, `public/app.js`, `public/style.css`, `test/reactions-page.test.js`

**Interfaces:**
- Consumes: Task 2 の通知 API、`app.js` の `loadMe`、ログイン・ログアウトの切り替え処理、`kbGoto(date)` または FullCalendar の `calendar.gotoDate`。
- Produces: `Reactions.startNotifications({ gotoDate(dateStr), findEventEl(type, id) })` / `Reactions.stopNotifications()`。`app.js` は、ログイン状態が確定したとき（`loadMe` のあと）に `start`、ログアウトのときに `stop` を呼ぶ。

- [ ] **Step 1: 失敗するテストを書く。** 突き合わせテストに、`#bellBtn` `#bellBadge` `#bellPanel` `#muteToggle` が `index.html` にあること、ベルが `hidden` で始まること、`reactions.js` に `visibilitychange` の処理と 30000 の周期があること、`localStorage` の読み書きがすべて `try` の中にあることを足す。さらに、`reactions.js` の音の合成関数が、`AudioContext` のない環境（`globalThis` に何もない）で例外を投げないことを、Node 上で関数を取り出して呼んで確かめる（取り出せる形に分けて書く）。
- [ ] **Step 2: 失敗を確かめる。**
- [ ] **Step 3: 実装する。**
  - ベル（`#bellBtn`）: `#loginBtn` の隣に置く。ログイン中だけ出す。未読数のバッジ（99 を超えたら `99+`）。電話の幅で切れない（既存の `#loginBtn` の作法に合わせ、モバイルの CSS を確かめる）。
  - パネル（`#bellPanel`）: 開くと `GET /api/notifications` を取り、新しい順に最大 50 件。各行は名前＋スタンプまたはコメント＋相対時刻＋対象のラベル。未読は強調。行を押すと `gotoDate(target.date)` してパネルを閉じる。開いた時点で `POST /api/notifications/seen`、バッジを消す。Esc と外側クリックで閉じる。フォーカスはパネルへ移し、閉じたらベルへ戻す。左右 16px 内に収める。パネル内に「音」のオン・オフ（`#muteToggle`、初期は音あり。`localStorage` に覚える。読み書きは `try/catch`）。
  - 取得: ログイン中、30 秒ごと、およびタブが見える状態に戻ったとき。隠れている間は呼ばない。失敗しても画面は壊さず次の周期に回す。
  - 新着: 取得結果のうち、これまでに見せた最大の `id` を超える項目。**最初の取得では見せた最大の `id` を初期化するだけで、吹き出しも音も出さない。** 該当する予定の要素が見えているとき（`findEventEl`）、その上に丸い吹き出し（スタンプの画像、またはコメント本文）を「ぽこっ」と出して 3 秒で消す。見えていなければバッジだけ増える。
  - 音: Web Audio API で短い「ぽん」（短い正弦波の立ち上がりと減衰）を合成する。1 回の取得につき 1 回だけ。ミュート中、`AudioContext` が使えないとき、まだ操作されていないときは、何も言わずに鳴らさない。最初のユーザー操作（`pointerdown`/`keydown`）で `AudioContext` を作って `resume()` する。
  - `prefers-reduced-motion` のとき、吹き出しの動きを止める（表示だけ）。
- [ ] **Step 4: 通ることと目視を確かめる。** `npm test`。Playwright で 2 つのブラウザコンテキスト（A・B）をログインさせ、B が A の予定に反応 → A 側で（30 秒を待たず、テスト用に `visibilitychange` を発火させるか、周期を待って）吹き出し・バッジ・履歴・既読・行から日付への移動・ミュート・削除を確かめる。電話の幅（iPhone 14 / Pixel 7 のエミュレーション）でベルとパネルがはみ出さないことを、スクリーンショットで見る。
- [ ] **Step 5: コミット。** `ベルの履歴と、新着の吹き出し・音を付ける`。

---

### Task 6: ドキュメントとスタンプ画像の用意

**Files:**
- Create: `docs/stamps.md`
- Modify: `README.md`, `docs/superpowers/specs/2026-11-06-user-accounts-design.md`

- [ ] **Step 1:** `docs/stamps.md` に、6 種それぞれの ID・表示名・絵のイメージ、画像の仕様（PNG、正方形 256×256、背景透過、置き場所 `public/stamps/<id>.png`、太い輪郭線で、やわらかい色、LINE スタンプのような丸い顔）、Codex（画像生成）に渡す指示文（全体の統一指示＋ 6 種の個別指示）を書く。
- [ ] **Step 2:** `README.md` に、反応機能の使い方（スタンプ、コメント、ベル、音、ミュート、更新が最長約 30 秒遅れること）、API 一覧、書き込み上限、画像の差し替え方を足す。アカウント基盤のスペックの末尾に、本設計への参照を 1 行足す。
- [ ] **Step 3:** `npm test` が通ることを確かめる。
- [ ] **Step 4: コミット。** `反応機能の README とスタンプ画像の用意を書く`。

---

## 最後に

全タスクのあと、ブランチ全体を最も強いモデルでレビューし、指摘を 1 回の修正でまとめて直す。そのあと、実ブラウザ（Playwright、Chromium と WebKit）で 2 人のログインの通しと、電話の幅のスクリーンショットを確認する。
