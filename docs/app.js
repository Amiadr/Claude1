/* יומן רעש לילי – ניטור מיקרופון, זיהוי אירועי רעש, שמירת קליפים עם חותמת זמן.
   כל הנתונים נשמרים מקומית בדפדפן (IndexedDB). אין שרת, אין העלאה לענן. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ---------- הגדרות ----------
  const DEFAULTS = { threshold: 55, pre: 3, tail: 3, maxClip: 120, sampleRate: 16000, keepAwake: true, skipSpeech: false, skipBreath: false, detectBand: 'full', deviceName: '', deviceId: '', driveFolder: 'יומן רעש', googleClientId: '' };
  const SETTINGS_KEY = 'noise-log-settings-v1';
  const settings = loadSettings();

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  // ---------- IndexedDB ----------
  const DB_NAME = 'noise-log', DB_VER = 2;
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result, tx = req.transaction;
        let ev;
        if (!db.objectStoreNames.contains('events')) { ev = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true }); ev.createIndex('startTs', 'startTs'); }
        else ev = tx.objectStore('events');
        if (!ev.indexNames.contains('uid')) ev.createIndex('uid', 'uid');
        if (!db.objectStoreNames.contains('log')) { const lg = db.createObjectStore('log', { keyPath: 'id', autoIncrement: true }); lg.createIndex('ts', 'ts'); }
        if (!db.objectStoreNames.contains('scans')) db.createObjectStore('scans', { keyPath: 'id' });       // יומן סריקות (טווחי זמן שכבר כוסו)
        if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'uid' }); // אירועים שנמחקו, כדי שלא יחזרו מהסנכרון
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  async function dbGetAll(store) { const db = await openDb(); return reqP(db.transaction(store).objectStore(store).getAll()); }
  async function dbAdd(store, value) { const db = await openDb(); return reqP(db.transaction(store, 'readwrite').objectStore(store).add(value)); }
  async function dbPut(store, value) { const db = await openDb(); return reqP(db.transaction(store, 'readwrite').objectStore(store).put(value)); }
  async function dbDelete(store, key) { const db = await openDb(); return reqP(db.transaction(store, 'readwrite').objectStore(store).delete(key)); }
  async function dbClear(store) { const db = await openDb(); return reqP(db.transaction(store, 'readwrite').objectStore(store).clear()); }

  // ---------- יומן פעולות (session log) ----------
  const logLines = [];
  async function log(type, message) {
    const entry = { ts: Date.now(), type, message };
    logLines.push(entry);
    renderLog();
    try { await dbAdd('log', entry); } catch (e) { console.warn('log save failed', e); }
  }

  // ---------- עזרי זמן ופורמט ----------
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function fmtDate(ts) { const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
  function fmtDateIso(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fmtTime(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function fmtTimeMs(ts) { const d = new Date(ts); return `${fmtTime(ts)}.${pad(d.getMilliseconds(), 3)}`; }
  function fmtStamp(ts) { const d = new Date(ts); return `${fmtDateIso(ts)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; }
  function fmtHms(sec) { sec = Math.round(sec || 0); return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`; }
  function fmtBytes(b) { return b >= 1048576 ? (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + ' MB' : Math.round(b / 1024) + ' KB'; }
  function setTimeInputs(dateEl, timeEl, ms) { const d = new Date(ms); dateEl.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; timeEl.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function readTimeInputs(dateEl, timeEl) { if (!dateEl.value || !timeEl.value) return null; const t = timeEl.value.length === 5 ? timeEl.value + ':00' : timeEl.value; const d = new Date(`${dateEl.value}T${t}`); return isNaN(d) ? null : d.getTime(); }
  function modeOf(name) { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : 'start'; }
  function fmtDelta(ms) { const sign = ms < 0 ? '-' : '+'; const a = Math.abs(ms); const days = Math.floor(a / 86400000); return `${sign}${days ? days + ' ימים ' : ''}${fmtHms((a % 86400000) / 1000)}`; }
  function toLocalInput(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function fmtDur(sec) { return sec >= 60 ? `${Math.floor(sec / 60)}:${pad(Math.round(sec % 60))} דק׳` : `${sec.toFixed(1)} שנ׳`; }
  // "לילה" = מ-12:00 בצהריים עד 12:00 למחרת, כדי שאירועים אחרי חצות ישויכו לאותו לילה
  function nightKey(ts) { return fmtDateIso(ts - 12 * 3600 * 1000); }
  function nightLabel(key) { const d = new Date(key + 'T12:00:00'); const n = new Date(d.getTime() + 86400000); return `לילה ${pad(d.getDate())}–${pad(n.getDate())}.${pad(n.getMonth() + 1)}.${n.getFullYear()}`; }
  // תצוגת רמה: dBFS + 100 (סולם יחסי, לא מכויל ל-dB(A))
  const disp = (dbfs) => Math.max(0, dbfs + 100);
  const fileName = (e) => e.driveFileName || `${fmtStamp(e.noiseTs)}_ev${e.id}.wav`;
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }); }
  function defaultDeviceName() { const ua = navigator.userAgent; if (/Android/i.test(ua)) return 'טלפון אנדרואיד'; if (/iPhone|iPad/i.test(ua)) return 'אייפון'; if (/Windows/i.test(ua)) return 'מחשב Windows'; if (/Mac/i.test(ua)) return 'מחשב Mac'; return 'מכשיר'; }
  function deviceInfo() {
    let changed = false;
    if (!settings.deviceId) { settings.deviceId = uuid(); changed = true; }
    if (!settings.deviceName) { settings.deviceName = defaultDeviceName(); changed = true; }
    if (changed) saveSettings();
    return { deviceId: settings.deviceId, deviceName: settings.deviceName };
  }
  function monthKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
  const sanitizeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').slice(0, 40);

  // ---------- זיהוי אירועים ----------
  class Detector {
    constructor(sampleRate, s, onEvent) {
      this.sr = sampleRate; this.s = s; this.onEvent = onEvent;
      this.recent = []; this.recentSamples = 0; // pre-roll buffer
      this.active = null;
      this.lastDb = -100;
      // מסנן תדרים נמוכים (רעשי קיר ורצפה) – בשימוש כשההגדרה detectBand היא 'low'
      this.lpf = window.NoiseScan ? [new NoiseScan.Biquad('lowpass', NoiseScan.LOW_BAND_HZ, sampleRate), new NoiseScan.Biquad('lowpass', NoiseScan.LOW_BAND_HZ, sampleRate)] : null;
      this.tmp = null;
    }
    push(samples, wall) {
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) { const v = samples[i]; sumSq += v * v; }
      const rms = Math.sqrt(sumSq / samples.length);
      let db = 20 * Math.log10(Math.max(rms, 1e-6));
      this.lastDbFull = db;
      if (this.lpf) {
        if (!this.tmp || this.tmp.length < samples.length) this.tmp = new Float32Array(samples.length);
        const lf = this.lpf[1].run(this.lpf[0].run(samples, this.tmp), this.tmp);
        let sl = 0; for (let i = 0; i < samples.length; i++) sl += lf[i] * lf[i];
        this.lastDbLow = 20 * Math.log10(Math.max(Math.sqrt(sl / samples.length), 1e-6));
        if (this.s.detectBand === 'low') db = this.lastDbLow;
      }
      this.lastDb = db;
      const loud = disp(db) >= this.s.threshold;
      const chunkMs = samples.length / this.sr * 1000;
      const endWall = wall + chunkMs;

      if (this.active) {
        const ev = this.active;
        ev.chunks.push(samples); ev.n += samples.length; ev.sumSq += sumSq;
        if (db > ev.peakDb) ev.peakDb = db;
        if (loud) ev.lastLoudWall = endWall;
        const quietFor = (endWall - ev.lastLoudWall) / 1000;
        if (quietFor >= this.s.tail) {
          this.finish(ev, false);
        } else if (ev.n / this.sr >= this.s.maxClip) {
          this.finish(ev, true);
          if (loud) this.begin(wall, samples, sumSq, db, false); // הרעש נמשך – פותחים קליפ המשך
        }
      } else if (loud) {
        this.begin(wall, samples, sumSq, db, true);
      }

      // שמירת pre-roll
      this.recent.push({ samples, wall, sumSq });
      this.recentSamples += samples.length;
      const maxPre = this.s.pre * this.sr;
      while (this.recent.length > 1 && this.recentSamples - this.recent[0].samples.length >= maxPre) {
        this.recentSamples -= this.recent.shift().samples.length;
      }
    }
    begin(wall, samples, sumSq, db, usePre) {
      const ev = { chunks: [], n: 0, sumSq: 0, peakDb: db, firstLoudWall: wall, lastLoudWall: wall + samples.length / this.sr * 1000, startWall: wall };
      if (usePre && this.recent.length) {
        ev.startWall = this.recent[0].wall;
        for (const c of this.recent) { ev.chunks.push(c.samples); ev.n += c.samples.length; ev.sumSq += c.sumSq; }
      }
      ev.chunks.push(samples); ev.n += samples.length; ev.sumSq += sumSq;
      this.active = ev;
      this.recent = []; this.recentSamples = 0;
    }
    finish(ev, truncated) {
      this.active = null;
      this.recent = []; this.recentSamples = 0;
      const out = new Float32Array(ev.n);
      let o = 0; for (const c of ev.chunks) { out.set(c, o); o += c.length; }
      this.onEvent({
        startTs: Math.round(ev.startWall),
        noiseTs: Math.round(ev.firstLoudWall),
        endTs: Math.round(ev.startWall + ev.n / this.sr * 1000),
        durationSec: ev.n / this.sr,
        peakDb: ev.peakDb,
        avgDb: 20 * Math.log10(Math.max(Math.sqrt(ev.sumSq / ev.n), 1e-6)),
        sampleRate: this.sr, samples: out, truncated,
      });
    }
    flush() { if (this.active) this.finish(this.active, true); }
  }

  // ---------- WAV ----------
  function encodeWav(f32, sr) {
    const n = f32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ---------- ZIP (store only, ללא דחיסה – WAV ממילא לא נדחס טוב) ----------
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function dosDateTime(d) {
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
             date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  }
  async function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(await f.data.arrayBuffer());
      const name = enc.encode(f.name);
      const crc = crc32(data);
      const { time, date } = dosDateTime(f.date || new Date());
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.byteLength, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
    eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true); eocd.setUint16(20, 0, true);
    return new Blob([...parts, ...central, eocd.buffer], { type: 'application/zip' });
  }

  // ---------- CSV ----------
  function csvCell(v) { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
  function eventsCsv(list) {
    const head = ['#', 'תאריך', 'שעת תחילת הרעש', 'תחילת הקליפ', 'סיום הקליפ', 'משך הקליפ (שניות)', 'רמת שיא', 'רמה ממוצעת', 'קליפ קטוע', 'סיווג אוטומטי', 'הערה', 'קובץ', 'מקור', 'היסט בהקלטה המקורית', 'מכשיר', 'Drive'];
    const rows = list.slice().sort((a, b) => a.noiseTs - b.noiseTs).map((e) => [
      e.id, fmtDate(e.noiseTs), fmtTimeMs(e.noiseTs), fmtTime(e.startTs), fmtTime(e.endTs),
      e.durationSec.toFixed(1), disp(e.peakDb).toFixed(1), disp(e.avgDb).toFixed(1), e.truncated ? 'כן' : '', KIND_LABEL[e.kind] || '', e.note || '', fileName(e),
      e.source === 'file' ? e.sourceName : 'מיקרופון', e.source === 'file' ? fmtHms(e.offsetSec) : '', e.deviceName || '', e.driveFileId ? (e.remote ? 'מ-Drive' : 'הועלה') : '']);
    return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  function logCsv(list) {
    const head = ['תאריך', 'שעה', 'סוג', 'הודעה'];
    const rows = list.map((l) => [fmtDate(l.ts), fmtTimeMs(l.ts), l.type, l.message]);
    return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // ---------- ניטור ----------
  let ctx = null, stream = null, srcNode = null, procNode = null, silentGain = null;
  let monitoring = false, detector = null, wakeLock = null, watchdog = null;
  let lastChunkAt = 0, sessionId = null, sessionEvents = 0, skippedSpeech = 0, wakeLockWarned = false;
  let events = [];

  async function startMonitoring() {
    if (monitoring) return;
    setStatus('מבקש גישה למיקרופון…', 'wait');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      setStatus('אין גישה למיקרופון: ' + e.message, 'err');
      log('שגיאה', 'בקשת מיקרופון נכשלה: ' + e.message);
      return;
    }
    try { ctx = new AudioContext({ sampleRate: settings.sampleRate }); } catch (e) { ctx = new AudioContext(); }
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* ignore */ } }

    srcNode = ctx.createMediaStreamSource(stream);
    silentGain = ctx.createGain(); silentGain.gain.value = 0; silentGain.connect(ctx.destination);

    let usedWorklet = false;
    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule('noise-worklet.js');
        procNode = new AudioWorkletNode(ctx, 'noise-processor', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        procNode.port.onmessage = (e) => onChunk(e.data.samples, e.data.frame / ctx.sampleRate);
        usedWorklet = true;
      } catch (e) { log('אזהרה', 'AudioWorklet לא זמין, עובר ל-ScriptProcessor: ' + e.message); }
    }
    if (!usedWorklet) {
      procNode = ctx.createScriptProcessor(2048, 1, 1);
      procNode.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)), e.playbackTime);
    }
    srcNode.connect(procNode); procNode.connect(silentGain);

    detector = new Detector(ctx.sampleRate, settings, saveEvent);
    monitoring = true; sessionId = Date.now(); sessionEvents = 0; skippedSpeech = 0; lastChunkAt = Date.now(); wakeLockWarned = false;
    const track = stream.getAudioTracks()[0];
    const st = track.getSettings ? track.getSettings() : {};
    track.onended = () => { if (monitoring) { log('אזהרה', 'המיקרופון נותק על ידי המערכת'); setStatus('המיקרופון נותק – לחץ "התחל" שוב', 'err'); stopMonitoring(true); } };
    ctx.onstatechange = () => { if (monitoring) log(ctx.state === 'running' ? 'מידע' : 'אזהרה', 'מצב האודיו: ' + ctx.state); if (monitoring && ctx.state !== 'running') ctx.resume().catch(() => {}); };

    await acquireWakeLock();
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
    watchdog = setInterval(watchdogTick, 5000);
    log('התחלה', `ניטור התחיל. סף ${settings.threshold}, קצב דגימה ${ctx.sampleRate} Hz, מיקרופון: ${track.label || 'לא ידוע'}${st.noiseSuppression ? ' (אזהרה: הדפדפן השאיר סינון רעשים דלוק)' : ''}`);
    setStatus('מנטר…', 'on');
    updateButtons();
  }

  function stopMonitoring(fromError) {
    if (!monitoring) return;
    monitoring = false;
    clearInterval(watchdog); watchdog = null;
    try { detector && detector.flush(); } catch (e) { /* ignore */ }
    try { procNode && procNode.disconnect(); srcNode && srcNode.disconnect(); silentGain && silentGain.disconnect(); } catch (e) { /* ignore */ }
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { ctx && ctx.close(); } catch (e) { /* ignore */ }
    ctx = null; stream = null; procNode = null; srcNode = null; detector = null;
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
    log('סיום', `ניטור הופסק${fromError ? ' (בגלל תקלה)' : ''}. אירועים במפגש זה: ${sessionEvents}${skippedSpeech ? `. ${skippedSpeech} אירועים סוננו (דיבור/נשימות) ולא נשמרו` : ''}`);
    if (sessionId) { const dev = deviceInfo(); dbPut('scans', { id: uuid(), type: 'live', startTs: sessionId, endTs: Date.now(), scannedAt: Date.now(), deviceId: dev.deviceId, deviceName: dev.deviceName, eventsSaved: sessionEvents, threshold: settings.threshold }).catch(() => {}); }
    if (!fromError) setStatus('לא מנטר', 'off');
    updateButtons();
    $('#meterFill').style.width = '0%'; $('#meterVal').textContent = '–';
  }

  function onChunk(samples, audioTime) {
    if (!monitoring || !ctx) return;
    lastChunkAt = Date.now();
    // זמן קיר של תחילת המקטע = עכשיו פחות הזמן שחלף מאז שהמקטע נדגם (לפי שעון האודיו)
    const lag = Math.max(0, ctx.currentTime - audioTime) * 1000;
    detector.push(samples, Date.now() - lag);
    updateMeter(detector.lastDb);
  }

  function watchdogTick() {
    if (!monitoring) return;
    if (Date.now() - lastChunkAt > 5000) {
      log('אזהרה', 'לא התקבל אודיו מהמיקרופון במשך 5 שניות ומעלה – ייתכן פער בהקלטה');
      setStatus('אין אודיו – בודק…', 'err');
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    } else if ($('#status').dataset.state === 'err') {
      setStatus('מנטר…', 'on');
    }
    if (!wakeLock && settings.keepAwake && document.visibilityState === 'visible') acquireWakeLock();
  }

  async function acquireWakeLock() {
    if (!settings.keepAwake || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      if (!wakeLockWarned) { wakeLockWarned = true; log('אזהרה', 'לא ניתן למנוע כיבוי מסך: ' + e.message + '. השאר את המסך דלוק ידנית'); }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!monitoring) return;
    if (document.visibilityState === 'visible') {
      log('מידע', 'הדף חזר לחזית');
      acquireWakeLock();
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    } else {
      log('מידע', 'הדף עבר לרקע – בחלק מהמכשירים ההקלטה עלולה להיעצר');
    }
  });

  async function saveEvent(ev) {
    let kind = 'unknown';
    try { if (window.NoiseScan) kind = NoiseScan.classify(ev.samples, ev.sampleRate).kind; } catch (e) { /* ignore */ }
    if ((kind === 'speech' && settings.skipSpeech) || (kind === 'breath' && settings.skipBreath)) { skippedSpeech++; $('#nightSkipped').textContent = `לא נשמרו (סינון ${kind === 'speech' ? 'דיבור' : 'נשימות'}): ${skippedSpeech}`; return; }
    const dev = deviceInfo();
    const rec = { kind, uid: uuid(), deviceId: dev.deviceId, deviceName: dev.deviceName, updatedAt: Date.now(),
      startTs: ev.startTs, noiseTs: ev.noiseTs, endTs: ev.endTs, durationSec: ev.durationSec,
      peakDb: ev.peakDb, avgDb: ev.avgDb, sampleRate: ev.sampleRate, truncated: ev.truncated,
      note: '', sessionId, blob: encodeWav(ev.samples, ev.sampleRate),
    };
    try {
      rec.id = await dbAdd('events', rec);
    } catch (e) {
      log('שגיאה', 'שמירת אירוע נכשלה: ' + e.message);
      return;
    }
    sessionEvents++;
    events.push(rec);
    log('אירוע', `רעש ב-${fmtTime(rec.noiseTs)} (שיא ${disp(rec.peakDb).toFixed(0)}, ${fmtDur(rec.durationSec)})${rec.truncated ? ' – הקליפ הגיע לאורך המרבי' : ''}`);
    renderEvents(); refreshStorage();
    $('#nightCount').textContent = sessionEvents;
  }

  // ---------- כיול אוטומטי ----------
  async function autoCalibrate() {
    if (!monitoring) { alert('קודם התחל ניטור, ואז לחץ כיול.'); return; }
    const btn = $('#calibrateBtn'); btn.disabled = true;
    const samplesDb = [], fullDb = [];
    const start = Date.now();
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (detector) { samplesDb.push(disp(detector.lastDb)); fullDb.push(disp(detector.lastDbFull !== undefined ? detector.lastDbFull : detector.lastDb)); }
        const left = 5 - Math.floor((Date.now() - start) / 1000);
        btn.textContent = `מודד שקט… ${Math.max(0, left)}`;
        if (Date.now() - start >= 5000) { clearInterval(iv); resolve(); }
      }, 100);
    });
    btn.disabled = false; btn.textContent = 'כיול אוטומטי (5 שנ׳ שקט)';
    if (!samplesDb.length) return;
    samplesDb.sort((a, b) => a - b); fullDb.sort((a, b) => a - b);
    const floor = samplesDb[Math.floor(samplesDb.length * 0.9)]; // כמעט הרמה הגבוהה ביותר בשקט
    const floorFull = fullDb[Math.floor(fullDb.length * 0.9)];
    settings.threshold = Math.min(99, Math.round(settings.detectBand === 'low' ? Math.max(floor + 12, floorFull + 8) : floor + 12));
    saveSettings(); syncSettingsUi();
    log('מידע', `כיול: רמת רקע ${floor.toFixed(0)}, סף חדש ${settings.threshold}`);
  }

  // ---------- תצוגה ----------
  function setStatus(text, state) { const el = $('#status'); el.textContent = text; el.dataset.state = state; }
  function updateButtons() {
    $('#startBtn').hidden = monitoring; $('#stopBtn').hidden = !monitoring;
    $('#nightBtn').disabled = !monitoring;
    document.body.classList.toggle('monitoring', monitoring);
  }
  let meterPeakHold = 0, meterPeakAt = 0;
  function updateMeter(dbfs) {
    const v = disp(dbfs);
    const now = Date.now();
    if (v >= meterPeakHold || now - meterPeakAt > 1500) { meterPeakHold = v; meterPeakAt = now; }
    $('#meterFill').style.width = `${Math.min(100, v)}%`;
    $('#meterFill').classList.toggle('hot', v >= settings.threshold);
    $('#meterVal').textContent = v.toFixed(0);
    $('#meterPeak').style.right = `${100 - Math.min(100, meterPeakHold)}%`;
    if (!$('#night').hidden) {
      $('#nightLevel').style.width = `${Math.min(100, v)}%`;
      $('#nightLevel').classList.toggle('hot', v >= settings.threshold);
    }
  }
  function syncSettingsUi() {
    $('#threshold').value = settings.threshold; $('#thresholdVal').textContent = settings.threshold;
    $('#meterThr').style.right = `${100 - settings.threshold}%`;
    $('#pre').value = settings.pre; $('#tail').value = settings.tail; $('#maxClip').value = settings.maxClip;
    $('#sampleRate').value = String(settings.sampleRate); $('#keepAwake').checked = settings.keepAwake; $('#skipSpeech').checked = !!settings.skipSpeech; $('#skipBreath').checked = !!settings.skipBreath; $('#lowBand').checked = settings.detectBand === 'low';
  }

  let currentFilter = 'all';
  let kindFilter = null; let eventSort = 'time';
  function filteredEvents() {
    return events.filter((e) => (currentFilter === 'all' || nightKey(e.noiseTs) === currentFilter) && kindFilter.has(e.kind || 'unknown'));
  }
  function renderKindFilter() {
    const box = $('#kindFilter'); if (!box) return;
    const inNight = events.filter((e) => currentFilter === 'all' || nightKey(e.noiseTs) === currentFilter);
    const counts = {}; for (const e of inNight) { const k = e.kind || 'unknown'; counts[k] = (counts[k] || 0) + 1; }
    box.innerHTML = KIND_ORDER.filter((k) => counts[k]).map((k) => `<button type="button" class="chip kind-chip ${kindFilter.has(k) ? 'on' : ''}" data-kind="${k}">${KIND_LABEL[k]} <b>${counts[k]}</b></button>`).join('');
  }
  function renderNightFilter() {
    const sel = $('#nightFilter');
    const keys = Array.from(new Set(events.map((e) => nightKey(e.noiseTs)))).sort().reverse();
    const prev = sel.value || 'all';
    sel.innerHTML = '<option value="all">כל הלילות</option>' + keys.map((k) => `<option value="${k}">${nightLabel(k)}</option>`).join('');
    sel.value = keys.includes(prev) ? prev : 'all';
    currentFilter = sel.value;
  }
  const selectedIds = new Set();
  const KIND_LABEL = { bang: 'דפיקה', bangdrag: 'דפיקה + גרירה', noise: 'רעש רציף', breath: 'נשימה', speech: 'ייתכן דיבור', unknown: 'לא ידוע' };
  const KIND_ORDER = ['bang', 'bangdrag', 'noise', 'breath', 'speech', 'unknown'];
  kindFilter = new Set(KIND_ORDER);
  function segText(cls) { return cls && cls.segments && cls.segments.length ? 'רצף: ' + cls.segments.map((g) => `${{ bang: 'דפיקה', drag: 'רעש רציף', breath: 'נשימה' }[g.kind] || g.kind} ${g.dur}s`).join(', ') : ''; }
  function kindTag(kind, extra) { return KIND_LABEL[kind] ? `<span class="tag kind-${kind}" title="סיווג אוטומטי לפי מאפייני הקול, עלול לטעות${extra ? '. ' + escapeHtml(extra) : ''}">${KIND_LABEL[kind]}${kind === 'breath' && extra && /מחזורי/.test(extra) ? '?' : ''}</span>` : ''; }
  function renderBulkBar() {
    const n = selectedIds.size; $('#bulkBar').hidden = !n; $('#bulkCount').textContent = n;
  }
  function renderEvents() {
    renderNightFilter();
    renderKindFilter();
    renderBulkBar();
    const list = filteredEvents().slice().sort((a, b) => (eventSort === 'level' ? b.peakDb - a.peakDb || b.noiseTs - a.noiseTs : b.noiseTs - a.noiseTs));
    $('#eventCount').textContent = list.length;
    const ul = $('#events');
    ul.innerHTML = '';
    if (!list.length) { ul.innerHTML = '<li class="empty">עדיין אין אירועים. התחל ניטור והשאר את המכשיר ליד הקיר או על הרצפה.</li>'; return; }
    for (const e of list) {
      const li = document.createElement('li');
      li.className = 'event';
      li.dataset.id = e.id;
      li.innerHTML = `
        <div class="ev-head">
          <label class="ev-time"><input type="checkbox" class="sel" data-act="sel" ${selectedIds.has(e.id) ? 'checked' : ''} title="סמן לפעולה קבוצתית"><span class="ltr">${fmtTime(e.noiseTs)}</span><small class="ltr">${fmtDate(e.noiseTs)}</small></label>
          <div class="ev-meta">
            <span title="רמת שיא (סולם יחסי)">שיא <b>${disp(e.peakDb).toFixed(0)}</b></span>
            <span title="אורך הקליפ כולל השניות שלפני ואחרי">${fmtDur(e.durationSec)}</span>
            ${kindTag(e.kind, e.rhythmic ? 'רעש מחזורי (כמו נשימות)' : '')}
            ${e.truncated ? '<span class="tag">קטוע</span>' : ''}
            ${e.source === 'file' ? `<span class="tag file" title="${escapeHtml(e.sourceName || '')} @ ${fmtHms(e.offsetSec)}">מקובץ</span>` : ''}
            ${cloudTag(e)}
            ${e.timeCorrected ? `<span class="tag" title="הזמן תוקן ידנית. במקור: ${fmtDate(e.originalNoiseTs)} ${fmtTime(e.originalNoiseTs)}">זמן תוקן</span>` : ''}
          </div>
        </div>
        <div class="ev-actions">
          <button class="btn small" data-act="play">▶ נגן</button>
          <button class="btn small" data-act="download">⬇ הורד</button>
          <button class="btn small danger" data-act="delete">🗑</button>
        </div>
        <input class="note" data-act="note" placeholder="הערה: דפיקות / גרירה / הפלה…" value="${escapeHtml(e.note || '')}">
        <div class="player" hidden></div>`;
      ul.appendChild(li);
    }
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function cloudTag(e) {
    if (e.remote) return `<span class="tag cloud" title="הועלה ממכשיר אחר${e.blob ? ', יש עותק מקומי' : ', ינוגן מ-Drive'}">☁ מ-Drive · ${escapeHtml(e.deviceName || '')}</span>`;
    if (e.driveFileId) return `<span class="tag cloud" title="${escapeHtml(e.driveFileName || '')}">☁ הועלה · ${escapeHtml(e.deviceName || '')}</span>`;
    return driveConfigured() ? '<span class="tag pending" title="יועלה בסנכרון הבא">☁ ממתין</span>' : '';
  }
  async function ensureBlob(ev, btn) {
    if (ev.blob) return ev.blob;
    if (!ev.driveFileId) throw new Error('אין קובץ לאירוע הזה');
    if (btn) btn.disabled = true;
    try { ev.blob = await drive.download(ev.driveFileId); await dbPut('events', ev); renderEvents(); return ev.blob; }
    finally { if (btn) btn.disabled = false; }
  }
  async function deleteEvent(ev, alsoDriveDecided) {
    // מחיקה מקומית; אם האירוע הועלה, נשמרת "מצבה" כדי שהסנכרון לא יחזיר אותו, ואופציונלית נמחק גם מ-Drive
    if (ev.uid && ev.driveFileId) {
      const alsoDrive = ev.remote ? false : (alsoDriveDecided !== undefined ? alsoDriveDecided : confirm('למחוק גם את הקובץ מ-Drive? (ייעלם גם ממכשירים אחרים בסנכרון הבא). "ביטול" = למחוק רק מהמכשיר הזה.'));
      await dbPut('tombstones', { uid: ev.uid, driveDelete: alsoDrive, fileId: ev.driveFileId, ts: Date.now(), done: false });
    }
    await dbDelete('events', ev.id);
    events = events.filter((x) => x.id !== ev.id); selectedIds.delete(ev.id);
  }

  $('#events').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const li = btn.closest('li.event'); const id = Number(li.dataset.id);
    const ev = events.find((x) => x.id === id); if (!ev) return;
    if (btn.dataset.act === 'play') {
      const p = li.querySelector('.player');
      if (!p.hidden) { p.hidden = true; p.innerHTML = ''; return; }
      let blob; try { blob = await ensureBlob(ev, btn); } catch (err) { alert('לא ניתן להוריד מ-Drive: ' + err.message); return; }
      const li2 = $(`#events li.event[data-id="${id}"]`) || li; const p2 = li2.querySelector('.player');
      const a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(blob);
      p2.innerHTML = ''; p2.appendChild(a); p2.hidden = false; a.play().catch(() => {});
    } else if (btn.dataset.act === 'download') {
      let blob; try { blob = await ensureBlob(ev, btn); } catch (err) { alert('לא ניתן להוריד מ-Drive: ' + err.message); return; }
      downloadBlob(blob, fileName(ev));
    } else if (btn.dataset.act === 'delete') {
      const q = ev.remote ? `להסיר מהמכשיר את האירוע מ-${fmtTime(ev.noiseTs)} ${fmtDate(ev.noiseTs)}? הקובץ ב-Drive יישאר.` : `למחוק את האירוע מ-${fmtTime(ev.noiseTs)} ${fmtDate(ev.noiseTs)}?`;
      if (!confirm(q)) return;
      await deleteEvent(ev);
      log('מידע', `אירוע ${id} נמחק ידנית`);
      renderEvents(); refreshStorage();
    }
  });
  $('#events').addEventListener('change', async (e) => {
    const sel = e.target.closest('input[data-act="sel"]');
    if (sel) { const id = Number(sel.closest('li.event').dataset.id); if (sel.checked) selectedIds.add(id); else selectedIds.delete(id); renderBulkBar(); return; }
    const inp = e.target.closest('input[data-act="note"]'); if (!inp) return;
    const id = Number(inp.closest('li.event').dataset.id);
    const ev = events.find((x) => x.id === id); if (!ev) return;
    ev.note = inp.value.trim(); ev.updatedAt = Date.now();
    await dbPut('events', ev);
  });

  function renderLog() {
    const el = $('#log');
    const last = logLines.slice(-60).reverse();
    el.innerHTML = last.map((l) => `<div class="log-line log-${l.type}"><span class="ltr">${fmtDate(l.ts)} ${fmtTime(l.ts)}</span> <b>${l.type}</b> ${escapeHtml(l.message)}</div>`).join('');
  }
  async function refreshStorage() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return;
      const est = await navigator.storage.estimate();
      const mb = (n) => (n / 1048576).toFixed(0);
      $('#storage').textContent = `אחסון: ${mb(est.usage || 0)} MB בשימוש מתוך ~${mb(est.quota || 0)} MB`;
    } catch (e) { /* ignore */ }
  }

  // ---------- ייצוא ----------
  async function exportCsv() {
    const list = filteredEvents();
    if (!list.length) { alert('אין אירועים לייצוא.'); return; }
    downloadBlob(new Blob([eventsCsv(list)], { type: 'text/csv;charset=utf-8' }), `noise-events_${currentFilter}.csv`);
  }
  async function exportZip() {
    const list = filteredEvents();
    if (!list.length) { alert('אין אירועים לייצוא.'); return; }
    const btn = $('#zipBtn'); btn.disabled = true; btn.textContent = 'אורז…';
    try {
      let logAll = [];
      try { logAll = await dbGetAll('log'); } catch (e) { logAll = logLines; }
      const files = [
        { name: 'events.csv', data: new TextEncoder().encode(eventsCsv(list)) },
        { name: 'log.csv', data: new TextEncoder().encode(logCsv(logAll)) },
        { name: 'README.txt', data: new TextEncoder().encode(readmeText(list)) },
      ];
      const missing = list.filter((e) => !e.blob && e.driveFileId);
      for (let i = 0; i < missing.length; i++) { btn.textContent = `מוריד מ-Drive ${i + 1}/${missing.length}…`; await ensureBlob(missing[i]); }
      for (const e of list.slice().sort((a, b) => a.noiseTs - b.noiseTs)) if (e.blob) files.push({ name: 'clips/' + fileName(e), data: e.blob, date: new Date(e.noiseTs) });
      const zip = await makeZip(files);
      downloadBlob(zip, `noise-evidence_${currentFilter}_${fmtStamp(Date.now())}.zip`);
      log('מידע', `יוצא ZIP עם ${list.length} קליפים`);
    } catch (e) {
      alert('הייצוא נכשל: ' + e.message);
    } finally { btn.disabled = false; btn.textContent = 'ייצוא ZIP (קליפים + CSV + יומן)'; }
  }
  function readmeText(list) {
    return [
      'יומן רעש לילי – ייצוא ראיות',
      `נוצר: ${fmtDate(Date.now())} ${fmtTime(Date.now())}`,
      `מספר אירועים: ${list.length}`,
      '',
      'events.csv – טבלת האירועים (זמן תחילת הרעש, משך, רמה, הערות, שם קובץ).',
      'log.csv    – יומן פעולות: מתי הניטור התחיל/הופסק, אזהרות על פערים בהקלטה.',
      'clips/     – קובצי WAV, אחד לכל אירוע. שם הקובץ = תאריך ושעה מקומיים של תחילת הרעש.',
      '',
      'רמות הרעש הן בסולם יחסי (dBFS + 100) ולא מכוילות ל-dB(A).',
      'הזמנים לפי שעון המכשיר. כל קליפ כולל כמה שניות שקט לפני ואחרי הרעש.',
      'הקבצים לא נערכו. מומלץ לשמור עותק במקום נוסף (ענן/מחשב) מיד לאחר הייצוא.',
    ].join('\r\n');
  }

  // ---------- מצב לילה ----------
  function showNight() {
    $('#night').hidden = false;
    document.body.classList.add('night');
    tickNightClock();
  }
  function hideNight() { $('#night').hidden = true; document.body.classList.remove('night'); }
  function tickNightClock() {
    if ($('#night').hidden) return;
    $('#nightClock').textContent = fmtTime(Date.now()).slice(0, 5);
    setTimeout(tickNightClock, 5000);
  }

  // ---------- ייבוא הקלטה קיימת ----------
  let imp = null;
  function makeWorkerClient(w) {
    let seq = 0; const pending = new Map();
    w.onmessage = (e) => {
      const m = e.data; const p = pending.get(m.reqId); if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.fraction); }
      else if (m.type === 'clip') { if (p.onClip) p.onClip(m); }
      else if (m.type === 'error') { pending.delete(m.reqId); p.reject(new Error(m.message)); }
      else { pending.delete(m.reqId); p.resolve(m); }
    };
    w.onerror = (e) => { const err = new Error(e.message || 'שגיאה ברכיב הסריקה'); for (const p of pending.values()) p.reject(err); pending.clear(); };
    return {
      call(type, payload, handlers) { const reqId = ++seq; return new Promise((resolve, reject) => { pending.set(reqId, Object.assign({ resolve, reject }, handlers || {})); w.postMessage(Object.assign({ type, reqId }, payload || {})); }); },
      post(type, payload) { w.postMessage(Object.assign({ type, reqId: 0 }, payload || {})); },
      terminate() { w.terminate(); pending.clear(); },
    };
  }
  function impError(msg) {
    const el = $('#impError'); el.textContent = msg; el.hidden = false;
    $('#impProgress').hidden = true; $('#impScanBtn').disabled = false; $('#impCancelBtn').hidden = true;
    log('שגיאה', 'ייבוא: ' + msg);
  }
  function resetImport() {
    if (imp && imp.client) imp.client.terminate();
    imp = null;
    for (const id of ['impInfo', 'impResult', 'impReview', 'impError', 'impProgress', 'impNote']) $('#' + id).hidden = true;
    $('#impScanBtn').disabled = false; $('#impCancelBtn').hidden = true; $('#impSaved').textContent = '';
  }
  async function onFileChosen(file) {
    resetImport();
    if (!file) return;
    if (!window.NoiseScan) { impError('רכיב הסריקה (scan.js) לא נטען'); return; }
    imp = { file };
    $('#impName').textContent = file.name; $('#impFormat').textContent = 'בודק את הקובץ…'; $('#impDuration').textContent = '';
    $('#impInfo').hidden = false; $('#impScanBtn').disabled = true;
    let scanner;
    try { scanner = await NoiseScan.open(file); } catch (e) { impError(e.message); return; }
    imp.scanner = scanner; imp.info = scanner.info;
    const info = imp.info;
    if (!info.supported) {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const canFullDecode = OAC && (info.needsFullDecode || info.format === 'mp4' || info.format === 'mp3');
      if (!canFullDecode) { impError(info.reason || 'פורמט לא נתמך'); return; }
      imp.fullDecode = true;
      $('#impNote').textContent = (info.reason ? info.reason + '. ' : '') + 'הקובץ יפוענח כולו בזיכרון; מתאים להקלטות של עד כשעה.';
      $('#impNote').hidden = false;
    }
    $('#impFormat').textContent = [String(info.format || '').toUpperCase(), info.codec, info.sampleRate ? info.sampleRate + ' Hz' : '', fmtBytes(file.size)].filter(Boolean).join(' · ');
    $('#impDuration').textContent = info.durationSec ? (info.durationEstimated ? '~' : '') + fmtHms(info.durationSec) : 'לא ידוע';
    renderStartCandidates();
    $('#impScanBtn').disabled = false;
  }
  function renderStartCandidates() {
    const cands = NoiseScan.startCandidates(imp.file, imp.info || {});
    imp.candidates = cands;
    const box = $('#impCandidates'); box.innerHTML = '';
    if (imp.startManual) { /* המשתמש כבר בחר זמן – לא דורסים */ }
    else if (cands.length) { setTimeInputs($('#impDate'), $('#impTime'), cands[0].time); $('#impModeStart').checked = true; $('#impStartSrc').textContent = 'מקור: ' + cands[0].source; }
    else { $('#impDate').value = ''; $('#impTime').value = ''; $('#impStartSrc').textContent = 'לא נמצא זמן בקובץ, הזן ידנית'; }
    renderImportRange();
    for (const c of cands) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
      b.innerHTML = `<span class="ltr">${fmtDate(c.time)} ${fmtTime(c.time)}</span> · ${escapeHtml(c.source)}`;
      b.addEventListener('click', () => { imp.startManual = true; setTimeInputs($('#impDate'), $('#impTime'), c.time); $('#impModeStart').checked = true; $('#impStartSrc').textContent = 'מקור: ' + c.source; onImportTimeChanged(); });
      box.appendChild(b);
    }
  }
  function importDurationSec() { return (imp && (imp.durationSec || (imp.info && imp.info.durationSec))) || 0; }
  // הזמן שהוזן הוא תחילת ההקלטה, או סיומה (ואז מחסירים את האורך)
  function currentStartMs() {
    const t = readTimeInputs($('#impDate'), $('#impTime')); if (t === null) return null;
    if (modeOf('impMode') === 'end') { const dur = importDurationSec(); return dur ? Math.round(t - dur * 1000) : null; }
    return t;
  }
  function renderImportRange() {
    if (!imp) return;
    const start = currentStartMs(), dur = importDurationSec(), el = $('#impRange');
    if (start === null) { el.textContent = modeOf('impMode') === 'end' && !dur ? 'אורך ההקלטה עדיין לא ידוע; זמן ההתחלה יחושב מזמן הסיום אחרי הסריקה.' : 'הזן תאריך ושעה.'; return; }
    el.textContent = dur ? `ההקלטה: ${fmtDate(start)} ${fmtTime(start)} עד ${fmtDate(start + dur * 1000)} ${fmtTime(start + dur * 1000)} (אורך ${fmtHms(dur)})` : `תחילת ההקלטה: ${fmtDate(start)} ${fmtTime(start)}`;
  }
  function onImportTimeChanged() {
    if (!imp) return;
    renderImportRange();
    if (imp.levels) { imp.startMs = currentStartMs(); drawTimeline(); if (imp.review) renderReview(); }
  }
  function setImpProgress(f, text) { $('#impProgress').hidden = false; $('#impBar').style.width = `${Math.round(f * 100)}%`; $('#impProgText').textContent = `${text} ${Math.round(f * 100)}%`; }
  // בר ההתקדמות מוצג מתחת לכפתור שהפעיל את הפעולה (סריקה / האזנה ובחירה / שמירה)
  function moveProgressAfter(btnId) { const row = $('#' + btnId).closest('.row'); const bar = $('#impProgress'); if (row && bar && row.nextElementSibling !== bar) row.insertAdjacentElement('afterend', bar); }

  async function runImportScan() {
    if (!imp || !imp.file) return;
    const startMs = currentStartMs();
    const deferredStart = startMs === null && modeOf('impMode') === 'end' && !importDurationSec();
    if (startMs === null && !deferredStart) { alert('הזן את התאריך והשעה של ההקלטה.'); return; }
    imp.startMs = startMs; imp.levels = null; imp.review = null; imp.coverageChecked = false;
    if (startMs !== null && imp.info && imp.info.durationSec) {
      if (!(await checkCoverage(startMs, startMs + imp.info.durationSec * 1000, imp.file))) return;
      imp.coverageChecked = true;
    }
    $('#impError').hidden = true; $('#impResult').hidden = true; $('#impReview').hidden = true; $('#impSaved').textContent = '';
    $('#impScanBtn').disabled = true; $('#impCancelBtn').hidden = false; moveProgressAfter('impScanBtn'); setImpProgress(0, 'מתחיל…');
    log('ייבוא', `סורק את ${imp.file.name} (${fmtBytes(imp.file.size)})${startMs !== null ? `, תחילת ההקלטה ${fmtDate(startMs)} ${fmtTime(startMs)}` : ''}`);
    try {
      if (imp.fullDecode) {
        if (imp.file.size > 200 * 1048576) throw new Error('הקובץ גדול מדי לפענוח מלא בדפדפן (מעל 200MB). המר ל-WAV/MP3/M4A או השתמש בכלי הפייתוני');
        setImpProgress(0, 'מפענח את כל הקובץ…');
        const buf = await imp.file.arrayBuffer();
        const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        let octx; try { octx = new OAC(1, 1, 16000); } catch (e) { octx = new OAC(1, 1, 44100); }
        let audio;
        try { audio = await octx.decodeAudioData(buf); }
        catch (e) { throw new Error(`הדפדפן לא הצליח לפענח את הקובץ (${e && e.message ? e.message : e}). ${imp.info.reason ? imp.info.reason + '. ' : ''}נסה ב-Chrome/Edge עדכני, המר את הקובץ ל-WAV/MP3, או השתמש בכלי הפייתוני (tools/noise_events.py)`); }
        imp.scanner = new NoiseScan.DecodedScanner(imp.file, audio);
        const r = await imp.scanner.scanLevels((f) => setImpProgress(f, 'מודד רמות…'));
        if (!r) throw new Error('הסריקה בוטלה');
        if (!imp.info.durationSec) { imp.info.durationSec = r.durationSec; renderStartCandidates(); }
        onLevels(r);
      } else if (window.Worker) {
        imp.client = makeWorkerClient(new Worker('scan-worker.js'));
        await imp.client.call('open', { file: imp.file });
        const r = await imp.client.call('scan', {}, { onProgress: (f) => setImpProgress(f, 'מפענח…') });
        onLevels(r);
      } else {
        const r = await imp.scanner.scanLevels((f) => setImpProgress(f, 'מפענח…'));
        if (!r) throw new Error('הסריקה בוטלה');
        onLevels(r);
      }
    } catch (e) {
      impError(e.message);
      if (imp && imp.client) { imp.client.terminate(); imp.client = null; }
      return;
    }
    $('#impProgress').hidden = true; $('#impCancelBtn').hidden = true; $('#impScanBtn').disabled = false;
  }
  function cancelImportScan() {
    if (!imp) return;
    if (imp.client) imp.client.post('cancel');
    if (imp.scanner && imp.scanner.cancel) imp.scanner.cancel();
  }
  function onLevels(r) {
    imp.levelsFull = r.levels; imp.levelsLow = r.levelsLow || r.levels; imp.floorFull = r.floorDb; imp.floorLow = r.floorLowDb !== undefined ? r.floorLowDb : r.floorDb;
    imp.sampleRate = r.sampleRate; imp.durationSec = r.durationSec;
    if (r.info) imp.info = Object.assign(imp.info || {}, r.info);
    imp.startMs = currentStartMs() ?? imp.startMs; renderImportRange();
    $('#impDuration').textContent = fmtHms(r.durationSec);
    $('#impResult').hidden = false;
    $(settings.detectBand === 'low' ? '#impBandLow' : '#impBandFull').checked = true;
    applyImportBand();
    log('ייבוא', `הסריקה הסתיימה: אורך ${fmtHms(r.durationSec)}, רמת רקע ${disp(imp.floorFull).toFixed(0)} (תדרים נמוכים: ${disp(imp.floorLow).toFixed(0)})`);
  }
  // בחירת הטווח לזיהוי: כל התדרים, או תדרים נמוכים בלבד (רעשי קיר ורצפה; נשימות ואיוושות כמעט לא נכנסות)
  function applyImportBand() {
    if (!imp || !imp.levelsFull) return;
    const low = modeOf('impBand') === 'low';
    imp.band = low ? 'low' : 'full';
    imp.levels = low ? imp.levelsLow : imp.levelsFull; imp.floorDb = low ? imp.floorLow : imp.floorFull;
    // בתדרים נמוכים רמת הרקע נמוכה מאוד, ולכן "רקע + 12" יהיה רגיש מדי; דפיקות דרך הקיר נמצאות בערך באותה רמה בשני הטווחים
    const thr = Math.min(99, Math.max(1, Math.round(low ? Math.max(disp(imp.floorLow) + 12, disp(imp.floorFull) + 8) : disp(imp.floorDb) + 12)));
    $('#impThr').value = thr; $('#impFloor').textContent = disp(imp.floorDb).toFixed(0);
    recountImport();
  }
  function recountImport() {
    if (!imp || !imp.levels) return;
    const thr = Number($('#impThr').value); $('#impThrVal').textContent = thr;
    imp.threshold = thr - 100;
    imp.detected = NoiseScan.detectFromLevels(imp.levels, { threshold: imp.threshold, pre: settings.pre, tail: settings.tail, maxClip: settings.maxClip });
    imp.review = null; $('#impReview').hidden = true; $('#impSaved').textContent = '';
    const n = imp.detected.length; const totalSec = imp.detected.reduce((a, e) => a + (e.endSec - e.startSec), 0);
    $('#impCount').textContent = n ? `${n} אירועים, סה"כ ${fmtDur(totalSec)} של קליפים (כ-${fmtBytes(totalSec * imp.sampleRate * 2)})` : 'לא נמצאו אירועים מעל הסף. הנמך את הסף.';
    $('#impReviewBtn').disabled = !n; $('#impReviewCount').textContent = n;
    drawTimeline();
  }
  function drawTimeline() {
    const cv = $('#impTimeline'); if (!imp || !imp.levels) return;
    const dpr = window.devicePixelRatio || 1; const W = Math.max(200, cv.clientWidth || 600), H = 96;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0b1220'; g.fillRect(0, 0, W, H);
    const lv = imp.levels, n = lv.length, plotH = H - 22, thr = imp.threshold;
    // הסולם מתחיל קצת מתחת לרמת הרקע, כדי שדפיקות יבלטו
    const lo = Math.max(0, disp(imp.floorDb) - 12), scale = (v) => Math.min(1, Math.max(0, (disp(v) - lo) / (100 - lo)));
    for (let x = 0; x < W; x++) {
      const a = Math.floor((x * n) / W), b = Math.max(a + 1, Math.floor(((x + 1) * n) / W));
      let mx = -100; for (let i = a; i < b && i < n; i++) if (lv[i] > mx) mx = lv[i];
      const v = scale(mx);
      g.fillStyle = mx >= thr ? '#f59e0b' : '#38bdf8'; g.fillRect(x, plotH - v * plotH, 1, v * plotH);
    }
    const ty = plotH - scale(thr) * plotH;
    g.strokeStyle = '#ffffff'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, ty + 0.5); g.lineTo(W, ty + 0.5); g.stroke();
    g.fillStyle = '#ef4444';
    for (const e of imp.detected || []) { const x0 = (e.startSec / imp.durationSec) * W, x1 = Math.max(x0 + 2, (e.endSec / imp.durationSec) * W); g.fillRect(x0, plotH + 3, x1 - x0, 5); }
    g.fillStyle = '#94a3b8'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'center';
    for (let k = 0; k <= 4; k++) {
      const t = (imp.durationSec * k) / 4; const label = imp.startMs ? fmtTime(imp.startMs + t * 1000).slice(0, 5) : fmtHms(t);
      g.fillText(label, Math.min(W - 18, Math.max(18, (W * k) / 4)), H - 3);
    }
  }
  // חילוץ קליפ אחד (להאזנה או לשמירה)
  async function extractOne(t0, t1) {
    if (imp.client) { let clip = null; await imp.client.call('extract', { ranges: [{ id: 0, t0, t1 }] }, { onClip: (m) => { clip = m; } }); return clip; }
    const samples = await imp.scanner.extract(t0, t1);
    return { samples, sampleRate: imp.scanner.outRate || imp.sampleRate };
  }
  // שלב הסקירה: מסווגים כל אירוע (דפיקה / רעש רציף / ייתכן דיבור) ומציגים רשימה עם האזנה ובחירה
  async function analyzeImport() {
    if (!imp || !imp.detected || !imp.detected.length) return;
    const list = imp.detected;
    $('#impReviewBtn').disabled = true; moveProgressAfter('impReviewBtn'); setImpProgress(0, 'מנתח אירועים…');
    let results;
    try {
      if (imp.client) {
        results = (await imp.client.call('analyze', { ranges: list.map((e, i) => ({ id: i, t0: e.startSec, t1: e.endSec })) }, { onProgress: (f) => setImpProgress(f, 'מנתח אירועים…') })).results;
      } else {
        results = [];
        for (let i = 0; i < list.length; i++) { const c = await extractOne(list[i].startSec, list[i].endSec); results.push(NoiseScan.classify(c.samples, c.sampleRate)); setImpProgress((i + 1) / list.length, 'מנתח אירועים…'); await new Promise((r) => setTimeout(r, 0)); }
      }
    } catch (e) { impError('הניתוח נכשל: ' + e.message); $('#impReviewBtn').disabled = false; return; }
    imp.review = list.map((e, i) => Object.assign({}, e, { cls: results[i], kind: results[i].kind, selected: true }));
    // רעש מחזורי (נשימות): אירועים במרווחים סדירים שסווגו כרעש רציף/נשימה/לא ידוע
    NoiseScan.markRhythmic(imp.review);
    // רצף מחזורי הופך "רעש רציף" לנשימה רק אם הצליל עצמו מתאים לנשימה: כמעט בלי תדרים נמוכים (גרירה או דפיקה מכילות הרבה)
    const lfOf = (cls) => (cls && cls.segments && cls.segments.length ? Math.max(...cls.segments.map((g) => g.lfRatio)) : 0);
    for (const r of imp.review) if (r.rhythmic && ['noise', 'unknown'].includes(r.kind) && lfOf(r.cls) < 0.3) r.kind = 'breath';
    imp.filter = { kinds: new Set(KIND_ORDER), minLevel: 0, sort: 'time' };
    $('#revMinLevel').value = 0; $('#revSortTime').checked = true;
    $('#impProgress').hidden = true; $('#impReviewBtn').disabled = false;
    renderReview();
    $('#impReview').hidden = false;
    $('#impReview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function visibleReview() {
    const f = imp.filter || { kinds: new Set(KIND_ORDER), minLevel: 0, sort: 'time' };
    const list = imp.review.map((r, i) => ({ r, i })).filter(({ r }) => f.kinds.has(r.kind || 'unknown') && disp(r.peakDb) >= f.minLevel);
    list.sort((a, b) => (f.sort === 'level' ? b.r.peakDb - a.r.peakDb || a.r.noiseSec - b.r.noiseSec : a.r.noiseSec - b.r.noiseSec));
    return list;
  }
  function renderReviewFilters() {
    const f = imp.filter; const counts = {};
    for (const r of imp.review) { const k = r.kind || 'unknown'; counts[k] = (counts[k] || 0) + 1; }
    $('#revKinds').innerHTML = KIND_ORDER.filter((k) => counts[k]).map((k) => `<button type="button" class="chip kind-chip ${f.kinds.has(k) ? 'on' : ''}" data-kind="${k}">${KIND_LABEL[k]} <b>${counts[k]}</b></button>`).join('');
    $('#revMinLevelVal').textContent = f.minLevel;
  }
  function renderReview() {
    if (!imp.filter) imp.filter = { kinds: new Set(KIND_ORDER), minLevel: 0, sort: 'time' };
    renderReviewFilters();
    const ul = $('#impReviewList'); ul.innerHTML = '';
    const startMs = currentStartMs() ?? imp.startMs;
    const vis = visibleReview();
    for (const { r, i } of vis) {
      const li = document.createElement('li'); li.className = 'rev' + (r.selected ? '' : ' off'); li.dataset.i = i;
      const ts = startMs + r.noiseSec * 1000;
      li.innerHTML = `
        <label class="rev-main">
          <input type="checkbox" data-act="sel" ${r.selected ? 'checked' : ''}>
          <span class="ev-time"><span class="ltr">${fmtTime(ts)}</span><small class="ltr">${fmtDate(ts)}</small></span>
          <span class="ev-meta">שיא <b>${disp(r.peakDb).toFixed(0)}</b> · ${fmtDur(r.endSec - r.startSec)} ${kindTag(r.kind, [r.rhythmic ? 'רעש מחזורי (כמו נשימות)' : '', segText(r.cls)].filter(Boolean).join('. '))}${r.truncated ? '<span class="tag">קטוע</span>' : ''}</span>
        </label>
        <button class="btn small" data-act="play" title="האזן">▶</button>
        <div class="player" hidden></div>`;
      ul.appendChild(li);
    }
    $('#revShown').textContent = vis.length;
    updateReviewSummary();
  }
  function updateReviewSummary() {
    const sel = imp.review.filter((r) => r.selected).length;
    const speech = imp.review.filter((r) => r.kind === 'speech').length, breath = imp.review.filter((r) => r.kind === 'breath').length;
    $('#impSelCount').textContent = sel; $('#impSaveBtn').disabled = !sel;
    $('#impReviewSummary').textContent = `${imp.review.length} אירועים, ${sel} מסומנים לשמירה${breath ? `. ${breath} נראים כנשימות או רעש מחזורי` : ''}${speech ? `. ${speech} נשמעים כדיבור` : ''}${breath || speech ? ' (מסומנים בתג, אפשר לבטל את סימונם בלחיצה)' : ''}.`;
  }
  async function playReview(li, i) {
    const p = li.querySelector('.player');
    if (!p.hidden) { p.hidden = true; p.innerHTML = ''; return; }
    const r = imp.review[i]; const btn = li.querySelector('button[data-act="play"]'); btn.disabled = true;
    try {
      const c = await extractOne(r.startSec, r.endSec);
      const a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(encodeWav(c.samples, c.sampleRate));
      p.innerHTML = ''; p.appendChild(a); p.hidden = false; a.play().catch(() => {});
    } catch (e) { p.innerHTML = `<span class="error">לא ניתן לנגן: ${escapeHtml(e.message)}</span>`; p.hidden = false; }
    finally { btn.disabled = false; }
  }
  async function saveImport() {
    if (!imp || !imp.review) return;
    const list = imp.review.filter((r) => r.selected);
    if (!list.length) return;
    const startMs = currentStartMs() ?? imp.startMs;
    if (startMs === null || startMs === undefined) { alert('הזן את התאריך והשעה של ההקלטה לפני השמירה.'); return; }
    imp.startMs = startMs;
    if (!imp.coverageChecked) { if (!(await checkCoverage(startMs, startMs + imp.durationSec * 1000, imp.file))) return; imp.coverageChecked = true; }
    const dev = deviceInfo();
    const importId = Date.now(); let saved = 0;
    $('#impSaveBtn').disabled = true; moveProgressAfter('impSaveBtn'); setImpProgress(0, 'שומר קליפים…');
    const saveOne = async (e, samples, sampleRate) => {
      const rec = {
        startTs: Math.round(startMs + e.startSec * 1000), noiseTs: Math.round(startMs + e.noiseSec * 1000), endTs: Math.round(startMs + e.endSec * 1000),
        durationSec: e.endSec - e.startSec, peakDb: e.peakDb, avgDb: e.avgDb, sampleRate, truncated: e.truncated, note: '', kind: e.kind, rhythmic: !!e.rhythmic,
        sessionId: importId, source: 'file', sourceName: imp.file.name, offsetSec: e.noiseSec, blob: encodeWav(samples, sampleRate),
        uid: uuid(), deviceId: dev.deviceId, deviceName: dev.deviceName, updatedAt: Date.now(),
      };
      rec.id = await dbAdd('events', rec); events.push(rec); saved++;
      setImpProgress(saved / list.length, `שומר קליפים… ${saved}/${list.length}`);
    };
    try {
      if (imp.client) {
        let chain = Promise.resolve();
        await imp.client.call('extract', { ranges: list.map((e, i) => ({ id: i, t0: e.startSec, t1: e.endSec })) }, { onClip: (m) => { chain = chain.then(() => saveOne(list[m.id], m.samples, m.sampleRate)); } });
        await chain;
      } else {
        for (const e of list) { const c = await extractOne(e.startSec, e.endSec); await saveOne(e, c.samples, c.sampleRate); }
      }
    } catch (e) {
      impError('השמירה נכשלה אחרי ' + saved + ' אירועים: ' + e.message); renderEvents(); refreshStorage(); return;
    }
    const skipped = imp.review.length - list.length;
    try { await dbPut('scans', { id: uuid(), type: 'file', importId, fileName: imp.file.name, fileSize: imp.file.size, fileLastModified: imp.file.lastModified || 0, startTs: startMs, endTs: Math.round(startMs + imp.durationSec * 1000), scannedAt: Date.now(), updatedAt: Date.now(), deviceId: dev.deviceId, deviceName: dev.deviceName, eventsSaved: saved, threshold: imp.threshold + 100 }); } catch (e) { /* ignore */ }
    log('ייבוא', `נשמרו ${saved} אירועים מהקובץ ${imp.file.name}${skipped ? ` (${skipped} הוסרו בסקירה)` : ''}. תחילת ההקלטה ${fmtDate(startMs)} ${fmtTime(startMs)} (${$('#impStartSrc').textContent.replace('מקור: ', '')}), סף ${imp.threshold + 100} (${imp.band === 'low' ? 'תדרים נמוכים' : 'כל התדרים'})`);
    $('#impProgress').hidden = true; $('#impSaveBtn').disabled = false;
    $('#impSaved').textContent = `נשמרו ${saved} אירועים. הם מופיעים ברשימת האירועים למטה, מסומנים "מקובץ".`;
    renderEvents(); refreshStorage(); renderFixUi();
  }

  // ---------- תיקון זמן של ייבוא שכבר נשמר ----------
  function importBatches() {
    const map = new Map();
    for (const e of events) {
      if (e.source !== 'file' || e.remote || !e.sessionId) continue;
      const b = map.get(e.sessionId) || { importId: e.sessionId, sourceName: e.sourceName, count: 0, start: Infinity, end: 0, events: [] };
      b.count++; b.events.push(e);
      const s = e.noiseTs - (e.offsetSec || 0) * 1000; if (s < b.start) b.start = s;
      if (e.endTs > b.end) b.end = e.endTs;
      map.set(e.sessionId, b);
    }
    return Array.from(map.values()).sort((a, b) => b.importId - a.importId);
  }
  function fixBatch() { const id = Number($('#fixImport').value); return importBatches().find((b) => b.importId === id) || null; }
  async function fixScanEntry(b) {
    let scans = []; try { scans = await dbGetAll('scans'); } catch (e) { scans = []; }
    return scans.find((x) => x.importId === b.importId) || scans.find((x) => x.type === 'file' && x.fileName === b.sourceName && Math.abs(x.startTs - b.start) < 2000) || null;
  }
  function renderFixUi() {
    const sel = $('#fixImport'); const batches = importBatches(); const prev = sel.value;
    sel.innerHTML = batches.length ? batches.map((b) => `<option value="${b.importId}">${escapeHtml(b.sourceName)} · ${b.count} אירועים · מתחיל ${fmtDate(b.start)} ${fmtTime(b.start)}</option>`).join('') : '<option value="">אין ייבואים שמורים במכשיר הזה</option>';
    if (batches.some((b) => String(b.importId) === prev)) sel.value = prev;
    $('#fixApplyBtn').disabled = !batches.length;
    const b = fixBatch();
    if (b && sel.value !== prev) setTimeInputs($('#fixDate'), $('#fixTime'), b.start);
    renderFixPreview();
  }
  let fixPreviewSeq = 0;
  async function renderFixPreview() {
    const b = fixBatch(); const el = $('#fixPreview');
    if (!b) { el.textContent = ''; return; }
    const t = readTimeInputs($('#fixDate'), $('#fixTime'));
    if (t === null) { el.textContent = 'הזן תאריך ושעה.'; return; }
    const seq = ++fixPreviewSeq;
    const scan = await fixScanEntry(b); const durMs = scan ? scan.endTs - scan.startTs : b.end - b.start;
    if (seq !== fixPreviewSeq) return; // תוצאה ישנה, כבר יש חדשה יותר
    const newStart = modeOf('fixMode') === 'end' ? t - durMs : t; const delta = newStart - b.start;
    el.textContent = delta ? `תזוזה ${fmtDelta(delta)}: ההקלטה תתחיל ב-${fmtDate(newStart)} ${fmtTime(newStart)}${scan ? ` ותסתיים ב-${fmtDate(newStart + durMs)} ${fmtTime(newStart + durMs)}` : ''}. ${b.count} אירועים יוזזו יחד.` : 'הזמן זהה לזמן הנוכחי, אין מה לתקן.';
  }
  async function applyFix() {
    const b = fixBatch(); if (!b) return;
    const t = readTimeInputs($('#fixDate'), $('#fixTime')); if (t === null) { alert('הזן תאריך ושעה.'); return; }
    const scan = await fixScanEntry(b); const durMs = scan ? scan.endTs - scan.startTs : b.end - b.start;
    const newStart = modeOf('fixMode') === 'end' ? t - durMs : t; const delta = newStart - b.start;
    if (!delta) { alert('הזמן זהה לזמן הנוכחי.'); return; }
    if (!confirm(`להזיז ${b.count} אירועים מהקובץ "${b.sourceName}" ב-${fmtDelta(delta)}?\nתחילת ההקלטה תהיה ${fmtDate(newStart)} ${fmtTime(newStart)}.`)) return;
    const now = Date.now();
    for (const e of b.events) {
      if (e.originalNoiseTs === undefined) e.originalNoiseTs = e.noiseTs;
      e.noiseTs += delta; e.startTs += delta; e.endTs += delta; e.timeCorrected = true; e.updatedAt = now;
      await dbPut('events', e);
    }
    if (scan) { scan.startTs += delta; scan.endTs += delta; scan.updatedAt = now; await dbPut('scans', scan); }
    log('תיקון זמן', `${b.count} אירועים מהקובץ ${b.sourceName} הוזזו ב-${fmtDelta(delta)}; תחילת ההקלטה עכשיו ${fmtDate(newStart)} ${fmtTime(newStart)}`);
    renderEvents(); renderFixUi(); renderDriveUi();
    $('#fixPreview').textContent = `התיקון הוחל על ${b.count} אירועים. ${b.events.some((e) => e.driveFileId) ? 'שמות הקבצים והאינדקס ב-Drive יתעדכנו בסנכרון הבא.' : ''}`;
  }
  function bindFixUi() {
    $('#fixImport').addEventListener('change', () => { const b = fixBatch(); if (b) setTimeInputs($('#fixDate'), $('#fixTime'), b.start); renderFixPreview(); });
    for (const id of ['fixDate', 'fixTime']) $('#' + id).addEventListener('change', renderFixPreview);
    $$('input[name="fixMode"]').forEach((r) => r.addEventListener('change', renderFixPreview));
    $('#fixApplyBtn').addEventListener('click', applyFix);
    $('#fixBox').addEventListener('toggle', () => { if ($('#fixBox').open) renderFixUi(); });
  }
  function bindImportUi() {
    $('#fileInput').addEventListener('change', () => onFileChosen($('#fileInput').files[0]));
    $('#impScanBtn').addEventListener('click', runImportScan);
    $('#impCancelBtn').addEventListener('click', cancelImportScan);
    $('#impThr').addEventListener('input', recountImport);
    $('#impReviewBtn').addEventListener('click', analyzeImport);
    $('#impSaveBtn').addEventListener('click', saveImport);
    for (const id of ['impDate', 'impTime']) $('#' + id).addEventListener('change', () => { if (imp) imp.startManual = true; $('#impStartSrc').textContent = 'מקור: הוזן ידנית'; onImportTimeChanged(); });
    $$('input[name="impMode"]').forEach((r) => r.addEventListener('change', () => { if (imp) imp.startManual = true; onImportTimeChanged(); }));
    bindFixUi();
    $('#impReviewList').addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-act="sel"]'); if (!cb || !imp || !imp.review) return;
      const li = cb.closest('li.rev'); const r = imp.review[Number(li.dataset.i)]; r.selected = cb.checked; li.classList.toggle('off', !cb.checked); updateReviewSummary();
    });
    $('#impReviewList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act="play"]'); if (!btn || !imp || !imp.review) return;
      const li = btn.closest('li.rev'); playReview(li, Number(li.dataset.i));
    });
    $('#impSelAll').addEventListener('click', () => { if (!imp || !imp.review) return; imp.review.forEach((r) => { r.selected = true; }); renderReview(); });
    $('#impSelNone').addEventListener('click', () => { if (!imp || !imp.review) return; imp.review.forEach((r) => { r.selected = false; }); renderReview(); });
    $('#impSelNoSpeech').addEventListener('click', () => { if (!imp || !imp.review) return; imp.review.forEach((r) => { if (r.kind === 'speech') r.selected = false; }); renderReview(); });
    $('#impSelNoBreath').addEventListener('click', () => { if (!imp || !imp.review) return; imp.review.forEach((r) => { if (r.kind === 'breath') r.selected = false; }); renderReview(); });
    $('#impSelShown').addEventListener('click', () => { if (!imp || !imp.review) return; for (const { r } of visibleReview()) r.selected = true; renderReview(); });
    $('#impClearShown').addEventListener('click', () => { if (!imp || !imp.review) return; for (const { r } of visibleReview()) r.selected = false; renderReview(); });
    $('#revKinds').addEventListener('click', (e) => { const b = e.target.closest('button[data-kind]'); if (!b || !imp || !imp.review) return; const k = b.dataset.kind; if (imp.filter.kinds.has(k)) imp.filter.kinds.delete(k); else imp.filter.kinds.add(k); renderReview(); });
    $('#revKindsAll').addEventListener('click', () => { if (!imp || !imp.review) return; for (const k of KIND_ORDER) imp.filter.kinds.add(k); renderReview(); });
    $('#revMinLevel').addEventListener('input', () => { if (!imp || !imp.review) return; imp.filter.minLevel = Number($('#revMinLevel').value); renderReview(); });
    $$('input[name="revSort"]').forEach((r) => r.addEventListener('change', () => { if (!imp || !imp.review) return; imp.filter.sort = modeOf('revSort'); renderReview(); }));
    $$('input[name="impBand"]').forEach((r) => r.addEventListener('change', applyImportBand));
    window.addEventListener('resize', () => { if (imp && imp.levels) drawTimeline(); });
  }

  // ---------- Google Drive: גיבוי, שיתוף בין מכשירים, יומן סריקות ----------
  const drive = window.DriveClient;
  let syncing = false;
  const driveCache = (() => { try { return JSON.parse(localStorage.getItem('noise-log-drive') || '{}'); } catch (e) { return {}; } })();
  function saveDriveCache() { try { localStorage.setItem('noise-log-drive', JSON.stringify(driveCache)); } catch (e) { /* ignore */ } }
  function clientId() { return settings.googleClientId || (window.NOISE_LOG_CONFIG && window.NOISE_LOG_CONFIG.googleClientId) || ''; }
  function driveConfigured() { return !!(drive && (clientId() || drive.state.testToken)); }
  function setDriveStatus(text, isErr) { const el = $('#driveStatus'); el.textContent = text; el.classList.toggle('error', !!isErr); }
  function renderDriveUi() {
    if (!drive) return;
    const on = drive.isConnected();
    $('#driveConnectBtn').hidden = on; $('#driveDisconnectBtn').hidden = !on;
    $('#driveSyncBtn').disabled = !on || syncing;
    $('#driveAccount').textContent = on ? `מחובר${drive.state.email ? ' כ-' + drive.state.email : ''}` : 'לא מחובר';
    const pending = events.filter((e) => !e.remote && !e.driveFileId && e.blob).length;
    $('#drivePending').textContent = on || driveConfigured() ? `${pending} אירועים ממתינים להעלאה${driveCache.lastSync ? ` · סנכרון אחרון ${fmtDate(driveCache.lastSync)} ${fmtTime(driveCache.lastSync)}` : ''}` : '';
  }
  async function driveConnect() {
    drive.configure({ clientId: clientId() });
    setDriveStatus('מתחבר…');
    try { await drive.signIn(true); await drive.getEmail(); setDriveStatus('מחובר. לחץ "סנכרן עכשיו" כדי להעלות ולהוריד.'); log('Drive', 'התחברות לחשבון גוגל' + (drive.state.email ? ' ' + drive.state.email : '')); }
    catch (e) { setDriveStatus('ההתחברות נכשלה: ' + e.message, true); }
    renderDriveUi();
  }
  function driveDisconnect() { drive.signOut(); setDriveStatus('התנתקת. הקבצים ב-Drive נשארים.'); renderDriveUi(); }
  async function driveRoot() {
    const name = settings.driveFolder || 'יומן רעש';
    if (driveCache.rootId && driveCache.rootName === name) {
      try { const m = await drive.getMeta(driveCache.rootId, 'id,trashed'); if (!m.trashed) return driveCache.rootId; } catch (e) { /* ניצור מחדש */ }
    }
    const id = await drive.ensureFolder(name, 'root');
    driveCache.rootId = id; driveCache.rootName = name; saveDriveCache();
    return id;
  }
  async function driveMonthFolder(rootId, mk, cache) {
    if (cache.has(mk)) return cache.get(mk);
    const y = await drive.ensureFolder(mk.slice(0, 4), rootId);
    const m = await drive.ensureFolder(mk, y);
    cache.set(mk, m); return m;
  }
  // יומן הסריקות: מיזוג בין המכשיר ל-Drive (לפי id), נשמר כ-scan-log.json בתיקיית השורש
  async function refreshScanLog(rootId) {
    rootId = rootId || (await driveRoot());
    const found = await drive.list(`name = 'scan-log.json' and '${rootId}' in parents and trashed = false`, 'files(id,name)');
    let remote = [];
    if (found.length) { try { remote = (await drive.getJson(found[0].id)).scans || []; } catch (e) { remote = []; } }
    const local = await dbGetAll('scans');
    const byId = new Map(remote.map((x) => [x.id, x]));
    let remoteChanged = !found.length && local.length > 0;
    for (const x of remote) { const l = local.find((y) => y.id === x.id); if (!l) await dbPut('scans', x); else if ((x.updatedAt || 0) > (l.updatedAt || 0)) await dbPut('scans', x); }
    for (const l of local) { const x = byId.get(l.id); if (!x) { byId.set(l.id, l); remoteChanged = true; } else if ((l.updatedAt || 0) > (x.updatedAt || 0)) { byId.set(l.id, l); remoteChanged = true; } }
    const merged = Array.from(byId.values()).sort((a, b) => a.scannedAt - b.scannedAt);
    if (remoteChanged) await drive.upload({ name: 'scan-log.json', mimeType: 'application/json', parents: found.length ? undefined : [rootId], appProperties: { noiseLogType: 'scanlog' } }, new Blob([JSON.stringify({ scans: merged }, null, 1)], { type: 'application/json' }), found.length ? found[0].id : undefined);
    return merged;
  }
  // בדיקה לפני סריקה: האם הקובץ או טווח הזמן כבר נסרקו (במכשיר הזה או באחר)?
  async function checkCoverage(startMs, endMs, file) {
    let scans = [];
    try { scans = await dbGetAll('scans'); } catch (e) { scans = []; }
    if (drive && drive.isConnected()) { try { scans = await refreshScanLog(); } catch (e) { log('אזהרה', 'לא ניתן לרענן את יומן הסריקות מ-Drive: ' + e.message); } }
    const exact = scans.filter((x) => x.type === 'file' && x.fileName === file.name && x.fileSize === file.size);
    const overlap = scans.filter((x) => !exact.includes(x) && x.startTs < endMs && x.endTs > startMs);
    if (!exact.length && !overlap.length) return true;
    const desc = (x) => `${x.type === 'live' ? 'ניטור חי' : 'הקובץ ' + x.fileName} (${x.deviceName || 'מכשיר לא ידוע'}): ${fmtDate(x.startTs)} ${fmtTime(x.startTs)} עד ${fmtDate(x.endTs)} ${fmtTime(x.endTs)}, נסרק ב-${fmtDate(x.scannedAt)} ${fmtTime(x.scannedAt)}, נשמרו ${x.eventsSaved} אירועים`;
    const lines = [];
    if (exact.length) lines.push(`הקובץ הזה כבר נסרק:`, ...exact.map((x) => '• ' + desc(x)));
    if (overlap.length) lines.push(`טווח הזמן ${fmtDate(startMs)} ${fmtTime(startMs)} עד ${fmtDate(endMs)} ${fmtTime(endMs)} חופף לסריקות קודמות:`, ...overlap.map((x) => '• ' + desc(x)));
    lines.push('', 'לסרוק בכל זאת? האירועים החדשים יתווספו לצד הקיימים.');
    return confirm(lines.join('\n'));
  }
  function driveClipName(e, dev) { return `${fmtStamp(e.noiseTs)}_${sanitizeName(e.deviceName || dev.deviceName) || 'device'}_${String(e.uid).slice(0, 6)}.wav`; }
  function indexEntryOf(e) {
    return { uid: e.uid, noiseTs: e.noiseTs, startTs: e.startTs, endTs: e.endTs, durationSec: e.durationSec, peakDb: e.peakDb, avgDb: e.avgDb, sampleRate: e.sampleRate, truncated: !!e.truncated,
      kind: e.kind || '', note: e.note || '', source: e.source || 'mic', sourceName: e.sourceName || '', offsetSec: e.offsetSec || 0,
      deviceId: e.deviceId || '', deviceName: e.deviceName || '', fileId: e.driveFileId || '', fileName: e.driveFileName || '', updatedAt: e.updatedAt || 0,
      timeCorrected: !!e.timeCorrected, originalNoiseTs: e.originalNoiseTs };
  }
  function indexCsv(list) {
    const head = ['תאריך', 'שעת תחילת הרעש', 'משך הקליפ (שניות)', 'רמת שיא', 'רמה ממוצעת', 'סיווג אוטומטי', 'הערה', 'מקור', 'היסט בהקלטה המקורית', 'מכשיר', 'קובץ ב-Drive'];
    const rows = list.map((x) => [fmtDate(x.noiseTs), fmtTimeMs(x.noiseTs), (x.durationSec || 0).toFixed(1), disp(x.peakDb).toFixed(1), disp(x.avgDb).toFixed(1), KIND_LABEL[x.kind] || '', x.note || '', x.source === 'file' ? x.sourceName : 'מיקרופון', x.source === 'file' ? fmtHms(x.offsetSec) : '', x.deviceName || '', x.fileName || '']);
    return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  async function syncDrive() {
    if (syncing || !drive) return;
    syncing = true; renderDriveUi();
    let uploaded = 0, added = 0, deleted = 0, removed = 0;
    try {
      drive.configure({ clientId: clientId() });
      if (!drive.isConnected()) { setDriveStatus('מתחבר…'); await drive.signIn(true); }
      await drive.getEmail();
      const dev = deviceInfo();
      const rootId = await driveRoot();
      setDriveStatus('מעדכן יומן סריקות…'); await refreshScanLog(rootId);
      // מצבות: מחיקות שהתבקשו גם ב-Drive
      const tombs = await dbGetAll('tombstones');
      for (const t of tombs) if (t.driveDelete && t.fileId && !t.done) { await drive.del(t.fileId); t.done = true; await dbPut('tombstones', t); deleted++; }
      const tombUids = new Set(tombs.map((t) => t.uid));
      // העלאת קליפים שטרם הועלו
      const folderCache = new Map();
      const pending = events.filter((e) => !e.remote && !e.driveFileId && e.blob);
      for (const e of pending) {
        setDriveStatus(`מעלה קליפ ${uploaded + 1}/${pending.length}…`);
        if (!e.uid) e.uid = uuid();
        e.deviceId = e.deviceId || dev.deviceId; e.deviceName = e.deviceName || dev.deviceName;
        const mId = await driveMonthFolder(rootId, monthKey(e.noiseTs), folderCache);
        const name = driveClipName(e, dev);
        const f = await drive.upload({ name, mimeType: 'audio/wav', parents: [mId], description: `רעש ${fmtDate(e.noiseTs)} ${fmtTime(e.noiseTs)}, ${KIND_LABEL[e.kind] || ''}, ממכשיר ${e.deviceName}`, appProperties: { noiseLogType: 'clip', uid: e.uid, deviceId: e.deviceId, deviceName: String(e.deviceName).slice(0, 60), noiseTs: String(e.noiseTs), kind: e.kind || '' } }, e.blob);
        e.driveFileId = f.id; e.driveFileName = name; e.driveMonth = monthKey(e.noiseTs); e.driveSyncedAt = Date.now(); e.updatedAt = e.updatedAt || Date.now();
        await dbPut('events', e); uploaded++;
      }
      // אירועים שהזמן שלהם תוקן אחרי ההעלאה: שינוי שם הקובץ, ומעבר תיקייה אם החודש השתנה
      let renamed = 0;
      for (const e of events) {
        if (e.remote || !e.driveFileId) continue;
        const name = driveClipName(e, dev), mk = monthKey(e.noiseTs);
        if (!e.driveMonth) { e.driveMonth = mk; await dbPut('events', e); }
        if (name === e.driveFileName && mk === e.driveMonth) continue;
        setDriveStatus(`מעדכן שם/תיקייה של קליפ (${renamed + 1})…`);
        if (mk !== e.driveMonth) {
          const meta = await drive.getMeta(e.driveFileId, 'id,parents');
          await drive.move(e.driveFileId, await driveMonthFolder(rootId, mk, folderCache), (meta.parents || [])[0], name);
        } else await drive.patchMeta(e.driveFileId, { name });
        e.driveFileName = name; e.driveMonth = mk; await dbPut('events', e); renamed++;
      }
      // מיזוג אינדקסים חודשיים (אחד לכל חודש, משותף לכל המכשירים)
      setDriveStatus('ממזג עם מכשירים אחרים…');
      const remoteIdx = await drive.list(`appProperties has { key='noiseLogType' and value='index' } and trashed = false`, 'files(id,name,appProperties)');
      const idxByMonth = new Map(remoteIdx.filter((f) => f.appProperties && f.appProperties.month).map((f) => [f.appProperties.month, f]));
      const months = new Set([...events.filter((e) => e.driveFileId).map((e) => monthKey(e.noiseTs)), ...idxByMonth.keys()]);
      for (const mk of months) {
        const idxFile = idxByMonth.get(mk);
        let entries = [];
        if (idxFile) { try { entries = (await drive.getJson(idxFile.id)).events || []; } catch (e) { entries = []; } }
        const byUid = new Map(entries.map((x) => [x.uid, x]));
        let changed = !idxFile;
        for (const e of events) {
          if (!e.driveFileId || monthKey(e.noiseTs) !== mk) continue;
          const cur = byUid.get(e.uid);
          if (!cur) { if (!e.remote) { byUid.set(e.uid, indexEntryOf(e)); changed = true; } }
          else if (!e.remote && (e.updatedAt || 0) > (cur.updatedAt || 0)) { byUid.set(e.uid, Object.assign({}, cur, indexEntryOf(e))); changed = true; }
          else if (e.remote && (cur.updatedAt || 0) > (e.updatedAt || 0)) {
            Object.assign(e, { note: cur.note || '', kind: cur.kind || e.kind, noiseTs: cur.noiseTs, startTs: cur.startTs, endTs: cur.endTs, driveFileName: cur.fileName || e.driveFileName, timeCorrected: !!cur.timeCorrected, originalNoiseTs: cur.originalNoiseTs, updatedAt: cur.updatedAt });
            await dbPut('events', e);
          }
        }
        // רשומות של אירועים מקומיים שעברו לחודש אחר (תיקון זמן) – מסירים מהאינדקס של החודש הישן
        for (const [uid, x] of Array.from(byUid.entries())) {
          const loc = events.find((e) => e.uid === uid && !e.remote);
          if (loc && monthKey(loc.noiseTs) !== mk) { byUid.delete(uid); changed = true; }
          else if (!loc && x.noiseTs && monthKey(x.noiseTs) !== mk) { byUid.delete(uid); changed = true; }
        }
        for (const t of tombs) if (t.driveDelete && byUid.has(t.uid)) { byUid.delete(t.uid); changed = true; }
        for (const x of byUid.values()) {
          if (!x.uid || tombUids.has(x.uid) || events.some((e) => e.uid === x.uid)) continue;
          const rec = Object.assign({}, x, { remote: true, driveFileId: x.fileId, driveFileName: x.fileName, driveMonth: mk, blob: null, note: x.note || '', sessionId: 0 });
          delete rec.fileId; delete rec.fileName;
          rec.id = await dbAdd('events', rec); events.push(rec); added++;
        }
        // אירועים שהגיעו מ-Drive ונמחקו שם על ידי מכשיר אחר – מוסרים גם כאן
        if (idxFile) {
          const gone = events.filter((e) => e.remote && monthKey(e.noiseTs) === mk && !byUid.has(e.uid));
          for (const e of gone) { await dbDelete('events', e.id); removed++; }
          if (gone.length) events = events.filter((e) => !gone.includes(e));
        }
        if (changed) {
          const list = Array.from(byUid.values()).sort((a, b) => a.noiseTs - b.noiseTs);
          const mId = await driveMonthFolder(rootId, mk, folderCache);
          await drive.upload({ name: `events-${mk}.json`, mimeType: 'application/json', parents: idxFile ? undefined : [mId], appProperties: { noiseLogType: 'index', month: mk } }, new Blob([JSON.stringify({ month: mk, events: list }, null, 1)], { type: 'application/json' }), idxFile ? idxFile.id : undefined);
          const csvFiles = await drive.list(`appProperties has { key='noiseLogType' and value='csv' } and appProperties has { key='month' and value='${mk}' } and trashed = false`, 'files(id)');
          await drive.upload({ name: `events-${mk}.csv`, mimeType: 'text/csv', parents: csvFiles.length ? undefined : [mId], appProperties: { noiseLogType: 'csv', month: mk } }, new Blob([indexCsv(list)], { type: 'text/csv' }), csvFiles.length ? csvFiles[0].id : undefined);
        }
      }
      driveCache.lastSync = Date.now(); saveDriveCache();
      setDriveStatus(`הסנכרון הסתיים: הועלו ${uploaded}, התקבלו ${added} ממכשירים אחרים${renamed ? `, עודכנו ${renamed} שמות` : ''}${deleted ? `, נמחקו מ-Drive ${deleted}` : ''}${removed ? `, הוסרו ${removed} שנמחקו במכשיר אחר` : ''}.`);
      log('Drive', `סנכרון: הועלו ${uploaded}, התקבלו ${added}${deleted ? `, נמחקו ${deleted}` : ''} (תיקייה "${settings.driveFolder}")`);
      renderEvents(); refreshStorage();
    } catch (e) {
      setDriveStatus('הסנכרון נכשל: ' + e.message, true);
      log('שגיאה', 'Drive: ' + e.message + (uploaded ? ` (אחרי ${uploaded} העלאות)` : ''));
      renderEvents();
    } finally { syncing = false; renderDriveUi(); }
  }
  function bindDriveUi() {
    const dev = deviceInfo();
    $('#deviceName').value = dev.deviceName; $('#driveFolder').value = settings.driveFolder; $('#googleClientId').value = settings.googleClientId || '';
    $('#deviceName').addEventListener('change', () => { settings.deviceName = $('#deviceName').value.trim() || defaultDeviceName(); $('#deviceName').value = settings.deviceName; saveSettings(); });
    $('#driveFolder').addEventListener('change', () => { settings.driveFolder = $('#driveFolder').value.trim() || 'יומן רעש'; $('#driveFolder').value = settings.driveFolder; saveSettings(); renderDriveUi(); });
    $('#googleClientId').addEventListener('change', () => { settings.googleClientId = $('#googleClientId').value.trim(); saveSettings(); renderDriveUi(); renderEvents(); });
    $('#driveConnectBtn').addEventListener('click', driveConnect);
    $('#driveDisconnectBtn').addEventListener('click', driveDisconnect);
    $('#driveSyncBtn').addEventListener('click', syncDrive);
    if (drive) { drive.configure({ clientId: clientId() }); if (drive.restore()) setDriveStatus('מחובר מהפעם הקודמת.'); }
    renderDriveUi();
  }

  // ---------- חיבור UI ----------
  function bindUi() {
    syncSettingsUi();
    bindImportUi();
    bindDriveUi();
    $('#startBtn').addEventListener('click', startMonitoring);
    $('#stopBtn').addEventListener('click', () => stopMonitoring(false));
    $('#nightBtn').addEventListener('click', showNight);
    $('#night').addEventListener('click', hideNight);
    $('#calibrateBtn').addEventListener('click', autoCalibrate);
    $('#threshold').addEventListener('input', () => { settings.threshold = Number($('#threshold').value); $('#thresholdVal').textContent = settings.threshold; $('#meterThr').style.right = `${100 - settings.threshold}%`; saveSettings(); });
    for (const k of ['pre', 'tail', 'maxClip']) {
      $('#' + k).addEventListener('change', () => { const v = Number($('#' + k).value); if (Number.isFinite(v) && v >= 0) { settings[k] = v; saveSettings(); if (imp && imp.levels) recountImport(); } });
    }
    $('#sampleRate').addEventListener('change', () => { settings.sampleRate = Number($('#sampleRate').value); saveSettings(); if (monitoring) log('מידע', 'קצב הדגימה ישתנה בניטור הבא'); });
    $('#skipSpeech').addEventListener('change', () => { settings.skipSpeech = $('#skipSpeech').checked; saveSettings(); });
    $('#skipBreath').addEventListener('change', () => { settings.skipBreath = $('#skipBreath').checked; saveSettings(); });
    $('#lowBand').addEventListener('change', () => { settings.detectBand = $('#lowBand').checked ? 'low' : 'full'; saveSettings(); if (monitoring) log('מידע', `זיהוי לפי ${settings.detectBand === 'low' ? 'תדרים נמוכים בלבד' : 'כל התדרים'} מעכשיו`); });
    $('#keepAwake').addEventListener('change', () => { settings.keepAwake = $('#keepAwake').checked; saveSettings(); if (settings.keepAwake && monitoring) acquireWakeLock(); else if (wakeLock) { wakeLock.release(); } });
    $('#nightFilter').addEventListener('change', () => { currentFilter = $('#nightFilter').value; renderEvents(); });
    $('#bulkDelete').addEventListener('click', async () => {
      const ids = Array.from(selectedIds); if (!ids.length) return;
      if (!confirm(`למחוק ${ids.length} אירועים מסומנים? הפעולה אינה הפיכה.`)) return;
      const sel = events.filter((x) => selectedIds.has(x.id));
      const synced = sel.filter((x) => x.driveFileId && !x.remote).length;
      const alsoDrive = synced ? confirm(`${synced} מהם הועלו ל-Drive. למחוק אותם גם מ-Drive? "ביטול" = רק מהמכשיר הזה.`) : false;
      for (const ev of sel) await deleteEvent(ev, alsoDrive);
      selectedIds.clear();
      log('מידע', `${ids.length} אירועים הוסרו בסקירה ידנית (לא רלוונטיים)`);
      renderEvents(); refreshStorage();
    });
    $('#bulkShown').addEventListener('click', () => { for (const e of filteredEvents()) selectedIds.add(e.id); renderEvents(); });
    $('#kindFilter').addEventListener('click', (e) => { const b = e.target.closest('button[data-kind]'); if (!b) return; const k = b.dataset.kind; if (kindFilter.has(k)) kindFilter.delete(k); else kindFilter.add(k); renderEvents(); });
    $('#kindAll').addEventListener('click', () => { for (const k of KIND_ORDER) kindFilter.add(k); renderEvents(); });
    $('#eventSort').addEventListener('change', () => { eventSort = $('#eventSort').value; renderEvents(); });
    $('#bulkClear').addEventListener('click', () => { selectedIds.clear(); renderEvents(); });
    $('#csvBtn').addEventListener('click', exportCsv);
    $('#zipBtn').addEventListener('click', exportZip);
    $('#clearBtn').addEventListener('click', async () => {
      if (!confirm('למחוק את כל האירועים והיומן מהמכשיר? פעולה זו אינה הפיכה. ודא שייצאת ZIP קודם.')) return;
      await dbClear('events'); await dbClear('log'); await dbClear('scans');
      events = []; logLines.length = 0;
      renderEvents(); renderLog(); refreshStorage();
    });
    $$('details.help').forEach((d) => d.addEventListener('toggle', () => { /* no-op */ }));
    window.addEventListener('beforeunload', (e) => { if (monitoring) { e.preventDefault(); e.returnValue = ''; } });
  }

  async function init() {
    bindUi();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('הדפדפן לא תומך בהקלטה, או שהדף לא נטען מ-HTTPS', 'err');
      $('#startBtn').disabled = true;
    } else {
      setStatus('לא מנטר', 'off');
    }
    try {
      events = await dbGetAll('events');
      const dev = deviceInfo();
      for (const e of events) if (!e.uid) { e.uid = uuid(); e.deviceId = e.deviceId || dev.deviceId; e.deviceName = e.deviceName || dev.deviceName; e.updatedAt = e.updatedAt || e.noiseTs; await dbPut('events', e); }
      const oldLog = await dbGetAll('log');
      logLines.push(...oldLog.slice(-200));
    } catch (e) { setStatus('שגיאה בפתיחת האחסון המקומי: ' + e.message, 'err'); }
    renderEvents(); renderLog(); refreshStorage(); updateButtons(); renderDriveUi();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // חשיפה לבדיקות אוטומטיות
  window.__noiseLog = { get events() { return events; }, get monitoring() { return monitoring; }, get importState() { return imp; }, settings, eventsCsv, makeZip, dbGetAll, Detector, disp, syncDrive, drive, get syncing() { return syncing; }, importBatches };

  init();
})();
