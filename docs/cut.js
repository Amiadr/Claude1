/* cut.js – חיתוך הקלטה ארוכה לחלקים קטנים, בדפדפן, בלי להעלות כלום.
   קורא WAV/MP3/M4A בזרימה (scan.js), חותך טווח או מפצל לחלקים, וכותב WAV מונו 16 ביט.
   כל חלק שומר על הזמן המקורי שלו: שם הקובץ מתחיל בתאריך ובשעה של תחילת החלק, וגם קטע ICRD בתוך ה-WAV,
   כך שהייבוא באפליקציה (ובכל כלי אחר) יודע מתי החלק התחיל. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const fmtDate = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
  const fmtTime = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const fmtHms = (sec) => { sec = Math.max(0, Math.round(sec || 0)); return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`; };
  const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + ' MB' : Math.round(b / 1024) + ' KB');
  const stamp = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));
  const disp = (db) => db + 100;

  const st = { file: null, scanner: null, info: null, startMs: null, startManual: false, levels: null, floorDb: null, events: [], sel: null, pieces: [], busy: false };

  function setError(msg) { const el = $('#cutError'); el.hidden = !msg; el.textContent = msg || ''; }
  function setProgress(f, text) { $('#cutProgress').hidden = false; $('#cutBar').style.width = `${Math.round(f * 100)}%`; $('#cutProgText').textContent = `${text} ${Math.round(f * 100)}%`; }
  function hideProgress() { $('#cutProgress').hidden = true; }
  function durationSec() { return (st.info && st.info.durationSec) || 0; }

  // ---------- זמן ההקלטה ----------
  function readTimeInputs(dateEl, timeEl) { if (!dateEl.value || !timeEl.value) return null; const t = timeEl.value.length === 5 ? timeEl.value + ':00' : timeEl.value; const d = new Date(`${dateEl.value}T${t}`); return isNaN(d) ? null : d.getTime(); }
  function setTimeInputs(dateEl, timeEl, ms) { const d = new Date(ms); dateEl.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; timeEl.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function modeOf(name) { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : 'start'; }
  function currentStartMs() {
    const t = readTimeInputs($('#cutDate'), $('#cutTime')); if (t === null) return null;
    if (modeOf('cutMode') === 'end') { const dur = durationSec(); return dur ? Math.round(t - dur * 1000) : null; }
    return t;
  }
  function onTimeChanged() {
    st.startMs = currentStartMs();
    const dur = durationSec(), el = $('#cutRange');
    if (st.startMs === null) el.textContent = 'הזן תאריך ושעה.';
    else el.textContent = `ההקלטה: ${fmtDate(st.startMs)} ${fmtTime(st.startMs)} עד ${fmtDate(st.startMs + dur * 1000)} ${fmtTime(st.startMs + dur * 1000)} (אורך ${fmtHms(dur)})`;
    renderSelection(); renderPieces(); drawTimeline();
  }
  function renderStartCandidates() {
    const cands = NoiseScan.startCandidates(st.file, st.info || {});
    const box = $('#cutCandidates'); box.innerHTML = '';
    if (cands.length) { setTimeInputs($('#cutDate'), $('#cutTime'), cands[0].time); $('#cutModeStart').checked = true; $('#cutStartSrc').textContent = 'מקור: ' + cands[0].source; }
    else { $('#cutDate').value = ''; $('#cutTime').value = ''; $('#cutStartSrc').textContent = 'לא נמצא זמן בקובץ, הזן ידנית'; }
    for (const c of cands) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
      b.innerHTML = `<span class="ltr">${fmtDate(c.time)} ${fmtTime(c.time)}</span> · ${escapeHtml(c.source)}`;
      b.addEventListener('click', () => { setTimeInputs($('#cutDate'), $('#cutTime'), c.time); $('#cutModeStart').checked = true; $('#cutStartSrc').textContent = 'מקור: ' + c.source; onTimeChanged(); });
      box.appendChild(b);
    }
    onTimeChanged();
  }

  // ---------- פתיחת קובץ ----------
  async function openFile(file) {
    setError(''); hideProgress(); st.file = file; st.scanner = null; st.info = null; st.levels = null; st.events = []; st.sel = null; st.pieces = [];
    $('#cutInfo').hidden = true; $('#cutWork').hidden = true;
    try {
      const s = await NoiseScan.open(file);
      if (!s.info || !s.info.supported) { setError(s.info && s.info.reason ? s.info.reason : 'פורמט לא נתמך לחיתוך. המר ל-WAV/MP3/M4A.'); return; }
      if (s.checkSupport) { await s.checkSupport(); if (!s.info.supported) { setError(s.info.reason || 'הדפדפן לא יודע לפענח את הקובץ'); return; } }
      st.scanner = s; st.info = s.info;
    } catch (e) { setError('פתיחת הקובץ נכשלה: ' + e.message); return; }
    $('#cutName').textContent = file.name;
    $('#cutFormat').textContent = [String(st.info.format || '').toUpperCase(), st.info.codec, st.info.sampleRate ? st.info.sampleRate + ' Hz' : '', fmtBytes(file.size)].filter(Boolean).join(' · ');
    $('#cutDuration').textContent = st.info.durationSec ? (st.info.durationEstimated ? '~' : '') + fmtHms(st.info.durationSec) : 'לא ידוע';
    $('#cutPrefix').value = file.name.replace(/\.[^.]+$/, '').replace(/(20\d{2})[-_.]?\d{2}[-_.]?\d{2}[ _T-]?\d{2}[-_.:h]?\d{2}(?:[-_.:m]?\d{2})?/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'cut';
    $('#cutRateOrig').textContent = `מקורי (${st.info.sampleRate} Hz, קובץ גדול)`;
    $('#cutInfo').hidden = false; $('#cutWork').hidden = false;
    renderStartCandidates(); renderPieces(); drawTimeline();
  }

  // ---------- סריקה (ציר זמן ואירועים; לא חובה לחיתוך) ----------
  async function scan() {
    if (!st.scanner || st.busy) return; st.busy = true; setError('');
    const btn = $('#cutScanBtn'); btn.disabled = true;
    try {
      const r = await st.scanner.scanLevels((f) => setProgress(f, 'סורק…'));
      if (!r) return;
      st.levels = r.levels; st.floorDb = r.floorDb; if (r.durationSec) st.info.durationSec = r.durationSec;
      st.events = NoiseScan.detectFromLevels(r.levels, { threshold: r.floorDb + 8, pre: 3, tail: 3, maxClip: 120 });
      $('#cutDuration').textContent = fmtHms(st.info.durationSec);
      $('#cutScanInfo').textContent = `רמת רקע ${disp(r.floorDb).toFixed(0)}, ${st.events.length} אירועים מעל רקע + 8. חלקים בלי אירועים אפשר לדלג עליהם.`;
      onTimeChanged();
    } catch (e) { setError('הסריקה נכשלה: ' + e.message); }
    finally { hideProgress(); btn.disabled = false; st.busy = false; }
  }

  // ---------- ציר זמן ----------
  function drawTimeline() {
    const c = $('#cutTimeline'); if (!c || !st.info) return;
    const W = c.clientWidth || 600, H = 96, dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); const g = c.getContext('2d'); g.scale(dpr, dpr);
    g.fillStyle = '#0b1220'; g.fillRect(0, 0, W, H);
    const dur = durationSec() || 1, x = (t) => (t / dur) * W;
    if (st.levels) {
      const lv = st.levels, per = lv.length / W, base = st.floorDb - 5;
      g.fillStyle = '#38bdf8';
      for (let px = 0; px < W; px++) { let mx = -200; for (let i = Math.floor(px * per), e = Math.max(i + 1, Math.floor((px + 1) * per)); i < e && i < lv.length; i++) if (lv[i] > mx) mx = lv[i]; const h = Math.max(0, Math.min(1, (mx - base) / 45)) * (H - 22); g.fillRect(px, H - 20 - h, 1, h); }
      g.fillStyle = 'rgba(245,158,11,.9)'; for (const e of st.events) g.fillRect(x(e.noiseSec) - 1, 0, 2, 6);
    } else { g.fillStyle = '#334155'; g.fillRect(0, H / 2 - 1, W, 2); }
    // פיצול: גבולות חלקים
    if (modeOf('cutKind') === 'split') { g.strokeStyle = 'rgba(148,163,184,.5)'; g.setLineDash([2, 3]); for (const p of st.pieces) { g.beginPath(); g.moveTo(x(p.t0), 0); g.lineTo(x(p.t0), H - 20); g.stroke(); } g.setLineDash([]); }
    // בחירה ידנית
    if (st.sel) { g.fillStyle = 'rgba(56,189,248,.25)'; g.fillRect(x(st.sel.t0), 0, Math.max(2, x(st.sel.t1) - x(st.sel.t0)), H - 20); g.fillStyle = '#e2e8f0'; g.fillRect(x(st.sel.t0) - 1, 0, 2, H - 20); g.fillRect(x(st.sel.t1) - 1, 0, 2, H - 20); }
    // ציר שעות
    g.fillStyle = '#94a3b8'; g.font = '11px system-ui'; g.textAlign = 'center';
    const stepSec = dur > 6 * 3600 ? 3600 : dur > 3600 ? 1800 : dur > 600 ? 300 : 60;
    for (let t = 0; t <= dur; t += stepSec) { const label = st.startMs !== null ? fmtTime(st.startMs + t * 1000).slice(0, 5) : fmtHms(t); g.fillText(label, Math.min(W - 16, Math.max(16, x(t))), H - 6); }
  }

  // ---------- חיתוך ידני ----------
  // שעה על השעון → היסט בהקלטה: על התאריך של תחילת ההקלטה, ואם זה לפני ההתחלה, למחרת (חציית חצות)
  function clockToOffset(timeStr) {
    if (st.startMs === null || !timeStr) return null;
    const t = timeStr.length === 5 ? timeStr + ':00' : timeStr; const d0 = new Date(st.startMs);
    let d = new Date(`${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}T${t}`); if (isNaN(d)) return null;
    if (d.getTime() < st.startMs - 1000) d = new Date(d.getTime() + 86400000);
    return Math.max(0, Math.min(durationSec(), (d.getTime() - st.startMs) / 1000));
  }
  function readSelection() {
    const a = clockToOffset($('#cutFrom').value), b = clockToOffset($('#cutTo').value);
    st.sel = a !== null && b !== null && b > a ? { t0: a, t1: b } : null;
  }
  function renderSelection() {
    readSelection(); const el = $('#cutSelInfo'); const rate = Number($('#cutRate').value) || st.info.sampleRate;
    if (!st.sel) { el.textContent = st.startMs === null ? 'הזן קודם את זמן ההקלטה.' : 'הזן שעת התחלה וסיום של החלק (שעון), או לחץ על ציר הזמן: לחיצה ראשונה = התחלה, שנייה = סיום.'; $('#cutGoBtn').disabled = true; return; }
    const len = st.sel.t1 - st.sel.t0;
    el.textContent = `החלק: ${fmtTime(st.startMs + st.sel.t0 * 1000)} עד ${fmtTime(st.startMs + st.sel.t1 * 1000)} (${fmtHms(len)}, היסט ${fmtHms(st.sel.t0)} בהקלטה) ≈ ${fmtBytes(len * rate * 2)} כ-WAV`;
    $('#cutGoBtn').disabled = false; drawTimeline();
  }
  function timelineClick(e) {
    if (!st.info || st.startMs === null || modeOf('cutKind') !== 'manual') return;
    const rect = $('#cutTimeline').getBoundingClientRect(); const t = Math.round(Math.max(0, Math.min(durationSec(), ((e.clientX - rect.left) / rect.width) * durationSec()))); // לשנייה שלמה
    const clock = fmtTime(st.startMs + t * 1000);
    const from = $('#cutFrom').value, to = $('#cutTo').value;
    if (!from || to) { $('#cutFrom').value = clock; $('#cutTo').value = ''; } // לחיצה ראשונה (או התחלה מחדש): התחלה
    else if (t > clockToOffset(from)) $('#cutTo').value = clock;             // לחיצה שנייה: סיום
    else { $('#cutTo').value = from; $('#cutFrom').value = clock; }           // לחיצה שנייה לפני ההתחלה: מחליפים
    renderSelection();
  }

  // ---------- פיצול לחלקים ----------
  function computePieces() {
    const dur = durationSec(); const len = Math.max(0.1, Number($("#cutPieceMin").value) || 30) * 60; const only = $('#cutOnlyEvents').checked && st.levels;
    st.pieces = [];
    for (let t0 = 0, i = 1; t0 < dur; t0 += len, i++) {
      const t1 = Math.min(dur, t0 + len); const n = st.events.filter((e) => e.noiseSec >= t0 && e.noiseSec < t1).length;
      const keep = !only || n > 0;
      st.pieces.push({ i, t0, t1, events: st.levels ? n : null, selected: keep });
    }
  }
  function renderPieces() {
    if (!st.info) return; computePieces();
    const rate = Number($('#cutRate').value) || st.info.sampleRate; const ul = $('#cutPieces'); ul.innerHTML = '';
    for (const p of st.pieces) {
      const li = document.createElement('li'); li.className = 'piece' + (p.selected ? '' : ' off'); li.dataset.i = p.i;
      const when = st.startMs !== null ? `<span class="ltr">${fmtTime(st.startMs + p.t0 * 1000)}–${fmtTime(st.startMs + p.t1 * 1000)}</span>` : `<span class="ltr">${fmtHms(p.t0)}–${fmtHms(p.t1)}</span>`;
      li.innerHTML = `<label><input type="checkbox" data-act="sel" ${p.selected ? 'checked' : ''}> <b>${p.i}</b> ${when} <span class="muted">${fmtHms(p.t1 - p.t0)} · ${fmtBytes((p.t1 - p.t0) * rate * 2)}${p.events === null ? '' : ` · ${p.events} אירועים`}</span></label><button class="btn small" data-act="dl" title="חתוך והורד את החלק הזה">⬇</button>`;
      ul.appendChild(li);
    }
    const sel = st.pieces.filter((p) => p.selected).length;
    $('#cutPiecesInfo').textContent = `${st.pieces.length} חלקים, ${sel} מסומנים להורדה${$('#cutOnlyEvents').checked && !st.levels ? ' (סרוק את הקובץ כדי לדלג על חלקים בלי אירועים)' : ''}`;
    $('#cutAllBtn').disabled = !sel; drawTimeline();
  }

  // ---------- החיתוך עצמו: חילוץ בקטעים של 20 שניות, המרה בזרימה, WAV עם ICRD ----------
  async function cutRange(t0, t1, onProgress) {
    const sr = st.scanner.outRate || st.info.sampleRate; const outRate = Number($('#cutRate').value) || sr;
    const rs = new NoiseScan.Resampler(sr, outRate);
    const total = Math.round((t1 - t0) * outRate); const pcm = new Int16Array(total); let w = 0;
    const CH = 20;
    for (let a = t0; a < t1 && w < total; a += CH) {
      const b = Math.min(t1, a + CH);
      const y = rs.process(await st.scanner.extract(a, b));
      for (let i = 0; i < y.length && w < total; i++, w++) { const v = Math.max(-1, Math.min(1, y[i])); pcm[w] = v < 0 ? v * 32768 : v * 32767; }
      onProgress((b - t0) / (t1 - t0)); await yieldNow();
    }
    return { blob: NoiseScan.encodeWav(pcm.subarray(0, w), outRate, { icrd: st.startMs + t0 * 1000 }), rate: outRate, seconds: w / outRate };
  }
  function pieceName(t0) { return `${stamp(st.startMs + t0 * 1000)}_${$('#cutPrefix').value.trim() || 'cut'}.wav`; }
  function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); }
  async function cutAndDownload(t0, t1, label, idx, count) {
    const name = pieceName(t0);
    const r = await cutRange(t0, t1, (f) => setProgress(f, `חותך ${label}${count > 1 ? ` (${idx}/${count})` : ''}…`));
    downloadBlob(r.blob, name);
    const done = $('#cutDone'); const ph = done.querySelector('li.muted'); if (ph) ph.remove();
    const li = document.createElement('li'); li.innerHTML = `<span class="ltr">${escapeHtml(name)}</span> · ${fmtHms(r.seconds)} · ${r.rate} Hz · ${fmtBytes(r.blob.size)}`; done.prepend(li);
    return r;
  }
  async function runCuts(ranges) {
    if (st.busy) return; if (st.startMs === null) { setError('הזן את זמן ההקלטה לפני החיתוך, כדי שהחלקים יישאו את הזמן המקורי.'); return; }
    st.busy = true; setError(''); const btns = ['#cutGoBtn', '#cutAllBtn', '#cutScanBtn'].map((s) => $(s)); btns.forEach((b) => { b.disabled = true; });
    try {
      for (let i = 0; i < ranges.length; i++) { const r = ranges[i]; await cutAndDownload(r.t0, r.t1, r.label, i + 1, ranges.length); if (ranges.length > 1) await new Promise((res) => setTimeout(res, 800)); }
    } catch (e) { setError('החיתוך נכשל: ' + e.message); }
    finally { hideProgress(); st.busy = false; btns.forEach((b) => { b.disabled = false; }); renderSelection(); renderPieces(); }
  }

  // ---------- חיבור הממשק ----------
  $('#cutFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) openFile(f); });
  $('#cutScanBtn').addEventListener('click', scan);
  for (const id of ['#cutDate', '#cutTime']) $(id).addEventListener('change', onTimeChanged);
  document.querySelectorAll('input[name="cutMode"]').forEach((r) => r.addEventListener('change', onTimeChanged));
  document.querySelectorAll('input[name="cutKind"]').forEach((r) => r.addEventListener('change', () => { const split = modeOf('cutKind') === 'split'; $('#cutManual').hidden = split; $('#cutSplit').hidden = !split; drawTimeline(); }));
  for (const id of ['#cutFrom', '#cutTo']) $(id).addEventListener('change', renderSelection);
  $('#cutRate').addEventListener('change', () => { renderSelection(); renderPieces(); });
  $('#cutPieceMin').addEventListener('change', renderPieces); $('#cutOnlyEvents').addEventListener('change', renderPieces);
  $('#cutTimeline').addEventListener('click', timelineClick);
  $('#cutGoBtn').addEventListener('click', () => { readSelection(); if (st.sel) runCuts([{ t0: st.sel.t0, t1: st.sel.t1, label: 'את החלק' }]); });
  $('#cutAllBtn').addEventListener('click', () => runCuts(st.pieces.filter((p) => p.selected).map((p) => ({ t0: p.t0, t1: p.t1, label: `חלק ${p.i}` }))));
  $('#cutPieces').addEventListener('change', (e) => { const cb = e.target.closest('input[data-act="sel"]'); if (!cb) return; const p = st.pieces[Number(cb.closest('li').dataset.i) - 1]; p.selected = cb.checked; renderPieces(); });
  $('#cutPieces').addEventListener('click', (e) => { const b = e.target.closest('button[data-act="dl"]'); if (!b) return; const p = st.pieces[Number(b.closest('li').dataset.i) - 1]; runCuts([{ t0: p.t0, t1: p.t1, label: `חלק ${p.i}` }]); });
  window.addEventListener('resize', drawTimeline);
  window.__noiseCut = { get state() { return st; }, cutRange, clockToOffset, openFile };
})();
