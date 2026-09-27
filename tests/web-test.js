// בדיקת קצה-לקצה של אפליקציית הווב: Chromium עם מיקרופון מדומה שמנגן קובץ WAV סינתטי,
// ובודקים שהאפליקציה מזהה את האירועים, שומרת קליפים, ומייצאת CSV ו-ZIP תקינים.
// הרצה: node tests/web-test.js /path/to/test.wav /path/to/outdir
const fs = require('fs');
const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const [,, wavPath, outDir] = process.argv;
if (!wavPath || !outDir) { console.error('usage: web-test.js test.wav outdir'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const { startServer } = require('./serve');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else { console.log('ok  :', msg); } }

(async () => {
  const server = await startServer(8765);
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  await context.grantPermissions(['microphone'], { origin: 'http://127.0.0.1:8765' });
  const page = await context.newPage();
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
  await page.goto('http://127.0.0.1:8765/');
  await page.waitForFunction(() => window.__noiseLog);

  // ניקוי אחסון מריצות קודמות
  await page.evaluate(async () => { const db = await new Promise((res) => { const r = indexedDB.open('noise-log'); r.onsuccess = () => res(r.result); }); db.close(); });
  // הגדרות לבדיקה: סף 55, 2 שניות לפני, 2 שניות זנב
  await page.fill('#pre', '2'); await page.dispatchEvent('#pre', 'change');
  await page.fill('#tail', '2'); await page.dispatchEvent('#tail', 'change');
  await page.evaluate(() => { const t = document.querySelector('#threshold'); t.value = 55; t.dispatchEvent(new Event('input')); });
  const settings = await page.evaluate(() => JSON.stringify(window.__noiseLog.settings));
  console.log('settings', settings);

  const t0 = Date.now();
  await page.click('#startBtn');
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'on', null, { timeout: 15000 });
  console.log('monitoring started after', Date.now() - t0, 'ms');
  await page.screenshot({ path: path.join(outDir, 'shot-monitoring.png') });

  // הקובץ אורכו 40 שניות; מחכים ל-3 אירועים (עד 60 שניות)
  await page.waitForFunction(() => window.__noiseLog.events.length >= 3, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const events = await page.evaluate(() => window.__noiseLog.events.map((e) => ({ id: e.id, noiseTs: e.noiseTs, startTs: e.startTs, endTs: e.endTs, durationSec: e.durationSec, peak: window.__noiseLog.disp(e.peakDb), avg: window.__noiseLog.disp(e.avgDb), truncated: e.truncated, sampleRate: e.sampleRate, size: e.blob.size })));
  console.log(JSON.stringify(events, null, 1));
  assert(events.length === 3, `3 events detected (got ${events.length})`);
  if (events.length === 3) {
    const [a, b, c] = events;
    const d1 = (b.noiseTs - a.noiseTs) / 1000, d2 = (c.noiseTs - a.noiseTs) / 1000;
    assert(Math.abs(d1 - 7.0) < 0.35, `gap event1->event2 ≈ 7.0s (got ${d1.toFixed(2)})`);
    assert(Math.abs(d2 - 20.0) < 0.35, `gap event1->event3 ≈ 20.0s (got ${d2.toFixed(2)})`);
    assert(Math.abs(a.durationSec - 4.15) < 0.4, `event1 clip ≈ 4.15s (got ${a.durationSec.toFixed(2)})`);
    assert(Math.abs(b.durationSec - 6.0) < 0.4, `event2 clip ≈ 6.0s (got ${b.durationSec.toFixed(2)})`);
    assert(Math.abs(c.durationSec - 4.65) < 0.4, `event3 clip ≈ 4.65s (got ${c.durationSec.toFixed(2)})`);
    assert(a.peak > b.peak && c.peak > b.peak, `bangs louder than drag (${a.peak.toFixed(0)}, ${b.peak.toFixed(0)}, ${c.peak.toFixed(0)})`);
    assert(b.peak > 65 && b.peak < 85, `drag level in expected range (${b.peak.toFixed(0)})`);
    assert(Math.abs((a.noiseTs - a.startTs) / 1000 - 2.0) < 0.3, `pre-roll ≈ 2s (got ${((a.noiseTs - a.startTs) / 1000).toFixed(2)})`);
    assert(events.every((e) => e.sampleRate === 16000), 'sample rate 16000');
    assert(events.every((e) => Math.abs(e.size - (44 + e.durationSec * e.sampleRate * 2)) < 4), 'WAV size matches duration');
  }
  // הקליפים בממשק
  const cards = await page.$$eval('#events li.event', (els) => els.length);
  assert(cards === events.length, `UI shows ${cards} event cards`);
  await page.click('#stopBtn');
  await page.waitForFunction(() => !window.__noiseLog.monitoring);
  await page.screenshot({ path: path.join(outDir, 'shot-events.png'), fullPage: true });

  // CSV
  const csv = await page.evaluate(() => window.__noiseLog.eventsCsv(window.__noiseLog.events));
  fs.writeFileSync(path.join(outDir, 'events.csv'), csv);
  assert(csv.startsWith('﻿#,תאריך'), 'CSV has BOM + Hebrew header');
  assert(csv.trim().split('\r\n').length === events.length + 1, 'CSV row count');

  // ZIP
  const zipBytes = await page.evaluate(async () => {
    const L = window.__noiseLog;
    const files = [{ name: 'events.csv', data: new TextEncoder().encode(L.eventsCsv(L.events)) }];
    for (const e of L.events) files.push({ name: `clips/ev${e.id}.wav`, data: e.blob, date: new Date(e.noiseTs) });
    const blob = await L.makeZip(files);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  fs.writeFileSync(path.join(outDir, 'export.zip'), Buffer.from(zipBytes));
  console.log('zip bytes', zipBytes.length);

  // הקלטות שורדות טעינה מחדש (IndexedDB)
  await page.reload();
  await page.waitForFunction(() => window.__noiseLog && window.__noiseLog.events.length > 0, null, { timeout: 10000 }).catch(() => {});
  const persisted = await page.evaluate(() => window.__noiseLog.events.length);
  assert(persisted === events.length, `events persisted across reload (${persisted})`);
  const logText = await page.$eval('#log', (el) => el.innerText);
  assert(/ניטור התחיל/.test(logText) && /ניטור הופסק/.test(logText), 'session log has start/stop lines');

  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
