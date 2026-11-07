// 新着の「ぽーん」の音声ファイル（public/sounds/pop.wav）を作る。依存パッケージなし。
//   node scripts/make-pop-sound.js
// 約1秒。サイン波が 520Hz から 880Hz へ 0.09秒で上がり、そのあと余韻が約1秒かけてやわらかく消える
// （2倍音を少し混ぜて、ベルのように丸く響かせる。モノラル・16bit・44.1kHz）。
// 別の音にしたいときは、同じ名前の音声ファイルで置き換えればよい（wav / mp3 / ogg。パスを変えるなら public/reactions.js の POP_SRC）。
const fs = require('node:fs');
const path = require('node:path');

const RATE = 44100;
const DURATION = 1.0;
const PEAK = 0.26; // 0〜1
const SWEEP = 0.09; // 秒。ここまでで 520 → 880Hz
const n = Math.floor(RATE * DURATION);
const samples = new Int16Array(n);
let phase = 0;
for (let i = 0; i < n; i++) {
  const t = i / RATE;
  const freq = t < SWEEP ? 520 * (880 / 520) ** (t / SWEEP) : 880;
  phase += (2 * Math.PI * freq) / RATE;
  // 音量: 12ミリ秒で立ち上がり、そのあとは指数的に減衰（1秒で約 1/70）。最後の 80ミリ秒でゼロへ絞る（プチ音を避ける）
  const attack = t < 0.012 ? t / 0.012 : 1;
  const decay = Math.exp(-t * 4.2);
  const tail = t > DURATION - 0.08 ? (DURATION - t) / 0.08 : 1;
  // 基本音と、少し遅れて消える 2倍音（やわらかい響き）
  const tone = Math.sin(phase) + 0.28 * Math.sin(2 * phase) * Math.exp(-t * 3);
  samples[i] = Math.round((tone / 1.28) * attack * decay * tail * PEAK * 32767);
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
