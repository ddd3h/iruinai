// アプリの名前。画面の見出し・タブのタイトル・共有時のタイトル・ログインの画面・メールの件名と本文に出る。
// .env の APP_TITLE で変えられる（未設定・空・空白だけなら既定の名前）
const DEFAULT_TITLE = '在室カレンダー';
const MAX_LENGTH = 40; // コードポイントの数

// 呼ぶたびに環境変数を読む（server.js が .env を読んだあとの値を、読み込みの順番に頼らず使うため）。
// 前後の空白を取り、空白・改行（CR/LF を含む）・制御文字の連なりは 1つの空白にして、40文字で切る。
// 1行にまとめるのは、メールの件名に改行を入れさせないため。HTML に出すときの escape は、呼び出し側で行う
function appTitle() {
  const oneLine = String(process.env.APP_TITLE ?? '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
  const cut = [...oneLine].slice(0, MAX_LENGTH).join('').trimEnd();
  return cut || DEFAULT_TITLE;
}

module.exports = { appTitle, DEFAULT_TITLE };
