// 日本の祝日（現行の祝日法に基づく計算。春分・秋分は 1980〜2099 年の近似式）
const holidayCache = new Map();

function nthMonday(year, month, n) {
  const first = new Date(year, month - 1, 1).getDay();
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

function holidaysOf(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const pad = (n) => String(n).padStart(2, '0');
  const key = (m, d) => `${year}-${pad(m)}-${pad(d)}`;
  const k = year - 1980;
  const shunbun = Math.floor(20.8431 + 0.242194 * k - Math.floor(k / 4));
  const shubun = Math.floor(23.2488 + 0.242194 * k - Math.floor(k / 4));

  const map = new Map([
    [key(1, 1), '元日'],
    [key(1, nthMonday(year, 1, 2)), '成人の日'],
    [key(2, 11), '建国記念の日'],
    [key(2, 23), '天皇誕生日'],
    [key(3, shunbun), '春分の日'],
    [key(4, 29), '昭和の日'],
    [key(5, 3), '憲法記念日'],
    [key(5, 4), 'みどりの日'],
    [key(5, 5), 'こどもの日'],
    [key(7, nthMonday(year, 7, 3)), '海の日'],
    [key(8, 11), '山の日'],
    [key(9, nthMonday(year, 9, 3)), '敬老の日'],
    [key(9, shubun), '秋分の日'],
    [key(10, nthMonday(year, 10, 2)), 'スポーツの日'],
    [key(11, 3), '文化の日'],
    [key(11, 23), '勤労感謝の日'],
  ]);

  const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const base = [...map.keys()].sort();

  // 国民の休日：祝日に挟まれた平日
  for (const s of base) {
    const d = new Date(s + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    const mid = toKey(d);
    d.setDate(d.getDate() + 1);
    if (!map.has(mid) && map.has(toKey(d)) && new Date(mid + 'T00:00:00').getDay() !== 0) {
      map.set(mid, '国民の休日');
    }
  }

  // 振替休日：日曜の祝日の後、最初の祝日でない日
  for (const s of base) {
    const d = new Date(s + 'T00:00:00');
    if (d.getDay() !== 0) continue;
    do d.setDate(d.getDate() + 1); while (map.has(toKey(d)));
    map.set(toKey(d), '振替休日');
  }

  holidayCache.set(year, map);
  return map;
}

// Date → 祝日名（祝日でなければ undefined）
function holidayName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return holidaysOf(date.getFullYear())
    .get(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
}
