// スタンプの ID と表示名。画面の並びと同じ順。public/reactions.js にも同じ並びを持つ（テストで一致を確かめる）
const STAMPS = [
  { id: 'like', label: 'いいね' },
  { id: 'angry', label: 'おこ' },
  { id: 'sad', label: 'かなしい' },
  { id: 'thanks', label: 'ありがとう' },
  { id: 'otsu', label: 'おつかれ' },
  { id: 'laugh', label: 'わらい' },
];
const STAMP_IDS = STAMPS.map((s) => s.id);

module.exports = { STAMPS, STAMP_IDS };
