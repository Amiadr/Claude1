/* יומן רעש לילי – ניטור מיקרופון, זיהוי אירועי רעש, שמירת קליפים עם חותמת זמן.
   כל הנתונים נשמרים מקומית בדפדפן (IndexedDB). אין שרת, אין העלאה לענן. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ---------- הגדרות ----------
  const DEFAULTS = { threshold: 55, pre: 3, tail: 3, maxClip: 120, sampleRate: 16000, keepAwake: true };
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
  const DB_NAME = 'noise-log', DB_VER = 1;
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        const ev = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        ev.createIndex('startTs', 'startTs');
        const lg = db.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
        lg.createIndex('ts', 'ts');
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
  function fmtDur(sec) { return sec >= 60 ? `${Math.floor(sec / 60)}:${pad(Math.round(sec % 60))} דק׳` : `${sec.toFixed(1)} שנ׳`; }
  // "לילה" = מ-12:00 בצהריים עד 12:00 למחרת, כדי שאירועים אחרי חצות ישויכו לאותו לילה
  function nightKey(ts) { return fmtDateIso(ts - 12 * 3600 * 1000); }
  function nightLabel(key) { const d = new Date(key + 'T12:00:00'); const n = new Date(d.getTime() + 86400000); return `לילה ${pad(d.getDate())}–${pad(n.getDate())}.${pad(n.getMonth() + 1)}.${n.getFullYear()}`; }
  // תצוגת רמה: dBFS + 100 (סולם יחסי, לא מכויל ל-dB(A))
  const disp = (dbfs) => Math.max(0, dbfs + 100);
  const fileName = (e) => `${fmtStamp(e.noiseTs)}_ev${e.id}.wav`;

  // ---------- זיהוי אירועים ----------
  class Detector {
    constructor(sampleRate, s, onEvent) {
      this.sr = sampleRate; this.s = s; this.onEvent = onEvent;
      this.recent = []; this.recentSamples = 0; // pre-roll buffer
      this.active = null;
      this.lastDb = -100;
    }
    push(samples, wall) {
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) { const v = samples[i]; sumSq += v * v; }
      const rms = Math.sqrt(sumSq / samples.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
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
    const head = ['#', 'תאריך', 'שעת תחילת הרעש', 'תחילת הקליפ', 'סיום הקליפ', 'משך הקליפ (שניות)', 'רמת שיא', 'רמה ממוצעת', 'קליפ קטוע', 'הערה', 'קובץ'];
    const rows = list.slice().sort((a, b) => a.noiseTs - b.noiseTs).map((e) => [
      e.id, fmtDate(e.noiseTs), fmtTimeMs(e.noiseTs), fmtTime(e.startTs), fmtTime(e.endTs),
      e.durationSec.toFixed(1), disp(e.peakDb).toFixed(1), disp(e.avgDb).toFixed(1), e.truncated ? 'כן' : '', e.note || '', fileName(e)]);
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
  let lastChunkAt = 0, sessionId = null, sessionEvents = 0, wakeLockWarned = false;
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
    monitoring = true; sessionId = Date.now(); sessionEvents = 0; lastChunkAt = Date.now(); wakeLockWarned = false;
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
    log('סיום', `ניטור הופסק${fromError ? ' (בגלל תקלה)' : ''}. אירועים במפגש זה: ${sessionEvents}`);
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
    const rec = {
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
    const samplesDb = [];
    const start = Date.now();
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (detector) samplesDb.push(disp(detector.lastDb));
        const left = 5 - Math.floor((Date.now() - start) / 1000);
        btn.textContent = `מודד שקט… ${Math.max(0, left)}`;
        if (Date.now() - start >= 5000) { clearInterval(iv); resolve(); }
      }, 100);
    });
    btn.disabled = false; btn.textContent = 'כיול אוטומטי (5 שנ׳ שקט)';
    if (!samplesDb.length) return;
    samplesDb.sort((a, b) => a - b);
    const floor = samplesDb[Math.floor(samplesDb.length * 0.9)]; // כמעט הרמה הגבוהה ביותר בשקט
    settings.threshold = Math.min(99, Math.round(floor + 12));
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
    $('#sampleRate').value = String(settings.sampleRate); $('#keepAwake').checked = settings.keepAwake;
  }

  let currentFilter = 'all';
  function filteredEvents() {
    return events.filter((e) => currentFilter === 'all' || nightKey(e.noiseTs) === currentFilter);
  }
  function renderNightFilter() {
    const sel = $('#nightFilter');
    const keys = Array.from(new Set(events.map((e) => nightKey(e.noiseTs)))).sort().reverse();
    const prev = sel.value || 'all';
    sel.innerHTML = '<option value="all">כל הלילות</option>' + keys.map((k) => `<option value="${k}">${nightLabel(k)}</option>`).join('');
    sel.value = keys.includes(prev) ? prev : 'all';
    currentFilter = sel.value;
  }
  function renderEvents() {
    renderNightFilter();
    const list = filteredEvents().slice().sort((a, b) => b.noiseTs - a.noiseTs);
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
          <div class="ev-time"><span class="ltr">${fmtTime(e.noiseTs)}</span><small class="ltr">${fmtDate(e.noiseTs)}</small></div>
          <div class="ev-meta">
            <span title="רמת שיא (סולם יחסי)">שיא <b>${disp(e.peakDb).toFixed(0)}</b></span>
            <span title="אורך הקליפ כולל השניות שלפני ואחרי">${fmtDur(e.durationSec)}</span>
            ${e.truncated ? '<span class="tag">קטוע</span>' : ''}
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
  function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  $('#events').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const li = btn.closest('li.event'); const id = Number(li.dataset.id);
    const ev = events.find((x) => x.id === id); if (!ev) return;
    if (btn.dataset.act === 'play') {
      const p = li.querySelector('.player');
      if (!p.hidden) { p.hidden = true; p.innerHTML = ''; return; }
      const a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(ev.blob);
      p.innerHTML = ''; p.appendChild(a); p.hidden = false; a.play().catch(() => {});
    } else if (btn.dataset.act === 'download') {
      downloadBlob(ev.blob, fileName(ev));
    } else if (btn.dataset.act === 'delete') {
      if (!confirm(`למחוק את האירוע מ-${fmtTime(ev.noiseTs)} ${fmtDate(ev.noiseTs)}?`)) return;
      await dbDelete('events', id);
      events = events.filter((x) => x.id !== id);
      log('מידע', `אירוע ${id} נמחק ידנית`);
      renderEvents(); refreshStorage();
    }
  });
  $('#events').addEventListener('change', async (e) => {
    const inp = e.target.closest('input[data-act="note"]'); if (!inp) return;
    const id = Number(inp.closest('li.event').dataset.id);
    const ev = events.find((x) => x.id === id); if (!ev) return;
    ev.note = inp.value.trim();
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
      for (const e of list.slice().sort((a, b) => a.noiseTs - b.noiseTs)) files.push({ name: 'clips/' + fileName(e), data: e.blob, date: new Date(e.noiseTs) });
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

  // ---------- חיבור UI ----------
  function bindUi() {
    syncSettingsUi();
    $('#startBtn').addEventListener('click', startMonitoring);
    $('#stopBtn').addEventListener('click', () => stopMonitoring(false));
    $('#nightBtn').addEventListener('click', showNight);
    $('#night').addEventListener('click', hideNight);
    $('#calibrateBtn').addEventListener('click', autoCalibrate);
    $('#threshold').addEventListener('input', () => { settings.threshold = Number($('#threshold').value); $('#thresholdVal').textContent = settings.threshold; $('#meterThr').style.right = `${100 - settings.threshold}%`; saveSettings(); });
    for (const k of ['pre', 'tail', 'maxClip']) {
      $('#' + k).addEventListener('change', () => { const v = Number($('#' + k).value); if (Number.isFinite(v) && v >= 0) { settings[k] = v; saveSettings(); } });
    }
    $('#sampleRate').addEventListener('change', () => { settings.sampleRate = Number($('#sampleRate').value); saveSettings(); if (monitoring) log('מידע', 'קצב הדגימה ישתנה בניטור הבא'); });
    $('#keepAwake').addEventListener('change', () => { settings.keepAwake = $('#keepAwake').checked; saveSettings(); if (settings.keepAwake && monitoring) acquireWakeLock(); else if (wakeLock) { wakeLock.release(); } });
    $('#nightFilter').addEventListener('change', () => { currentFilter = $('#nightFilter').value; renderEvents(); });
    $('#csvBtn').addEventListener('click', exportCsv);
    $('#zipBtn').addEventListener('click', exportZip);
    $('#clearBtn').addEventListener('click', async () => {
      if (!confirm('למחוק את כל האירועים והיומן מהמכשיר? פעולה זו אינה הפיכה. ודא שייצאת ZIP קודם.')) return;
      await dbClear('events'); await dbClear('log');
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
      const oldLog = await dbGetAll('log');
      logLines.push(...oldLog.slice(-200));
    } catch (e) { setStatus('שגיאה בפתיחת האחסון המקומי: ' + e.message, 'err'); }
    renderEvents(); renderLog(); refreshStorage(); updateButtons();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // חשיפה לבדיקות אוטומטיות
  window.__noiseLog = { get events() { return events; }, get monitoring() { return monitoring; }, settings, eventsCsv, makeZip, dbGetAll, Detector, disp };

  init();
})();
