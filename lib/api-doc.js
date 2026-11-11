// AI やスクリプトに渡す API の仕様書（lib/api-doc.md）を返す。{BASE} は、公開 URL かアクセス先の URL に置き換える
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'api-doc.md'), 'utf8');

function apiDoc(publicUrl) {
  const fixed = (publicUrl || '').replace(/\/+$/, '');
  return (req, res) => {
    const base = fixed || `${req.protocol}://${req.get('host')}`;
    // 関数で返す。base の中の `$&` などが、置き換えの特別な書き方に読まれないようにする
    // text/plain にするのは、ブラウザで開いてもそのまま読めるようにするため
    res.type('text/plain; charset=utf-8').send(SOURCE.replace(/\{BASE\}/g, () => base));
  };
}

module.exports = { apiDoc };
