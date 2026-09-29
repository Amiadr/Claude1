// הערכת המסווג על ערכות ניתוח שיוצאו מהאפליקציה ("ייצוא לניתוח"): ZIP או תיקייה עם labels.json ו-clips/*.wav.
// לכל קליפ: מה המשתמש תייג, מה האפליקציה אמרה בזמן הייצוא, ומה המסווג הנוכחי אומר. בסוף סיכום לפי תיוג.
// הרצה: node tests/eval-samples.js <ערכה.zip | תיקייה> [...עוד ערכות] [-v]
//   -v  מדפיס גם את המקטעים של כל קליפ (דפיקות, רעש רציף, נשימה, רחב-פס)
// קוד יציאה 1 אם יש קליפ מתויג שהסיווג הנוכחי לא תואם לו (תיוג "אחר" לא נבדק).
const fs = require('fs');
const path = require('path');
require(path.resolve(__dirname, '..', 'docs', 'scan.js'));
const NS = globalThis.NoiseScan;

const LABEL_EXPECT = { wall: ['bang', 'bangdrag'], drag: ['noise', 'bangdrag'], chair: ['bang', 'bangdrag'], breath: ['breath'], speech: ['speech'], handling: ['handling'], background: ['noise'], other: [] };
const KIND_HE = { bang: 'דפיקה', bangdrag: 'דפיקה+גרירה', handling: 'ליד המכשיר', noise: 'רעש רציף', breath: 'נשימה', speech: 'דיבור', unknown: 'לא ידוע' };

// קורא ZIP שנכתב בלי דחיסה (כמו makeZip באפליקציה): רשומות מקומיות ברצף
function readZip(buf) {
  const files = new Map(); let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8), size = buf.readUInt32LE(p + 22), nameLen = buf.readUInt16LE(p + 26), extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8'); const start = p + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error(`הרשומה ${name} דחוסה; הסקריפט קורא רק ZIP ללא דחיסה (כמו שהאפליקציה כותבת)`);
    files.set(name, buf.subarray(start, start + size)); p = start + size;
  }
  return files;
}
function loadBundle(src) {
  if (fs.statSync(src).isDirectory()) {
    const meta = JSON.parse(fs.readFileSync(path.join(src, 'labels.json'), 'utf8'));
    return { name: src, meta, read: (f) => fs.readFileSync(path.join(src, f)) };
  }
  const files = readZip(fs.readFileSync(src));
  if (!files.has('labels.json')) throw new Error(`${src}: אין labels.json בערכה`);
  return { name: src, meta: JSON.parse(files.get('labels.json').toString('utf8')), read: (f) => { if (!files.has(f)) throw new Error(`חסר ${f}`); return files.get(f); } };
}
async function wavToSamples(buf, name) {
  const s = await NS.open(new File([buf], name)); if (!s.info || !s.info.supported) throw new Error(`${name}: לא WAV תקין`);
  return { samples: await s.extract(0, s.info.durationSec), sampleRate: s.info.sampleRate };
}
const segText = (cls) => cls.segments.map((g) => `${g.kind === 'bang' ? 'דפיקה' : g.kind === 'drag' ? 'רציף' : g.kind}${g.broadband ? '*' : ''}@${g.sec.toFixed(1)}${g.kind === 'bang' ? ` ${g.heightDb}dB` : ` ${g.dur}s`}`).join(', ');

(async () => {
  const args = process.argv.slice(2); const verbose = args.includes('-v'); const srcs = args.filter((a) => a !== '-v');
  if (!srcs.length) { console.error('usage: eval-samples.js <bundle.zip|dir> [...] [-v]'); process.exit(2); }
  const rows = []; let fails = 0;
  for (const src of srcs) {
    const b = loadBundle(src);
    console.log(`\n=== ${b.name}: ${b.meta.clips.length} קליפים, יוצאו ${b.meta.exportedAt || '?'}, מכשיר ${b.meta.device || '?'}`);
    for (const c of b.meta.clips) {
      const { samples, sampleRate } = await wavToSamples(b.read(c.file), path.basename(c.file));
      const cls = NS.classify(samples, sampleRate);
      const expect = LABEL_EXPECT[c.label]; const checked = !!(expect && expect.length);
      const ok = checked ? expect.includes(cls.kind) : null;
      if (ok === false) fails++;
      const mark = ok === null ? '  ' : ok ? 'ok' : '!!';
      const label = c.label ? (c.label === 'other' ? `אחר: ${c.labelText || ''}` : (b.meta.labels && b.meta.labels[c.label]) || c.label) : '(לא תויג)';
      const changed = c.kind && c.kind !== cls.kind ? ` (בייצוא: ${KIND_HE[c.kind] || c.kind})` : '';
      console.log(`${mark} ${path.basename(c.file).padEnd(44)} תיוג: ${label.padEnd(16)} עכשיו: ${(KIND_HE[cls.kind] || cls.kind).padEnd(12)} ${cls.knocks} דפיקות${cls.broadband ? `, ${cls.broadband} רחב-פס` : ''}${changed}${c.note ? `  הערה: ${c.note}` : ''}`);
      if (verbose) console.log(`      ${segText(cls) || 'בלי מקטעים'}  (רקע ${(cls.floorDb + 100).toFixed(0)}, שיא ${c.peakDb})`);
      rows.push({ label: c.label || '', ok });
    }
  }
  const byLabel = {};
  for (const r of rows) { const k = r.label || '(לא תויג)'; byLabel[k] = byLabel[k] || { n: 0, ok: 0, checked: 0 }; byLabel[k].n++; if (r.ok !== null) { byLabel[k].checked++; if (r.ok) byLabel[k].ok++; } }
  console.log('\nסיכום לפי תיוג:');
  for (const [k, v] of Object.entries(byLabel)) console.log(`  ${k.padEnd(12)} ${v.n} קליפים${v.checked ? `, ${v.ok}/${v.checked} מסווגים נכון` : ''}`);
  console.log(fails ? `\n${fails} קליפים מתויגים מסווגים לא נכון` : '\nכל הקליפים המתויגים מסווגים נכון');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
