# 在室カレンダー API

部屋の在室（stay）とメモ（memo）を、人（person）ごとに管理するサービスの HTTP API です。AI やスクリプトは、API トークンで、トークンの持ち主と同じ操作ができます。

- ベース URL: `{BASE}`
- 形式: リクエストもレスポンスも JSON（`Content-Type: application/json`）。日付と時刻はすべて、タイムゾーンなしの現地時刻です。
- この文書: `GET {BASE}/api/docs`

## 認証

すべてのリクエストに、次のヘッダーを付けます。

```
Authorization: Bearer <トークン>
```

- トークンは `iruinai_` で始まります。持ち主が、画面の「APIトークン」から発行します。
- **最後に使ってから1週間使われないと無効になります**（使うたびに1週間に延びます）。無効なトークンでの書き込みは `401` です。合言葉が必要なサイトでは、読み取りも `401` になります。持ち主に、作り直しを頼んでください。
- 1人につきトークンは1つです。作り直すと、古いトークンはすぐ使えなくなります。
- 合言葉の入力も、メールとパスワードのログインも要りません。

### 権限

- 読み取り（`GET`）は、全員の分を見られます。
- 書き込みは、**トークンの持ち主の人（person）の在室とメモ**だけです。他の人のものは `403`（`他の人の予定やメモは変更できません`）です。
- 持ち主のいない「部屋のメモ」（`person_id` が `null`）は、誰でも作成・変更・削除できます。
- トークンでできないこと（`403`、`この操作は、トークンではできません`）: `/api/auth/*`（ログイン・登録・パスワード）、`/api/me/withdraw`（退会）、`/api/me/token`（トークン自身の発行・無効化）。画面のページ（`/` など）も開けません。

## 共通のルール

- エラーは `{ "error": "メッセージ" }` です。ステータスは次のとおりです。

| ステータス | 意味 |
| --- | --- |
| `400` | 入力が正しくありません |
| `401` | トークンが無効か、期限切れです（`needLogin: true` が付きます） |
| `403` | 他の人のものを操作しようとしました |
| `404` | 見つかりません |
| `429` | 回数の上限です。少し待ってください |

- 時刻の形式: 時間指定は `YYYY-MM-DDTHH:MM:SS`（例: `2030-01-05T09:00:00`）。終日は `YYYY-MM-DD`。
- 期間は、**開始を含み、終了を含みません**（`start < end` が必要です）。
- 一覧の `start` と `end`（クエリ）には、日付（`2030-01-01`）か日時を渡します。期間と重なるものがすべて返ります。
- 変更系の `id` を持つ API は、存在しない `id` に `404`（削除は `204`）を返します。

## データの形

- 人（person）: `{ "id": 1, "name": "さくら", "color": "#e5484d", "icon_path": "/uploads/x.webp" | null, "claimed": 0 | 1 }`（`claimed` が `1` なら、アカウントと紐付いた人）
- 在室（stay）: `{ "id": 10, "person_id": 1, "start": "2030-01-05T09:00:00", "end": "2030-01-05T18:00:00", "note": "" }`
- メモ（memo）: `{ "id": 7, "person_id": 1 | null, "title": "掃除", "all_day": 0 | 1, "start": "...", "end": "..." }`（終日のメモの `end` は最終日の翌日）

## 自分と人

### GET /api/me

トークンの持ち主。`{ "user": { "id": 3, "email": "a@example.com", "person_id": 1 } }` を返します。`person_id` が、書き込める人です。無効なトークンなら `{ "user": null }` です。

### GET /api/docs

この文書（`text/plain`）。

### GET /api/people

人の一覧。人の配列を返します。

### PUT /api/people/:id

自分の人だけ変更できます。`{ "name": "新しい名前", "color": "#1f9d55" }` を送ります（省略した項目は変わりません。`color` は `#rrggbb`）。更新後の人に、変更前の `before` を付けて返します。

### POST /api/people/restore

画面の「元に戻す」用です。自分の人を、`{ "person": { "id", "name", "color", "icon_path" } }` の値に戻します。`200` で人を返します。通常は使いません。

## 在室（stay）

### GET /api/stays

`?start=2030-01-01&end=2030-02-01` で、期間と重なる在室の配列を、開始の早い順に返します。`start` と `end` の両方がなければ、すべて返します。

### POST /api/stays

1件追加します。`{ "person_id": 1, "start": "2030-01-05T09:00:00", "end": "2030-01-05T18:00:00", "note": "ゼミ" }`（`note` は省略可）。`201` で在室を返します。`person_id` は自分の人だけです。

### POST /api/stays/batch

同じ時間で、複数の日に追加します。`{ "person_id": 1, "dates": ["2030-01-05", "2030-01-06"], "startTime": "09:00", "endTime": "18:00", "note": "" }`（`dates` は100件まで、`startTime < endTime`）。`201` で `{ "created": 2, "ids": [11, 12] }` を返します。

