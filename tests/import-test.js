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
    const info = { start: (await page.inputValue('#impDate')) + 'T' + (await page.inputValue('#impTime')), src: await page.$eval('#impStartSrc', (el) => el.textContent), fmt: await page.$eval('#impFormat', (el) => el.textContent), dur: await page.$eval('#impDuration', (el) => el.textContent) };
    if (opts.start) { const [d, t] = opts.start.split('T'); await page.fill('#impDate', d); await page.fill('#impTime', t); await page.dispatchEvent('#impTime', 'change'); }
    if (opts.mode === 'end') await page.check('#impModeEnd');
    info.range = await page.$eval('#impRange', (el) => el.textContent);
    await page.click('#impScanBtn');
    await page.waitForFunction(() => !document.querySelector('#impResult').hidden || !document.querySelector('#impError').hidden, null, { timeout: 60000 });
    const err2 = await page.$eval('#impError', (el) => (el.hidden ? null : el.textContent));
    if (err2) return { error: err2, info };
    info.thr = Number(await page.inputValue('#impThr'));
    info.floor = await page.$eval('#impFloor', (el) => el.textContent);
    info.count = await page.$eval('#impCount', (el) => el.textContent);
    info.detected = await page.evaluate(() => window.__noiseLog.importState.detected.map((e) => ({ ...e })));
    // שלב הסקירה: ניתוח, האזנה, בחירה
    await page.click('#impReviewBtn');
    await page.waitForFunction(() => !document.querySelector('#impReview').hidden || !document.querySelector('#impError').hidden, null, { timeout: 60000 });
    const errR = await page.$eval('#impError', (el) => (el.hidden ? null : el.textContent));
    if (errR) return { error: errR, info };
    info.review = await page.evaluate(() => window.__noiseLog.importState.review.map((r) => ({ kind: r.kind, selected: r.selected, noiseSec: r.noiseSec, cls: r.cls })));
    info.rows = await page.$$eval('#impReviewList li.rev', (els) => els.length);
    if (opts.play !== false) {
      await page.click('#impReviewList li.rev:first-child button[data-act="play"]');
      await page.waitForSelector('#impReviewList li.rev:first-child .player audio', { timeout: 20000 });
      info.played = await page.$eval('#impReviewList li.rev:first-child .player audio', (a) => a.src.startsWith('blob:'));
    }
    if (opts.clickNoSpeech) await page.click('#impSelNoSpeech');
    for (const i of opts.deselect || []) await page.click(`#impReviewList li.rev:nth-child(${i + 1}) input[data-act="sel"]`);
    info.selected = await page.evaluate(() => window.__noiseLog.importState.review.filter((r) => r.selected).length);
    info.summary = await page.$eval('#impReviewSummary', (el) => el.textContent);
    const before = await page.evaluate(() => window.__noiseLog.events.length);
    await page.click('#impSaveBtn');
    await page.waitForFunction((n) => window.__noiseLog.events.length >= n || !document.querySelector('#impError').hidden, before + info.selected, { timeout: 60000 });
    const err3 = await page.$eval('#impError', (el) => (el.hidden ? null : el.textContent));
    if (err3) return { error: err3, info };
    info.saved = await page.evaluate((n) => window.__noiseLog.events.slice(n).map((e) => ({ id: e.id, noiseTs: e.noiseTs, startTs: e.startTs, endTs: e.endTs, durationSec: e.durationSec, sampleRate: e.sampleRate, source: e.source, sourceName: e.sourceName, offsetSec: e.offsetSec, kind: e.kind, size: e.blob.size, peak: window.__noiseLog.disp(e.peakDb) })), before);
    return info;
  }
  function checkSaved(label, r, startMs, tol, expected /* offsets in seconds */, expectedKinds) {
    assert(!r.error, `${label}: no error (${r.error || ''})`);
    if (r.error) return;
    assert(r.detected.length === 3 + (expectedKinds && expectedKinds.length > 3 ? 1 : 0) || r.detected.length === (expectedKinds ? expectedKinds.length : 3), `${label}: ${r.detected.length} events detected – ${r.count}`);
    assert(r.rows === r.review.length && r.rows === r.detected.length, `${label}: review list shows ${r.rows} rows`);
    if (expectedKinds) assert(JSON.stringify(r.review.map((x) => x.kind)) === JSON.stringify(expectedKinds), `${label}: kinds ${r.review.map((x) => x.kind).join('/')} (expected ${expectedKinds.join('/')})`);
    if (r.played !== undefined) assert(r.played === true, `${label}: play button produced an audio player`);
    assert(r.saved.length === expected.length, `${label}: ${r.saved.length} events saved (expected ${expected.length})`);
    if (r.saved.length !== expected.length) return;
    const offs = r.saved.map((e) => (e.noiseTs - startMs) / 1000);
    assert(offs.every((o, i) => near(o, expected[i], tol)), `${label}: noise times = start + ${expected.join('/')}s (got ${offs.map((o) => o.toFixed(2)).join('/')})`);
    assert(r.saved.every((e) => e.source === 'file' && e.offsetSec > 0 && e.kind), `${label}: events marked as file source with offsets and kind`);
    assert(r.saved.every((e) => Math.abs(e.size - (44 + Math.round(e.durationSec * e.sampleRate) * 2)) < 4), `${label}: WAV blob size matches duration @ ${r.saved[0].sampleRate} Hz`);
  }

  // ---- WAV: זמן משם הקובץ, סריקה בזרימה ב-worker, ביטול הגרירה בסקירה ----
  let r = await importFile('night_2026-09-26_23-00-00.wav', { deselect: [1] });
  assert(/^2026-09-26T23:00(:00)?$/.test(r.start) && /שם הקובץ/.test(r.src), `wav: start inferred from filename (${r.start}, ${r.src})`);
  assert(/WAV/.test(r.fmt) && r.dur === '00:00:40', `wav: format/duration shown (${r.fmt}; ${r.dur})`);
  assert(near(r.thr, 52, 2), `wav: suggested threshold ≈ floor+12 (${r.thr}, floor ${r.floor})`);
  assert(r.selected === 2 && /2 מסומנים/.test(r.summary), `wav: 2 of 3 selected after unchecking the drag (${r.summary})`);
  checkSaved('wav', r, localMs(2026, 9, 26, 23, 0, 0), 0.06, [5, 25], ['bang', 'noise', 'bang']);
  await page.screenshot({ path: path.join(outDir, 'shot-import.png'), fullPage: true });

  // ---- WAV עם קטע דמוי דיבור: הסיווג מסמן אותו, הכפתור מבטל את בחירתו ----
  r = await importFile('speech_2026-09-27_00-00-00.wav', { clickNoSpeech: true, play: false });
  assert(r.review && r.review.length === 4 && r.review[3].kind === 'speech', `speech: 4th event classified as speech (${r.review && r.review.map((x) => x.kind).join('/')})`);
  assert(r.selected === 3 && /1 נשמעים כדיבור/.test(r.summary), `speech: "deselect speech" left 3 selected (${r.summary})`);
  checkSaved('speech', r, localMs(2026, 9, 27, 0, 0, 0), 0.06, [5, 12, 25], ['bang', 'noise', 'bang', 'speech']);
  await page.screenshot({ path: path.join(outDir, 'shot-review.png'), fullPage: true });

  // ---- MP3: WebCodecs ב-worker ----
  r = await importFile('rec_20260926_230000.mp3', { play: false });
  assert(/^2026-09-26T23:00(:00)?$/.test(r.start), `mp3: start from yyyymmdd_hhmmss name (${r.start})`);
  checkSaved('mp3', r, localMs(2026, 9, 26, 23, 0, 0), 0.15, [5, 12, 25], ['bang', 'noise', 'bang']);

  // ---- OGG/Opus: פענוח מלא בדף הראשי, זמן ידני ----
  r = await importFile('test.ogg', { start: '2026-09-27T01:30:40', mode: 'end', play: false });
  assert(/עדיין לא ידוע/.test(r.range), `ogg: end-mode with unknown duration defers the start time (${r.range})`);
  checkSaved('ogg (end mode)', r, localMs(2026, 9, 27, 1, 30, 0), 0.15, [5, 12, 25], ['bang', 'noise', 'bang']);
  const rangeAfter = await page.$eval('#impRange', (el) => el.textContent);
  assert(/27\.09\.2026 01:30:00 עד 27\.09\.2026 01:30:40/.test(rangeAfter), `ogg: range computed from end time after scan (${rangeAfter})`);

  // ---- M4A/AAC: תלוי בקודקים של הדפדפן (Chromium ללא AAC → שגיאה מסודרת) ----
  r = await importFile('Voice 001.m4a', { play: false });
  if (r.error) { console.log('m4a: decode not available in this browser build →', r.error); assert(/לפענח/.test(r.error), 'm4a: graceful Hebrew error'); }
  else { assert(/^2026-09-26T23:00(:00)?$/.test(r.start), `m4a: start from mvhd creation_time (${r.start})`); checkSaved('m4a', r, localMs(2026, 9, 26, 23, 0, 0), 0.15, [5, 12, 25], ['bang', 'noise', 'bang']); }

  // ---- CSV עם עמודות מקור ----
  const csv = await page.evaluate(() => window.__noiseLog.eventsCsv(window.__noiseLog.events));
  const lines = csv.trim().split('\r\n');
  assert(lines[0].includes(',מקור,היסט בהקלטה המקורית,מכשיר,Drive') && lines[0].includes('סיווג אוטומטי') && lines[1].includes('דפיקה') && lines[1].includes('night_2026-09-26_23-00-00.wav,00:00:05'), 'csv: kind, source and offset columns present');
  fs.writeFileSync(path.join(outDir, 'events-import.csv'), csv);
  const tags = await page.$$eval('#events .tag.file', (els) => els.length);
  assert(tags === (await page.evaluate(() => window.__noiseLog.events.length)), `ui: every imported event carries the file tag (${tags})`);
  // ---- תיקון זמן של ייבוא שנשמר ----
  {
    const batches = await page.evaluate(() => window.__noiseLog.importBatches().map((b) => ({ id: b.importId, name: b.sourceName, count: b.count, start: b.start })));
    const wavBatch = batches.find((b) => b.name === 'night_2026-09-26_23-00-00.wav');
    assert(wavBatch && wavBatch.count === 2 && wavBatch.start === localMs(2026, 9, 26, 23, 0, 0), `fix: wav import batch found (${JSON.stringify(wavBatch)})`);
    await page.evaluate(() => { document.querySelector('#fixBox').open = true; });
    await page.selectOption('#fixImport', String(wavBatch.id));
    await page.fill('#fixDate', '2026-09-27'); await page.fill('#fixTime', '23:00:40'); await page.dispatchEvent('#fixTime', 'change');
    await page.check('input[name="fixMode"][value="end"]');
    await page.waitForFunction(() => /תזוזה/.test(document.querySelector('#fixPreview').textContent));
    const preview = await page.$eval('#fixPreview', (el) => el.textContent);
    assert(/\+1 ימים 00:00:00/.test(preview) && /27\.09\.2026 23:00:00/.test(preview), `fix: preview shows +1 day from end time (${preview})`);
    await page.click('#fixApplyBtn');
    await page.waitForFunction((id) => window.__noiseLog.events.filter((e) => e.sessionId === id).every((e) => e.timeCorrected), wavBatch.id, { timeout: 10000 });
    const fixed = await page.evaluate((id) => window.__noiseLog.events.filter((e) => e.sessionId === id).map((e) => ({ noiseTs: e.noiseTs, orig: e.originalNoiseTs })), wavBatch.id);
    assert(fixed.length === 2 && fixed.every((e) => e.noiseTs - e.orig === 86400000), 'fix: both events shifted by exactly one day, original kept');
    assert(await page.$$eval('#events .tag', (els) => els.filter((t) => t.textContent === 'זמן תוקן').length) === 2, 'fix: cards show "time corrected" tag');
    const scans = await page.evaluate(() => window.__noiseLog.dbGetAll('scans'));
    const sc = scans.find((x) => x.importId === wavBatch.id);
    assert(sc && sc.startTs === localMs(2026, 9, 27, 23, 0, 0) && sc.updatedAt, 'fix: scan-log entry moved with the events');
  }

  // ---- מחיקה קבוצתית ברשימה ----
  const total = await page.evaluate(() => window.__noiseLog.events.length);
  await page.click('#events li.event:nth-child(1) input[data-act="sel"]');
  await page.click('#events li.event:nth-child(2) input[data-act="sel"]');
  assert(await page.$eval('#bulkCount', (el) => el.textContent) === '2', 'bulk: 2 selected');
  await page.click('#bulkDelete');
  await page.waitForFunction((n) => window.__noiseLog.events.length === n - 2, total, { timeout: 10000 });
  assert(await page.evaluate(() => window.__noiseLog.events.length) === total - 2, 'bulk: 2 events deleted');
  await page.screenshot({ path: path.join(outDir, 'shot-import-events.png'), fullPage: true });

  await browser.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
