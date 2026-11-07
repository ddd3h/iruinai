// テスト用: 子プロセス（server.js）の Date.now() を進められるようにする（NODE_OPTIONS=--require で読み込む）。
// 総当たり対策などの「1分たつと戻る」を、実際に待たずに確かめるため。製品のコードには何も足さない。
// 進める量は DATA_DIR/clock-offset（ミリ秒）に書く。テスト側は helpers.js の srv.advanceClock(ms) を使う
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.env.DATA_DIR || '', 'clock-offset');
const realNow = Date.now.bind(Date);
let offset = 0;

Date.now = () => {
  try {
    const n = Number(fs.readFileSync(file, 'utf8'));
    if (Number.isFinite(n)) offset = n;
  } catch {
    // まだない・読めない: 直前の値のまま
  }
  return realNow() + offset;
};
