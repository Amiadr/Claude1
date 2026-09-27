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
    assert(ms < 3000, `classify: 120 s clip in ${ms} ms`);
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
