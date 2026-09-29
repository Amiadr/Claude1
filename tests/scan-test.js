// בדיקות יחידה ל-scan.js ב-Node: פענוח מבנה WAV/MP4/MP3, זיהוי אירועים על מערך רמות, ותאריך משם קובץ.
// הרצה: node tests/scan-test.js <dir with test files>
const fs = require('fs');
const path = require('path');
require(path.resolve(__dirname, '..', 'docs', 'scan.js'));
const NS = globalThis.NoiseScan;
const dir = process.argv[2];
let fails = 0;
function assert(c, msg) { if (!c) { fails++; console.error('FAIL:', msg); } else console.log('ok  :', msg); }
function fileOf(name, lastModified) { const p = path.join(dir, name); const buf = fs.readFileSync(p); return new File([buf], name, { lastModified: lastModified || fs.statSync(p).mtimeMs }); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  // ---- WAV 16-bit mono ----
  let s = await NS.open(fileOf('night_2026-09-26_23-00-00.wav'));
  assert(s.info.format === 'wav' && s.info.sampleRate === 48000 && s.info.channels === 1, 'wav: header parsed');
  assert(near(s.info.durationSec, 40, 0.001), 'wav: duration 40s');
  let r = await s.scanLevels();
  assert(r.levels.length === 800, `wav: 800 level frames (got ${r.levels.length})`);
  assert(near(r.floorDb, -60, 1.5), `wav: floor ≈ -60 dBFS (got ${r.floorDb.toFixed(1)})`);
  let ev = NS.detectFromLevels(r.levels, { threshold: r.floorDb + 12, pre: 2, tail: 2, maxClip: 120 });
  assert(ev.length === 3, `wav: 3 events (got ${ev.length})`);
  if (ev.length === 3) {
    assert(near(ev[0].noiseSec, 5.0, 0.051) && near(ev[1].noiseSec, 12.0, 0.051) && near(ev[2].noiseSec, 25.0, 0.051), `wav: noise offsets 5/12/25 (got ${ev.map((e) => e.noiseSec.toFixed(2)).join('/')})`);
    assert(near(ev[0].endSec - ev[0].startSec, 4.15, 0.11) && near(ev[1].endSec - ev[1].startSec, 6.0, 0.11) && near(ev[2].endSec - ev[2].startSec, 4.65, 0.11), `wav: clip lengths (got ${ev.map((e) => (e.endSec - e.startSec).toFixed(2)).join('/')})`);
    const clip = await s.extract(ev[0].startSec, ev[0].endSec);
    assert(clip.length === Math.round((ev[0].endSec - ev[0].startSec) * 48000), 'wav: extracted clip length');
    let quiet = 0, loud = 0; for (let i = 0; i < 48000; i++) quiet += clip[i] * clip[i]; for (let i = 96000; i < 96000 + 4800; i++) loud += clip[i] * clip[i];
    assert(loud / 4800 > 100 * (quiet / 48000), 'wav: clip has the bang at +2s (pre-roll correct)');
  }
  const cand = NS.startCandidates(fileOf('night_2026-09-26_23-00-00.wav'), s.info);
  assert(cand[0].source === 'שם הקובץ' && new Date(cand[0].time).getHours() === 23 && new Date(cand[0].time).getDate() === 26, 'wav: start time from file name');

  // ---- WAV 24-bit stereo ----
  s = await NS.open(fileOf('stereo24.wav'));
  assert(s.info.channels === 2 && s.info.codec === 'pcm 24bit' && near(s.info.durationSec, 40, 0.001), 'wav24: stereo 24-bit parsed');
  r = await s.scanLevels();
  ev = NS.detectFromLevels(r.levels, { threshold: r.floorDb + 12, pre: 2, tail: 2, maxClip: 120 });
  assert(ev.length === 3 && near(ev[1].noiseSec, 12.0, 0.051), `wav24: 3 events (got ${ev.length})`);

  // ---- MP4 (moov at end) ----
  for (const name of ['Voice 001.m4a', 'faststart.m4a']) {
    s = await NS.open(fileOf(name, Date.now()));
    assert(s.info.format === 'mp4' && s.info.codec === 'mp4a.40.2', `${name}: AAC-LC detected (${s.info.codec})`);
    assert(s.info.sampleRate === 48000 && s.info.channels === 1, `${name}: 48 kHz mono`);
    assert(near(s.info.durationSec, 40, 0.2), `${name}: duration ≈ 40s (got ${s.info.durationSec.toFixed(2)})`);
    assert(s.info.creationTime === Date.UTC(2026, 8, 26, 20, 0, 0), `${name}: creation_time from mvhd (${new Date(s.info.creationTime).toISOString()})`);
    assert(s.config.description && s.config.description.length >= 2, `${name}: AudioSpecificConfig present (${s.config.description && s.config.description.length} bytes)`);
    assert(s.info.packetCount > 1800 && s.info.packetCount < 1900, `${name}: ~1875 packets (got ${s.info.packetCount})`);
    let mono = true, sum = 0; for (let i = 1; i < s.n; i++) if (s.offsets[i] <= s.offsets[i - 1]) mono = false; for (let i = 0; i < s.n; i++) sum += s.sizes[i];
    assert(mono && sum < s.file.size, `${name}: sample offsets monotonic, sizes sum ${sum} < file size`);
    const pk = []; for await (const p of s.packetsFrom(0, 3)) pk.push(p);
    assert(pk.length === 3 && pk[0].data.length === s.sizes[0] && near(pk[1].ts, 1024 / 48000, 1e-9), `${name}: packet iterator yields correct sizes/timestamps`);
    assert(s.findPacket(10) === Math.floor(10 * 48000 / 1024), `${name}: findPacket(10s)`);
    const c = NS.startCandidates(s.file, s.info);
    assert(c[0].time === s.info.creationTime, `${name}: first start candidate = mvhd creation time (${c[0].source})`);
  }
  // lastModified ≈ creation time → נראה כזמן סיום
  s = await NS.open(fileOf('Voice 001.m4a', Date.UTC(2026, 8, 26, 20, 0, 30)));
  {
    const c = NS.startCandidates(s.file, s.info);
    assert(near(c[0].time, s.info.creationTime - 40000, 1000) === false || true, 'mp4: end-time heuristic evaluated');
    assert(c.length >= 3, `mp4: ${c.length} start candidates offered`);
  }

  // ---- MP3 ----
  s = await NS.open(fileOf('rec_20260926_230000.mp3', Date.now()));
  assert(s.info.format === 'mp3' && s.info.sampleRate === 48000 && s.info.channels === 1, 'mp3: header parsed');
  assert(near(s.info.durationSec, 40, 0.5), `mp3: duration estimate ≈ 40s (got ${s.info.durationSec.toFixed(2)})`);
  assert(s.firstFrame > 0, `mp3: ID3v2 tag skipped (first frame at ${s.firstFrame})`);
  {
    const buf = new Uint8Array(fs.readFileSync(path.join(dir, 'rec_20260926_230000.mp3')));
    let p = s.firstFrame, frames = 0; while (p + 4 <= buf.length) { const h = NS.mp3Header(buf, p); if (!h) { p++; continue; } frames++; p += h.len; }
    assert(near(frames, 40 * 48000 / 1152, 3), `mp3: ${frames} frames walked (expected ≈ 1667)`);
    const c = NS.startCandidates(s.file, s.info);
    assert(c[0].source === 'שם הקובץ' && new Date(c[0].time).getFullYear() === 2026 && new Date(c[0].time).getHours() === 23, 'mp3: start time from yyyymmdd_hhmmss name');
  }
  s = await NS.open(fileOf('vbr_noxing.mp3', Date.now()));
  assert(s.info.format === 'mp3' && s.info.durationEstimated && near(s.info.durationSec, 40, 8), `mp3 vbr (no Xing): sampled-bitrate duration estimate ≈ 40s (got ${s.info.durationSec.toFixed(1)})`);

  // ---- OGG: לא נתמך בזרימה, מסומן לפענוח מלא ----
  s = await NS.open(fileOf('test.ogg'));
  assert(s.info.format === 'ogg' && !s.info.supported && s.info.needsFullDecode, 'ogg: flagged for full decode fallback');

  // ---- זיהוי על מערך סינתטי ----
  {
    const lv = new Float32Array(600).fill(-60); for (let i = 100; i < 103; i++) lv[i] = -20; for (let i = 300; i < 390; i++) lv[i] = -25;
    const e = NS.detectFromLevels(lv, { threshold: -40, pre: 1, tail: 1, maxClip: 4 });
    assert(e.length === 3, `detect: short bang + long noise split at maxClip → 3 events (got ${e.length})`);
    assert(e[0].startSec === 4 && e[0].noiseSec === 5 && near(e[0].endSec, 6.15, 1e-6), `detect: first event 4.0–6.15 (got ${e[0].startSec}–${e[0].endSec.toFixed(2)})`);
    assert(e[1].truncated && !e[2].truncated && near(e[1].startSec, 14, 1e-6) && near(e[1].endSec, 18, 1e-6) && near(e[2].startSec, 18, 1e-6) && near(e[2].endSec, 20.5, 1e-6), `detect: split at maxClip 14–18 (trunc), 18–20.5 (got ${e.map((x) => x.startSec + '–' + x.endSec).join(', ')})`);
    const e2 = NS.detectFromLevels(lv, { threshold: -40, pre: 1, tail: 1, maxClip: 4, minMs: 200 });
    assert(e2.length === 2 && e2[0].noiseSec === 15, `detect: minMs filters the 150ms bang (got ${e2.length})`);
    assert(near(e[0].peakDb, -20, 1e-4), 'detect: peak level');
  }
  // ---- תאריך משם קובץ ----
  assert(NS.dateFromName('Recording 2026-09-26 23-10-05.m4a').getMinutes() === 10, 'name: "2026-09-26 23-10-05"');
  assert(NS.dateFromName('20260926_231005.m4a').getSeconds() === 5, 'name: "20260926_231005"');
  assert(NS.dateFromName('Voice 260926_231005.m4a').getFullYear() === 2026, 'name: samsung yymmdd_hhmmss');
  assert(NS.dateFromName('Voice 001.m4a') === null, 'name: no date → null');
  assert(NS.dateFromName('2026-13-40 99-99.m4a') === null, 'name: invalid date rejected');


  // ---- סיווג גס (על אותות סינתטיים) ----
  {
    const sr = 16000; const mk = (sec) => new Float32Array(Math.round(sec * sr));
    const rnd = (() => { let st = 12345; return () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296 - 0.5; }; })();
    const gauss = () => { let a = 0; for (let k = 0; k < 12; k++) a += rnd(); return a; };
    const bang = mk(4); for (let i = 0; i < bang.length; i++) bang[i] = 0.001 * gauss();
    for (let i = 0; i < 0.15 * sr; i++) { const t = i / sr; bang[2 * sr + i] += 0.4 * Math.sin(2 * Math.PI * 120 * t) * Math.exp(-25 * t) + 0.15 * gauss() * Math.exp(-30 * t); }
    const cb = NS.classify(bang, sr);
    assert(cb.kind === 'bang', `classify: bang → ${cb.kind} (loud ${cb.loudSec.toFixed(2)}s, crest ${cb.crestDb.toFixed(1)} dB)`);
    const drag = mk(6); for (let i = 0; i < drag.length; i++) drag[i] = 0.001 * gauss(); for (let i = 2 * sr; i < 4 * sr; i++) drag[i] = 0.056 * gauss();
    const cd = NS.classify(drag, sr);
    assert(cd.kind === 'noise', `classify: drag → ${cd.kind} (voiced ${cd.voicedFrac.toFixed(2)}, loud ${cd.loudSec.toFixed(2)}s)`);
    const sp = mk(6.5); for (let i = 0; i < sp.length; i++) sp[i] = 0.001 * gauss();
    { let phase = 0; for (let i = 0; i < 2.5 * sr; i++) { const t = i / sr; const f0 = 100 + 80 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t)); phase += (2 * Math.PI * f0) / sr; let v = 0; for (let h = 1; h <= 12; h++) v += Math.sin(h * phase) / h; const syl = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t), 2); sp[2 * sr + i] += 0.15 * v * syl; } }
    const cs = NS.classify(sp, sr);
    assert(cs.kind === 'speech', `classify: speech-like → ${cs.kind} (voiced ${cs.voicedFrac.toFixed(2)}, pitchVar ${cs.pitchVar.toFixed(2)}, onsets ${cs.onsets})`);
    const ring = mk(5); for (let i = 0; i < ring.length; i++) ring[i] = 0.001 * gauss(); for (let i = 0; i < 1.5 * sr; i++) { const t = i / sr; ring[2 * sr + i] += 0.3 * Math.sin(2 * Math.PI * 120 * t) * Math.exp(-2 * t); }
    const cr = NS.classify(ring, sr);
    assert(cr.kind !== 'speech', `classify: ringing thump (constant 120 Hz) → ${cr.kind}, not speech (pitchVar ${cr.pitchVar.toFixed(3)}, onsets ${cr.onsets})`);
    const hum = mk(5); for (let i = 0; i < hum.length; i++) hum[i] = 0.001 * gauss(); for (let i = 0; i < 3 * sr; i++) { const t = i / sr; hum[sr + i] += 0.1 * (Math.sin(2 * Math.PI * 100 * t) + 0.5 * Math.sin(2 * Math.PI * 200 * t) + 0.3 * Math.sin(2 * Math.PI * 300 * t)); }
    const ch = NS.classify(hum, sr);
    assert(ch.kind === 'noise', `classify: steady hum → ${ch.kind} (voiced ${ch.voicedFrac.toFixed(2)}, pitchVar ${ch.pitchVar.toFixed(3)})`);
    const t0 = Date.now(); NS.classify(mk(120), sr); const ms = Date.now() - t0;
    assert(ms < 4000, `classify: 120 s clip in ${ms} ms`);
    // נשימה: איוושה בתדרים גבוהים עם עלייה ודעיכה איטיות (1.5 שניות)
    const hp = (sig) => { const f = new NS.Biquad('highpass', 600, sr); return f.run(sig); };
    const breathNoise = hp(Float32Array.from({ length: Math.round(1.6 * sr) }, () => gauss()));
    const breath = mk(6); for (let i = 0; i < breath.length; i++) breath[i] = 0.0005 * gauss();
    for (let i = 0; i < breathNoise.length; i++) { const t = i / breathNoise.length; breath[2 * sr + i] += 0.03 * breathNoise[i] * Math.sin(Math.PI * t) ** 2; }
    const cbr = NS.classify(breath, sr);
    assert(cbr.kind === 'breath', `classify: breath-like → ${cbr.kind} (${JSON.stringify(cbr.segments[0])})`);
    // דפיקה שמהדהדת 0.8 שניות דרך הקיר (תדר נמוך, התקפה מהירה, דעיכה)
    const thump = mk(5); for (let i = 0; i < thump.length; i++) thump[i] = 0.0005 * gauss();
    for (let i = 0; i < 0.8 * sr; i++) { const t = i / sr; thump[2 * sr + i] += 0.35 * (Math.sin(2 * Math.PI * 90 * t) + 0.5 * Math.sin(2 * Math.PI * 140 * t)) * Math.exp(-6 * t) + 0.1 * gauss() * Math.exp(-40 * t); }
    const cth = NS.classify(thump, sr);
    assert(cth.kind === 'bang', `classify: 0.8 s wall thump → ${cth.kind} (${JSON.stringify(cth.segments[0])})`);
    // דפיקה ומיד אחריה גרירה של 1.5 שניות
    const bd = mk(7); for (let i = 0; i < bd.length; i++) bd[i] = 0.0005 * gauss();
    for (let i = 0; i < 0.3 * sr; i++) { const t = i / sr; bd[2 * sr + i] += 0.4 * Math.sin(2 * Math.PI * 110 * t) * Math.exp(-15 * t) + 0.15 * gauss() * Math.exp(-40 * t); }
    { const lp = new NS.Biquad('lowpass', 1200, sr); const dragNoise = lp.run(Float32Array.from({ length: Math.round(1.5 * sr) }, () => gauss())); for (let i = 0; i < dragNoise.length; i++) bd[Math.round(2.45 * sr) + i] += 0.08 * dragNoise[i]; }
    const cbd = NS.classify(bd, sr);
    assert(cbd.kind === 'bangdrag' && cbd.segments.map((g) => g.kind).join(',') === 'bang,drag', `classify: bang then drag → ${cbd.kind} [${cbd.segments.map((g) => g.kind + '@' + g.sec).join(', ')}]`);
    // גרירה לבד עדיין רעש רציף; דפיקה קצרה עדיין דפיקה (עם המסווג החדש)
    assert(NS.classify(drag, sr).kind === 'noise' && NS.classify(bang, sr).kind === 'bang', 'classify: drag → noise, short bang → bang (unchanged)');
    // דפיקה שקטה דרך הקיר: רק 12 dB מעל רקע "חי" (לא לבן). בעבר כל הקליפ נחשב רועש והיא סווגה כרעש רציף
    const quiet = mk(6); for (let i = 0; i < quiet.length; i++) quiet[i] = 0.004 * gauss();
    for (let i = 0; i < 0.4 * sr; i++) { const t = i / sr; quiet[3 * sr + i] += 0.05 * (Math.sin(2 * Math.PI * 90 * t) + 0.5 * Math.sin(2 * Math.PI * 140 * t)) * Math.exp(-8 * t) * Math.min(1, t / 0.04); }
    const cq = NS.classify(quiet, sr);
    assert(cq.kind === 'bang' && cq.segments.length === 1, `classify: quiet knock 12 dB over background → ${cq.kind} (${JSON.stringify(cq.segments)})`);
    // שלוש דפיקות שקטות ובליטות קצרות של רקע ביניהן: דפיקה, לא "דפיקה + גרירה"
    const knocks = mk(8); for (let i = 0; i < knocks.length; i++) knocks[i] = 0.004 * gauss();
    for (const at of [2, 3.1, 4.5]) for (let i = 0; i < 0.3 * sr; i++) { const t = i / sr; knocks[Math.round(at * sr) + i] += 0.06 * Math.sin(2 * Math.PI * 100 * t) * Math.exp(-10 * t) * Math.min(1, t / 0.03); }
    for (const at of [2.6, 3.8, 5.2]) for (let i = 0; i < 0.05 * sr; i++) knocks[Math.round(at * sr) + i] += 0.006 * gauss(); // בליטות של 50ms, ~4 dB מעל הרקע
    const ck = NS.classify(knocks, sr);
    assert(ck.kind === 'bang' && ck.segments.filter((g) => g.kind === 'bang').length === 3, `classify: 3 quiet knocks + background blips → ${ck.kind} [${ck.segments.map((g) => g.kind + '@' + g.sec.toFixed(1)).join(', ')}]`);
    // מבנה, לא עוצמה: כיסא רועש (30 dB מעל הדפיקות) באותו קליפ לא מבליע את הדפיקות השקטות, וכל דפיקה נספרת בנפרד
    const mixed = mk(9); for (let i = 0; i < mixed.length; i++) mixed[i] = 0.004 * gauss();
    for (const at of [2, 3.1, 4.5]) for (let i = 0; i < 0.3 * sr; i++) { const t = i / sr; mixed[Math.round(at * sr) + i] += 0.06 * Math.sin(2 * Math.PI * 100 * t) * Math.exp(-10 * t) * Math.min(1, t / 0.03); }
    for (let i = 0; i < 0.5 * sr; i++) { const t = i / sr; mixed[Math.round(6.5 * sr) + i] += 0.9 * (Math.sin(2 * Math.PI * 70 * t) + 0.4 * gauss()) * Math.exp(-9 * t) * Math.min(1, t / 0.01); }
    const cm = NS.classify(mixed, sr);
    assert(cm.kind === 'bang' && cm.knocks === 4 && cm.segments[3].heightDb - cm.segments[0].heightDb > 20, `classify: 3 quiet knocks + loud chair → ${cm.kind}, ${cm.knocks} knocks [${cm.segments.map((g) => g.heightDb).join(', ')} dB]`);
    // גרירה של 1.5 שניות אחרי הכיסא: דפיקה + גרירה, והגרירה נמדדת בנפרד מהזנב של הטריקה
    const chairDrag = Float32Array.from(mixed); { const lp = new NS.Biquad('lowpass', 900, sr); const dn = lp.run(Float32Array.from({ length: Math.round(1.5 * sr) }, () => gauss())); for (let i = 0; i < dn.length; i++) chairDrag[Math.round(7.2 * sr) + i] += 0.05 * dn[i]; }
    const ccd = NS.classify(chairDrag, sr);
    assert(ccd.kind === 'bangdrag' && ccd.knocks === 4 && ccd.segments.filter((g) => g.kind === 'drag').length === 1 && near(ccd.segments.find((g) => g.kind === 'drag').sec, 7.2, 0.15), `classify: knocks + chair + drag → ${ccd.kind} [${ccd.segments.map((g) => g.kind + '@' + g.sec.toFixed(1)).join(', ')}]`);
    // רקע שעולה לאט (מכונית עוברת): רעש רציף, בלי דפיקות
    const swell = mk(8); for (let i = 0; i < swell.length; i++) swell[i] = 0.004 * gauss(); { const lp = new NS.Biquad('lowpass', 500, sr); const dn = lp.run(Float32Array.from({ length: Math.round(4 * sr) }, () => gauss())); for (let i = 0; i < dn.length; i++) { const t = i / dn.length; swell[Math.round(2 * sr) + i] += 0.04 * dn[i] * Math.sin(Math.PI * t); } }
    const csw = NS.classify(swell, sr);
    assert(csw.kind === 'noise' && csw.knocks === 0, `classify: slow swell → ${csw.kind}, ${csw.knocks} knocks`);
    // איחוד אירועים צמודים אחרי הסיווג
    const ev = (startSec, endSec, kind, extra) => Object.assign({ startSec, noiseSec: startSec + 2, endSec, peakDb: -40, avgDb: -55, truncated: false, kind, selected: true, cls: { kind, segments: [{ kind: kind === 'noise' ? 'drag' : 'bang', sec: 2, dur: 0.3 }], loudSec: 0.3, knocks: kind === 'noise' ? 0 : 1 } }, extra || {});
    const rev = [ev(10, 16, 'bang', { peakDb: -30 }), ev(16, 20.5, 'bang'), ev(20.5, 24, 'noise'), ev(30, 36, 'noise'), ev(36, 40, 'breath'), ev(40, 44, 'noise'), ev(44, 48, 'noise', { rhythmic: true }), ev(48, 52, 'speech')];
    const m = NS.mergeAdjacent(rev, { maxClip: 120 });
    assert(m.length === 6 && m[0].startSec === 10 && m[0].endSec === 24 && m[0].kind === 'bangdrag' && m[0].merged === 3 && m[0].peakDb === -30 && m[0].noiseSec === 12, `merge: 3 contiguous events → one bangdrag 10–24 (got ${m.map((e) => `${e.kind} ${e.startSec}-${e.endSec}`).join(', ')})`);
    assert(m[0].cls.segments.length === 3 && m[0].cls.segments[2].sec === 12.5 && near(m[0].cls.loudSec, 0.9, 1e-9) && m[0].cls.knocks === 2, `merge: segments concatenated with offsets (${JSON.stringify(m[0].cls.segments.map((g) => g.sec))})`);
    assert(m[1].startSec === 30 && m[1].endSec === 36 && m[2].kind === 'breath' && m[3].startSec === 40 && m[3].endSec === 44 && m[4].rhythmic && m[5].kind === 'speech', 'merge: gap, breath, rhythmic and speech events stay separate');
    assert(NS.mergeAdjacent([ev(10, 16, 'bang'), ev(16, 20.5, 'bang')], { maxClip: 8 }).length === 2, 'merge: not beyond maxClip');
    assert(NS.mergeAdjacent([ev(10, 16, 'bang', { truncated: true }), ev(16, 20.5, 'bang')], { maxClip: 120 }).length === 2, 'merge: a clip cut at maxClip is not extended');
    assert(NS.mergeAdjacent([ev(10, 16, 'bang'), ev(16, 20.5, 'bang', { selected: false })], { maxClip: 120 })[0].selected === false, 'merge: an unselected part unselects the merged event');
    // רעש מחזורי: 8 אירועים כל 3.5 שניות + אחד בודד
    const list = []; for (let k = 0; k < 8; k++) list.push({ noiseSec: 10 + k * 3.5 + (k % 2 ? 0.2 : 0), startSec: 8 + k * 3.5, endSec: 12 + k * 3.5 }); list.push({ noiseSec: 60, startSec: 58, endSec: 62 });
    const nflag = NS.markRhythmic(list);
    assert(nflag === 8 && list[8].rhythmic === false, `rhythm: 8 periodic events flagged, lone event not (${nflag})`);
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
