// בדיקת קצה-לקצה של ייבוא קובץ: WAV (זרימה), MP3 (WebCodecs ב-worker), OGG (פענוח מלא) ו-M4A.
// הרצה: node tests/import-test.js <dir with test files> <outdir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { startServer } = require('./serve');

const [,, dir, outDir] = process.argv;
if (!dir || !outDir) { console.error('usage: import-test.js testdir outdir'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
let fails = 0;
function assert(c, msg) { if (!c) { fails++; console.error('FAIL:', msg); } else console.log('ok  :', msg); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const localMs = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h - 3, mi, s); // Asia/Jerusalem = UTC+3 בספטמבר

(async () => {
  const server = await startServer(8766);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const page = await context.newPage();
  page.on('pageerror', (e) => { fails++; console.error('PAGE ERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto('http://127.0.0.1:8766/');
  await page.waitForFunction(() => window.__noiseLog);
  await page.fill('#pre', '2'); await page.dispatchEvent('#pre', 'change');
  await page.fill('#tail', '2'); await page.dispatchEvent('#tail', 'change');

  async function importFile(name, opts = {}) {
    await page.setInputFiles('#fileInput', path.join(dir, name));
    await page.waitForFunction(() => !document.querySelector('#impError').hidden || !document.querySelector('#impScanBtn').disabled, null, { timeout: 20000 });
    const err = await page.$eval('#impError', (el) => (el.hidden ? null : el.textContent));
    if (err) return { error: err };
    const info = { start: await page.inputValue('#impStart'), src: await page.$eval('#impStartSrc', (el) => el.textContent), fmt: await page.$eval('#impFormat', (el) => el.textContent), dur: await page.$eval('#impDuration', (el) => el.textContent) };
    if (opts.start) await page.evaluate((v) => { const el = document.querySelector('#impStart'); el.value = v; el.dispatchEvent(new Event('change')); }, opts.start);
    await page.click('#impScanBtn');
    await page.waitForFunction(() => !document.querySelector('#impResult').hidden || !document.querySelector('#impError').hidden, null, { timeout: 60000 });
    const err2 = await page.$eval('#impError', (el) => (el.hidden ? null : el.textContent));
    if (err2) return { error: err2, info };
    info.thr = Number(await page.inputValue('#impThr'));
    info.floor = await page.$eval('#impFloor', (el) => el.textContent);
    info.count = await page.$eval('#impCount', (el) => el.textContent);
    info.detected = await page.evaluate(() => window.__noiseLog.importState.detected.map((e) => ({ ...e })));
    const before = await page.evaluate(() => window.__noiseLog.events.length);
    await page.click('#impSaveBtn');
    await page.waitForFunction((n) => window.__noiseLog.events.length >= n || !document.querySelector('#impError').hidden, before + info.detected.length, { timeout: 60000 });
    const err3 = await page.$eval('#impError', (el) => (el.hidden ? null : el.textContent));
    if (err3) return { error: err3, info };
    info.saved = await page.evaluate((n) => window.__noiseLog.events.slice(n).map((e) => ({ id: e.id, noiseTs: e.noiseTs, startTs: e.startTs, endTs: e.endTs, durationSec: e.durationSec, sampleRate: e.sampleRate, source: e.source, sourceName: e.sourceName, offsetSec: e.offsetSec, size: e.blob.size, peak: window.__noiseLog.disp(e.peakDb) })), before);
    return info;
  }
  function checkThree(label, r, startMs, tol) {
    assert(!r.error, `${label}: no error (${r.error || ''})`);
    if (r.error) return;
    assert(r.detected.length === 3, `${label}: 3 events detected (got ${r.detected.length}) – ${r.count}`);
    assert(r.saved.length === 3, `${label}: 3 events saved`);
    if (r.saved.length !== 3) return;
    const offs = r.saved.map((e) => (e.noiseTs - startMs) / 1000);
    assert(near(offs[0], 5, tol) && near(offs[1], 12, tol) && near(offs[2], 25, tol), `${label}: noise times = start + 5/12/25s (got ${offs.map((o) => o.toFixed(2)).join('/')})`);
    assert(r.saved.every((e) => e.source === 'file' && e.offsetSec > 0), `${label}: events marked as file source with offsets`);
    assert(r.saved.every((e) => Math.abs(e.size - (44 + Math.round(e.durationSec * e.sampleRate) * 2)) < 4), `${label}: WAV blob size matches duration @ ${r.saved[0].sampleRate} Hz`);
    assert(r.saved[0].peak > r.saved[1].peak && r.saved[2].peak > r.saved[1].peak, `${label}: bangs louder than drag (${r.saved.map((e) => e.peak.toFixed(0)).join('/')})`);
  }

  // ---- WAV: זמן משם הקובץ, סריקה בזרימה ב-worker ----
  let r = await importFile('night_2026-09-26_23-00-00.wav');
  assert(/^2026-09-26T23:00(:00)?$/.test(r.start) && /שם הקובץ/.test(r.src), `wav: start inferred from filename (${r.start}, ${r.src})`);
  assert(/WAV/.test(r.fmt) && r.dur === '00:00:40', `wav: format/duration shown (${r.fmt}; ${r.dur})`);
  assert(near(r.thr, 52, 2), `wav: suggested threshold ≈ floor+12 (${r.thr}, floor ${r.floor})`);
  checkThree('wav', r, localMs(2026, 9, 26, 23, 0, 0), 0.06);
  await page.screenshot({ path: path.join(outDir, 'shot-import.png'), fullPage: true });

  // ---- MP3: WebCodecs ב-worker ----
  r = await importFile('rec_20260926_230000.mp3');
  assert(/^2026-09-26T23:00(:00)?$/.test(r.start), `mp3: start from yyyymmdd_hhmmss name (${r.start})`);
  checkThree('mp3', r, localMs(2026, 9, 26, 23, 0, 0), 0.15);

  // ---- OGG/Opus: פענוח מלא בדף הראשי, זמן ידני ----
  r = await importFile('test.ogg', { start: '2026-09-27T01:30:00' });
  checkThree('ogg', r, localMs(2026, 9, 27, 1, 30, 0), 0.15);

  // ---- M4A/AAC: תלוי בקודקים של הדפדפן (Chromium ללא AAC → שגיאה מסודרת) ----
  r = await importFile('Voice 001.m4a');
  if (r.error) { console.log('m4a: decode not available in this browser build →', r.error); assert(/AAC|mp4a|פענוח|לפענח/.test(r.error), 'm4a: graceful error mentions decoding'); }
  else { assert(/^2026-09-26T23:00(:00)?$/.test(r.start), `m4a: start from mvhd creation_time (${r.start})`); checkThree('m4a', r, localMs(2026, 9, 26, 23, 0, 0), 0.15); }

  // ---- CSV עם עמודות מקור ----
  const csv = await page.evaluate(() => window.__noiseLog.eventsCsv(window.__noiseLog.events));
  const lines = csv.trim().split('\r\n');
  assert(lines[0].endsWith(',מקור,היסט בהקלטה המקורית') && lines[1].includes('night_2026-09-26_23-00-00.wav,00:00:05'), 'csv: source and offset columns present');
  fs.writeFileSync(path.join(outDir, 'events-import.csv'), csv);
  const tags = await page.$$eval('#events .tag.file', (els) => els.length);
  assert(tags === (await page.evaluate(() => window.__noiseLog.events.length)), `ui: every imported event carries the file tag (${tags})`);
  await page.screenshot({ path: path.join(outDir, 'shot-import-events.png'), fullPage: true });

  await browser.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
