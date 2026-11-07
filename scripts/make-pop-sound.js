// 新着の「ぽん」の音声ファイル（public/sounds/pop.wav）を作る。依存パッケージなし。
//   node scripts/make-pop-sound.js
// 約0.22秒。サイン波が 520Hz から 900Hz へ 0.09秒で上がり、すぐ減衰する（モノラル・16bit・44.1kHz）。
// 別の音にしたいときは、同じ名前の音声ファイルで置き換えればよい（wav / mp3 / ogg。パスを変えるなら public/reactions.js の POP_SRC）。
const fs = require('node:fs');
const path = require('node:path');

const RATE = 44100;
const DURATION = 0.22;
const PEAK = 0.2; // 0〜1
const n = Math.floor(RATE * DURATION);
const samples = new Int16Array(n);
let phase = 0;
for (let i = 0; i < n; i++) {
  const t = i / RATE;
  // 周波数: 0.09秒かけて指数的に 520 → 900Hz、そのあとは 900Hz のまま
  const freq = t < 0.09 ? 520 * (900 / 520) ** (t / 0.09) : 900;
  phase += (2 * Math.PI * freq) / RATE;
  // 音量: 15ミリ秒で立ち上がり（指数）、0.2秒までに 0.0001 まで減衰
  const env = t < 0.015 ? 0.0001 * (1 / 0.0001) ** (t / 0.015) : t < 0.2 ? 1 * (0.0001) ** ((t - 0.015) / 0.185) : 0;
  samples[i] = Math.round(Math.sin(phase) * env * PEAK * 32767);
}

const data = Buffer.from(samples.buffer);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16); // fmt チャンクの長さ
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // モノラル
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // バイト毎秒
header.writeUInt16LE(2, 32); // ブロックサイズ
header.writeUInt16LE(16, 34); // ビット数
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const out = path.join(__dirname, '..', 'public', 'sounds', 'pop.wav');
fs.writeFileSync(out, Buffer.concat([header, data]));
console.log(`${out} (${header.length + data.length} bytes, ${DURATION}s)`);
