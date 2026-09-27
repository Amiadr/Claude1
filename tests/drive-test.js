// בדיקת קצה-לקצה של סנכרון Google Drive מול הדמיה מקומית של ה-API, עם שני "מכשירים" (שני הקשרי דפדפן נפרדים).
// הרצה: node tests/drive-test.js <dir with test files> <outdir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { startServer } = require('./serve');
const { startMockDrive } = require('./mock-drive');

const [,, dir, outDir] = process.argv;
if (!dir || !outDir) { console.error('usage: drive-test.js testdir outdir'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const STATIC = 8768, MOCK = 8769;
let fails = 0;
function assert(c, msg) { if (!c) { fails++; console.error('FAIL:', msg); } else console.log('ok  :', msg); }
const mockState = async () => (await fetch(`http://127.0.0.1:${MOCK}/__state`)).json();

(async () => {
  const server = await startServer(STATIC);
  const mock = await startMockDrive(MOCK);
  const browser = await chromium.launch();

  async function newDevice(name) {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const page = await context.newPage();
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    page.on('pageerror', (e) => { fails++; console.error('PAGE ERROR', name, e.message); });
    page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', name, m.text()); });
    await page.goto(`http://127.0.0.1:${STATIC}/`);
    await page.waitForFunction(() => window.__noiseLog);
    await page.evaluate((mockUrl) => window.DriveClient.configure({ apiBase: mockUrl, testToken: 'test-token' }), `http://127.0.0.1:${MOCK}`);
    await page.fill('#deviceName', name); await page.dispatchEvent('#deviceName', 'change');
    await page.fill('#pre', '2'); await page.dispatchEvent('#pre', 'change');
    await page.fill('#tail', '2'); await page.dispatchEvent('#tail', 'change');
    return { name, context, page, dialogs };
  }
  async function importAndSave(dev, fileName, deselect) {
    const { page } = dev;
    await page.setInputFiles('#fileInput', path.join(dir, fileName));
    await page.waitForFunction(() => !document.querySelector('#impScanBtn').disabled, null, { timeout: 20000 });
    await page.click('#impScanBtn');
    await page.waitForFunction(() => !document.querySelector('#impResult').hidden || !document.querySelector('#impError').hidden, null, { timeout: 60000 });
    await page.click('#impReviewBtn');
    await page.waitForFunction(() => !document.querySelector('#impReview').hidden, null, { timeout: 60000 });
    for (const i of deselect || []) await page.click(`#impReviewList li.rev:nth-child(${i + 1}) input[data-act="sel"]`);
    const before = await page.evaluate(() => window.__noiseLog.events.length);
    const sel = await page.evaluate(() => window.__noiseLog.importState.review.filter((r) => r.selected).length);
    await page.click('#impSaveBtn');
    await page.waitForFunction((n) => window.__noiseLog.events.length >= n, before + sel, { timeout: 60000 });
    return sel;
  }
  async function connect(dev) {
    await dev.page.click('#driveConnectBtn');
    await dev.page.waitForFunction(() => /test@example\.com/.test(document.querySelector('#driveAccount').textContent), null, { timeout: 10000 });
  }
  async function sync(dev) {
    await dev.page.click('#driveSyncBtn');
    await dev.page.waitForFunction(() => !window.__noiseLog.syncing && /הסתיים|נכשל/.test(document.querySelector('#driveStatus').textContent), null, { timeout: 60000 });
    return dev.page.$eval('#driveStatus', (el) => el.textContent);
  }
  const localEvents = (dev) => dev.page.evaluate(() => window.__noiseLog.events.map((e) => ({ uid: e.uid, noiseTs: e.noiseTs, remote: !!e.remote, device: e.deviceName, fileId: e.driveFileId, fileName: e.driveFileName, hasBlob: !!e.blob })));

  // ---- מכשיר A: "טלפון" מייבא, מתחבר ומסנכרן ----
  const A = await newDevice('טלפון');
  assert((await importAndSave(A, 'night_2026-09-26_23-00-00.wav', [1])) === 2, 'A: imported 2 events');
  await connect(A);
  assert(await A.page.$$eval('#events .tag.pending', (els) => els.length) === 2, 'A: events show "pending upload" once connected');
  let st = await sync(A);
  assert(/הועלו 2, התקבלו 0/.test(st), `A: first sync uploaded 2 (${st})`);
  let m = await mockState();
  const folders = m.files.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
  const root = folders.find((f) => f.name === 'יומן רעש'), year = folders.find((f) => f.name === '2026'), month = folders.find((f) => f.name === '2026-09');
  assert(root && year && month && year.parents[0] === root.id && month.parents[0] === year.id, 'drive: folder tree יומן רעש/2026/2026-09');
  const clips = m.files.filter((f) => f.mimeType === 'audio/wav');
  assert(clips.length === 2 && clips.every((f) => f.parents[0] === month.id && f.appProperties.deviceName === 'טלפון' && /^2026-09-26_23-00-(05|25)_טלפון_[0-9a-f]{6}\.wav$/.test(f.name)), `drive: 2 clips in month folder named with device (${clips.map((f) => f.name).join(', ')})`);
  assert(clips.every((f) => Number(f.size) > 100000), 'drive: clip bytes uploaded');
  const idx = m.files.find((f) => f.name === 'events-2026-09.json');
  assert(idx && JSON.parse(idx.text).events.length === 2 && JSON.parse(idx.text).events.every((x) => x.deviceName === 'טלפון' && x.fileId), 'drive: monthly index with 2 entries');
  const csv = m.files.find((f) => f.name === 'events-2026-09.csv');
  assert(csv && csv.text.split('\r\n').filter(Boolean).length === 3 && csv.text.includes('טלפון') && csv.text.includes('מכשיר'), 'drive: monthly CSV with device column');
  const slog = m.files.find((f) => f.name === 'scan-log.json');
  assert(slog && JSON.parse(slog.text).scans.length === 1 && JSON.parse(slog.text).scans[0].type === 'file' && JSON.parse(slog.text).scans[0].deviceName === 'טלפון', 'drive: scan-log with the import entry');
  let ev = await localEvents(A);
  assert(ev.every((e) => e.fileId && !e.remote), 'A: local events carry Drive file ids');
  assert(await A.page.$$eval('#events .tag.cloud', (els) => els.map((e) => e.textContent)).then((t) => t.length === 2 && t.every((x) => /הועלה · טלפון/.test(x))), 'A: cards show "uploaded · טלפון"');
  await A.page.screenshot({ path: path.join(outDir, 'shot-drive-A.png'), fullPage: true });

  // ---- מכשיר B: "מחשב" רואה ומנגן את הקליפים של A ----
  const B = await newDevice('מחשב');
  await connect(B);
  st = await sync(B);
  assert(/הועלו 0, התקבלו 2/.test(st), `B: sync received 2 remote events (${st})`);
  ev = await localEvents(B);
  assert(ev.length === 2 && ev.every((e) => e.remote && e.device === 'טלפון' && !e.hasBlob), 'B: 2 remote events from טלפון without local audio');
  assert(await B.page.$$eval('#events .tag.cloud', (els) => els.map((e) => e.textContent)).then((t) => t.every((x) => /מ-Drive · טלפון/.test(x))), 'B: cards show "from Drive · טלפון"');
  await B.page.click('#events li.event:first-child button[data-act="play"]');
  await B.page.waitForSelector('#events li.event:first-child .player audio', { timeout: 20000 });
  assert(await B.page.$eval('#events li.event:first-child .player audio', (a) => a.src.startsWith('blob:')), 'B: remote clip downloaded and playable');
  ev = await localEvents(B);
  assert(ev.filter((e) => e.hasBlob).length === 1, 'B: downloaded clip cached locally');

  // ---- B מייבא את אותו קובץ: אזהרה שכבר נסרק, ואז מוסיף לצד הקיימים ----
  B.dialogs.length = 0;
  assert((await importAndSave(B, 'night_2026-09-26_23-00-00.wav', [])) === 3, 'B: imported all 3 events from the same file');
  assert(B.dialogs.length === 1 && /כבר נסרק/.test(B.dialogs[0]) && /טלפון/.test(B.dialogs[0]) && /נשמרו 2 אירועים/.test(B.dialogs[0]), `B: coverage warning named the earlier scan (${B.dialogs.length} dialogs: ${B.dialogs.map((d) => d.replace(/\n/g, ' | ')).join(' || ')})`);
  st = await sync(B);
  assert(/הועלו 3, התקבלו 0/.test(st), `B: sync uploaded 3 (${st})`);
  m = await mockState();
  assert(m.files.filter((f) => f.mimeType === 'audio/wav').length === 5, 'drive: 5 clips after both devices');
  assert(JSON.parse(m.files.find((f) => f.name === 'events-2026-09.json').text).events.length === 5, 'drive: index merged to 5 entries');
  assert(JSON.parse(m.files.find((f) => f.name === 'scan-log.json').text).scans.length === 2, 'drive: scan-log has both scans');
  assert(m.files.filter((f) => f.name === 'events-2026-09.json').length === 1 && m.files.filter((f) => f.name === 'events-2026-09.csv').length === 1 && m.files.filter((f) => f.name === 'scan-log.json').length === 1, 'drive: index/csv/scan-log updated in place, not duplicated');

  // ---- A מקבל את האירועים של B, מוחק אחד משלו גם מ-Drive ----
  st = await sync(A);
  assert(/הועלו 0, התקבלו 3/.test(st), `A: sync received B's 3 events (${st})`);
  ev = await localEvents(A);
  assert(ev.length === 5 && ev.filter((e) => e.remote && e.device === 'מחשב').length === 3, 'A: 5 events, 3 remote from מחשב');
  const csvA = await A.page.evaluate(() => window.__noiseLog.eventsCsv(window.__noiseLog.events));
  assert(csvA.split('\r\n')[0].includes('מכשיר') && csvA.includes(',טלפון,') && csvA.includes(',מחשב,'), 'A: CSV export lists the device of every event');
  A.dialogs.length = 0;
  const ownFirst = await A.page.evaluate(() => { const e = window.__noiseLog.events.find((x) => !x.remote); return { id: e.id, uid: e.uid }; });
  await A.page.click(`#events li.event[data-id="${ownFirst.id}"] button[data-act="delete"]`);
  await A.page.waitForFunction((n) => window.__noiseLog.events.length === n, 4, { timeout: 10000 });
  assert(A.dialogs.length === 2 && /Drive/.test(A.dialogs[1]), 'A: delete asked whether to remove from Drive too');
  st = await sync(A);
  assert(/נמחקו מ-Drive 1/.test(st), `A: sync deleted the clip from Drive (${st})`);
  m = await mockState();
  assert(m.files.filter((f) => f.mimeType === 'audio/wav').length === 4 && !JSON.parse(m.files.find((f) => f.name === 'events-2026-09.json').text).events.some((x) => x.uid === ownFirst.uid), 'drive: clip removed and index updated');
  st = await sync(A);
  assert(/הועלו 0, התקבלו 0/.test(st) && (await localEvents(A)).length === 4, 'A: deleted event does not come back on the next sync');

  // ---- B מסנכרן: האירוע שנמחק ב-A נעלם גם אצלו; ייצוא ZIP מוריד את הקליפים החסרים ----
  st = await sync(B);
  assert(/הוסרו 1 שנמחקו במכשיר אחר/.test(st) && (await localEvents(B)).length === 4, `B: event deleted on A removed here (${st})`);
  const [download] = await Promise.all([B.page.waitForEvent('download', { timeout: 60000 }), B.page.click('#zipBtn')]);
  const zipPath = path.join(outDir, 'evidence-B.zip'); await download.saveAs(zipPath);
  assert(fs.statSync(zipPath).size > 400000, `B: ZIP export downloaded (${fs.statSync(zipPath).size} bytes)`);
  ev = await localEvents(B);
  assert(ev.every((e) => e.hasBlob), 'B: all clips (including remote) now have local audio after export');
  await B.page.screenshot({ path: path.join(outDir, 'shot-drive-B.png'), fullPage: true });

  await browser.close(); server.close(); mock.server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