### POST /api/stays/import

1人分をまとめて登録します。`{ "person_id": 1, "items": [{ "start": "2030-01-05T09:00:00", "end": "2030-01-05T18:00:00", "note": "" }] }`（1000件まで。各項目は同じ日の中。同じ人・開始・終了がすでにあれば飛ばします。`note` は100字まで）。`201` で `{ "created": 1, "ids": [13], "skipped": 0 }` を返します。

### PUT /api/stays/:id

変更します。送った項目だけが変わります（`person_id`・`start`・`end`・`note`）。変更後の在室に、変更前の `before` を付けて返します。他の人への付け替えは `403` です。

### DELETE /api/stays/:id

削除します。消した在室を返します（もうなければ `204`）。

### POST /api/stays/remove

まとめて削除します。`{ "ids": [11, 12] }`（1000件まで）。1件でも他の人のものがあれば、何も消さず `403` です。`204` を返します。

### POST /api/stays/restore

画面の「元に戻す」用です。消した在室を、同じ `id` で書き戻します。`{ "items": [在室, ...] }`。`204` を返します。通常は使いません。

## メモ（memo）

### GET /api/memos

`?start=&end=` で、期間と重なるメモの配列を返します（`/api/stays` と同じ規則）。

### POST /api/memos/batch

同じ内容を、複数の期間に追加します。`{ "person_id": 1, "title": "掃除", "all_day": 1, "items": [{ "start": "2030-01-05", "end": "2030-01-06" }] }`。`person_id` は、自分の人か `null`（部屋のメモ）です。`title` は1〜100字、`items` は100件まで。`all_day` が `1` のときは日付、`0` のときは日時で書きます。`201` で `{ "created": 1, "ids": [20] }` を返します。

### PUT /api/memos/:id

変更します。送った項目だけが変わります（`person_id`・`title`・`all_day`・`start`・`end`）。変更後のメモに `before` を付けて返します。

### DELETE /api/memos/:id

削除します。消したメモを返します（もうなければ `204`）。

### POST /api/memos/remove

まとめて削除します。`{ "ids": [20, 21] }`（1000件まで）。`204` を返します。

### POST /api/memos/restore

画面の「元に戻す」用です。`{ "items": [メモ, ...] }` を同じ `id` で書き戻します。`204` を返します。通常は使いません。

## 反応（スタンプとコメント）

他の人の在室（`stay`）やメモ（`memo`）に、スタンプかコメントを付けられます。自分の在室・メモには付けられません（`400`）。

スタンプの ID は次の6つです: `like`（いいね）、`angry`（おこ）、`sad`（かなしい）、`thanks`（ありがとう）、`otsu`（おつかれ）、`laugh`（わらい）。

### GET /api/reactions/summary

`?from=2030-01-01&to=2030-02-01` で、期間内の予定とメモごとの反応の要約を返します。反応のないものは含みません。

```json
{ "stays": { "10": { "stamps": { "like": 2 }, "mine": ["like"], "comments": 1 } }, "memos": {} }
```

### GET /api/reactions/:type/:id

1つの在室（`:type` が `stay`）かメモ（`memo`）の反応を、古い順に返します。各項目は `{ "id", "kind": "stamp" | "comment", "stamp", "body", "created_at", "user": { "person_id", "name", "color", "icon_path" }, "mine", "deletable" }` です。

### POST /api/reactions

反応を付けます。スタンプは `{ "type": "stay", "id": 10, "stamp": "like" }`、コメントは `{ "type": "stay", "id": 10, "body": "おつかれさま" }`（`stamp` と `body` はどちらか一方）。コメントは1〜40字で、1つの対象に5件までです。新しく付けたら `201`、同じスタンプがすでにあれば `200` で、反応の項目を返します。書き込みは、1人が1分に30回まで（追加と削除の合計）です。超えると `429` です。

### DELETE /api/reactions/:id

反応を消します。消せるのは、付けた本人だけです（`403`）。`204` を返します。

## 通知

### GET /api/notifications

自分の在室・メモへの、他の人の反応を、新しい順に50件まで返します。`{ "unread": 2, "items": [{ "id", "kind", "stamp", "body", "created_at", "from": { "name", "color", "icon_path" }, "target": { "type", "id", "date", "label" } }] }`。

### POST /api/notifications/seen

既読にします。`{ "unread": 0 }` を返します。

## 使用例

```
curl -H "Authorization: Bearer iruinai_..." "{BASE}/api/stays?start=2030-01-01&end=2030-02-01"

curl -X POST -H "Authorization: Bearer iruinai_..." -H "Content-Type: application/json" \
  -d '{"person_id":1,"start":"2030-01-05T09:00:00","end":"2030-01-05T18:00:00","note":"ゼミ"}' \
  "{BASE}/api/stays"
```

まず `GET /api/me` で自分の `person_id` を調べてから、書き込んでください。
