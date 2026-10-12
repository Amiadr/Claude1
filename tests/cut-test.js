// בדיקת קצה-לקצה לדף החיתוך (cut.html): פתיחת WAV ו-MP3, חיתוך לפי שעות, פיצול לחלקים, שמירת הזמן המקורי
// (שם הקובץ + ICRD), וייבוא החלק באפליקציה עם זמן ההתחלה הנכון.
// הרצה: node tests/cut-test.js <dir with test files> <outdir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { startServer } = require('./serve');
require(path.resolve(__dirname, '..', 'docs', 'scan.js'));
const NS = globalThis.NoiseScan;

const [,, dir, outDir] = process.argv;
if (!dir || !outDir) { console.error('usage: cut-test.js testdir outdir'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
let fails = 0;
function assert(c, msg) { if (!c) { fails++; console.error('FAIL:', msg); } else console.log('ok  :', msg); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
async function wavInfo(file) { const buf = fs.readFileSync(file); const s = await NS.open(new File([buf], path.basename(file))); const samples = await s.extract(0, s.info.durationSec); return { info: s.info, samples }; }
const localMs = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();

(async () => {
  const server = await startServer(8771);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => { fails++; console.error('PAGE ERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto('http://127.0.0.1:8771/cut.html');
  await page.waitForFunction(() => window.__noiseCut);

  // ---- WAV: זמן מהשם, חיתוך 23:00:10–23:00:25 ב-16 kHz ----
  await page.setInputFiles('#cutFile', path.join(dir, 'night_2026-09-26_23-00-00.wav'));
  await page.waitForFunction(() => !document.querySelector('#cutWork').hidden, null, { timeout: 20000 });
  assert((await page.inputValue('#cutDate')) === '2026-09-26' && /^23:00(:00)?$/.test(await page.inputValue('#cutTime')), `wav: start time from file name (${await page.inputValue('#cutDate')} ${await page.inputValue('#cutTime')})`);
  assert((await page.inputValue('#cutPrefix')) === 'night', `wav: default name prefix without the date (${await page.inputValue('#cutPrefix')})`);
  // ברירת מחדל: כל הקובץ, הכפתור פעיל בלי לגעת בכלום
  assert((await page.inputValue('#cutFrom')) === '23:00:00' && (await page.inputValue('#cutTo')) === '23:00:40' && !(await page.$eval('#cutGoBtn', (b) => b.disabled)) && /כל הקובץ/.test(await page.$eval('#cutSelInfo', (el) => el.textContent)), `wav: default range is the whole file (${await page.inputValue('#cutFrom')}–${await page.inputValue('#cutTo')})`);
  // X דקות מנקודה: מהשעה 23:00:10, משך 0.25 דקות → עד 23:00:25
  await page.fill('#cutFrom', '23:00:10'); await page.dispatchEvent('#cutFrom', 'change');
  assert((await page.inputValue('#cutTo')) === '23:00:40', 'wav: editing the start keeps the end at the end of the file');
  await page.fill('#cutLen', '0.25'); await page.dispatchEvent('#cutLen', 'change');
  assert((await page.inputValue('#cutTo')) === '23:00:25' && /23:00:10 עד 23:00:25/.test(await page.$eval('#cutSelInfo', (el) => el.textContent)), `wav: duration 0.25 min sets the end to 23:00:25 (${await page.inputValue('#cutTo')})`);
  // לפי זמן בקובץ: אותו טווח מוצג כהיסטים, ושינוי ההתחלה שם שומר על המשך
  await page.check('input[name="cutRef"][value="offset"]');
  assert((await page.inputValue('#cutFrom')) === '00:00:10' && (await page.inputValue('#cutTo')) === '00:00:25', `wav: offset mode shows 00:00:10–00:00:25 (${await page.inputValue('#cutFrom')}–${await page.inputValue('#cutTo')})`);
  await page.fill('#cutFrom', '00:00:05'); await page.dispatchEvent('#cutFrom', 'change');
  assert((await page.inputValue('#cutTo')) === '00:00:20' && /23:00:05 עד 23:00:20/.test(await page.$eval('#cutSelInfo', (el) => el.textContent)), `wav: offset start 00:00:05 with 0.25 min → 00:00:20 (${await page.inputValue('#cutTo')})`);
  await page.check('input[name="cutRef"][value="clock"]');
  await page.fill('#cutFrom', '23:00:10'); await page.dispatchEvent('#cutFrom', 'change');
  assert((await page.inputValue('#cutTo')) === '23:00:25' && /23:00:10 עד 23:00:25/.test(await page.$eval('#cutSelInfo', (el) => el.textContent)) && !(await page.$eval('#cutGoBtn', (b) => b.disabled)), 'wav: back to clock mode, 23:00:10–23:00:25 selected');
  let [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#cutGoBtn')]);
  let out = path.join(outDir, dl.suggestedFilename()); await dl.saveAs(out);
  assert(dl.suggestedFilename() === '2026-09-26_23-00-10_night.wav', `wav: piece name carries its start time (${dl.suggestedFilename()})`);
  let w = await wavInfo(out);
  assert(w.info.sampleRate === 16000 && w.info.channels === 1 && near(w.info.durationSec, 15, 0.01), `wav: piece is 16 kHz mono, 15 s (${w.info.sampleRate} Hz, ${w.info.durationSec.toFixed(3)} s)`);
  assert(w.info.creationSource === 'wav-icrd' && w.info.creationTime === localMs(2026, 9, 26, 23, 0, 10), `wav: ICRD = 23:00:10 (${new Date(w.info.creationTime).toString().slice(0, 24)})`);
  { // הדפיקה בשנייה 12 של המקור צריכה להיות בשנייה 2 של החלק
    const sr = 16000; const e = (a, b) => { let s = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) s += w.samples[i] * w.samples[i]; return s / ((b - a) * sr); };
    assert(e(2.0, 2.15) > 100 * e(0, 1.5) && e(2.0, 2.15) > 100 * e(5, 10), `wav: the bang sits at +2.0 s of the piece (ratio ${(e(2.0, 2.15) / e(0, 1.5)).toExponential(1)})`);
    assert(NS.dateFromName(dl.suggestedFilename()).getTime() === localMs(2026, 9, 26, 23, 0, 10), 'wav: the app would read the piece start from its name');
  }
  // לחיצות על ציר הזמן קובעות התחלה וסיום
  await page.fill('#cutLen', ''); await page.fill('#cutFrom', ''); await page.fill('#cutTo', ''); await page.dispatchEvent('#cutTo', 'change');
  const box = await page.$eval('#cutTimeline', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.click(box.x + box.w * 0.25, box.y + box.h / 2); await page.mouse.click(box.x + box.w * 0.5, box.y + box.h / 2);
  const selTxt = await page.$eval('#cutSelInfo', (el) => el.textContent);
  assert(/23:00:10 עד 23:00:20/.test(selTxt), `wav: two clicks on the timeline select 23:00:10–23:00:20 (${selTxt.slice(0, 40)})`);

  // ---- MP3 בלי Xing (אורך משוער): חיתוך לפי שעות בלי סריקה בכלל (הבאג שדווח: "reading 'length'") ----
  await page.setInputFiles('#cutFile', path.join(dir, 'vbr_noxing.mp3'));
  await page.waitForFunction(() => !document.querySelector('#cutWork').hidden && document.querySelector('#cutName').textContent.includes('vbr_noxing'), null, { timeout: 20000 });
  assert(!/~/.test(await page.$eval('#cutDuration', (el) => el.textContent)) && near(await page.evaluate(() => window.__noiseCut.state.info.durationSec), 40, 0.2), `mp3 no-xing: exact duration after frame indexing (${await page.$eval('#cutDuration', (el) => el.textContent)})`);
  await page.fill('#cutDate', '2026-09-26'); await page.fill('#cutTime', '23:00:00'); await page.dispatchEvent('#cutTime', 'change');
  await page.fill('#cutFrom', '23:00:20'); await page.dispatchEvent('#cutFrom', 'change');
  await page.fill('#cutLen', '0.25'); await page.dispatchEvent('#cutLen', 'change');
  [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#cutGoBtn')]);
  out = path.join(outDir, dl.suggestedFilename()); await dl.saveAs(out);
  w = await wavInfo(out);
  { const sr = 16000; const e = (a, b) => { let s = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) s += w.samples[i] * w.samples[i]; return s / ((b - a) * sr); };
    assert(dl.suggestedFilename() === '2026-09-26_23-00-20_vbr_noxing.wav' && near(w.info.durationSec, 15, 0.1) && e(5.0, 5.15) > 100 * e(1, 4), `mp3 no-xing: 23:00:20 + 15 s cut without scanning, bang at +5.0 s (${dl.suggestedFilename()}, ${w.info.durationSec.toFixed(2)} s)`); }

  // ---- MP3: סריקה, פיצול ל-15 שניות, רק חלקים עם אירועים, הורדת כולם ----
  await page.setInputFiles('#cutFile', path.join(dir, 'rec_20260926_230000.mp3'));
  await page.waitForFunction(() => !document.querySelector('#cutWork').hidden && document.querySelector('#cutName').textContent.includes('rec_2026'), null, { timeout: 20000 });
  await page.click('#cutScanBtn');
  await page.waitForFunction(() => window.__noiseCut.state.levels, null, { timeout: 60000 });
  const scanInfo = await page.$eval('#cutScanInfo', (el) => el.textContent);
  assert(/3 אירועים/.test(scanInfo), `mp3: scan finds 3 events (${scanInfo})`);
  await page.check('input[name="cutKind"][value="split"]');
  await page.evaluate(() => { const el = document.querySelector('#cutPieceMin'); el.value = '0.25'; el.dispatchEvent(new Event('change')); }); // 15 שניות → 3 חלקים (0–15: דפיקה 5 + גרירה 12, 15–30: דפיקות 25, 30–40: כלום)
  const pieces = await page.evaluate(() => window.__noiseCut.state.pieces.map((p) => `${p.t0.toFixed(0)}-${p.t1.toFixed(0)}:${p.events}:${p.selected ? 1 : 0}`));
  assert(pieces.join(' ') === '0-15:2:1 15-30:1:1 30-40:0:0', `mp3: pieces with event counts, the quiet one unselected (${pieces.join(' ')})`);
  const dls = [];
  page.on('download', (d) => dls.push(d));
  await page.click('#cutAllBtn');
  await page.waitForFunction(() => !window.__noiseCut.state.busy && document.querySelectorAll('#cutDone li').length >= 3, null, { timeout: 120000 }); // 2 חדשים + החלק הראשון
  await page.waitForTimeout(500);
  assert(dls.length === 2, `mp3: two pieces downloaded (${dls.length})`);
  const names = []; for (const d of dls) { const p = path.join(outDir, d.suggestedFilename()); await d.saveAs(p); names.push(d.suggestedFilename()); }
  assert(names.includes('2026-09-26_23-00-00_rec.wav') && names.includes('2026-09-26_23-00-15_rec.wav'), `mp3: piece names (${names.join(', ')})`);
  w = await wavInfo(path.join(outDir, '2026-09-26_23-00-15_rec.wav'));
  assert(near(w.info.durationSec, 15, 0.05) && w.info.creationTime === localMs(2026, 9, 26, 23, 0, 15), `mp3: second piece 15 s from 23:00:15 (${w.info.durationSec.toFixed(2)} s, ${new Date(w.info.creationTime).toString().slice(16, 24)})`);
  await page.screenshot({ path: path.join(outDir, 'shot-cut.png'), fullPage: true });

  // ---- ייבוא החלק הראשון באפליקציה: זמן ההתחלה 23:00:10 מהשם, הדפיקה ב-23:00:12 ----
  await page.goto('http://127.0.0.1:8771/'); await page.waitForFunction(() => window.__noiseLog);
  await page.setInputFiles('#fileInput', path.join(outDir, '2026-09-26_23-00-10_night.wav'));
  await page.waitForFunction(() => !document.querySelector('#impScanBtn').disabled, null, { timeout: 20000 });
  const impStart = (await page.inputValue('#impDate')) + 'T' + (await page.inputValue('#impTime'));
  assert(/^2026-09-26T23:00:10$/.test(impStart), `app: import reads the piece start 23:00:10 (${impStart})`);
  await page.click('#impScanBtn'); await page.waitForFunction(() => !document.querySelector('#impResult').hidden, null, { timeout: 60000 });
  const det = await page.evaluate(() => window.__noiseLog.importState.detected.map((e) => e.noiseSec.toFixed(2)));
  assert(det.length === 1 && near(Number(det[0]), 2.0, 0.06), `app: the piece has one event at +2.0 s = 23:00:12 (${det.join(',')})`);

  await browser.close(); server.close();
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
