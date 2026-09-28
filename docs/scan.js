/* scan.js – ניתוח הקלטה קיימת בדפדפן.
   קורא קובץ בזרימה (בלי לטעון אותו כולו לזיכרון), מפענח WAV ישירות ו-MP4/AAC או MP3 דרך WebCodecs,
   מחשב רמת קול לכל 50 אלפיות שנייה, מזהה אירועים מעל סף, ומחלץ קליפים לפי טווחי זמן.
   רץ גם ב-Web Worker וגם בדף הראשי (אין כאן DOM). */
'use strict';
(function (root) {
  const FRAME_SEC = 0.05;
  const WINDOW = 4 * 1024 * 1024;
  const MP4_EPOCH = 2082844800; // שניות בין 1904-01-01 ל-1970-01-01

  const readSlice = async (file, start, end) => new Uint8Array(await file.slice(start, Math.min(end, file.size)).arrayBuffer());
  const fourcc = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const u32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const u16 = (u8, o) => (u8[o] << 8) | u8[o + 1];
  const u64 = (u8, o) => u32(u8, o) * 4294967296 + u32(u8, o + 4);
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));

  // ---------- תאריך משם הקובץ ----------
  function dateFromName(name) {
    let m = name.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _T-]?(\d{2})[-_.:h]?(\d{2})(?:[-_.:m]?(\d{2}))?/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      if (!isNaN(d) && d.getMonth() === +m[2] - 1) return d;
    }
    m = name.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:\D|$)/); // yymmdd_hhmmss (סמסונג)
    if (m) {
      const d = new Date(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (!isNaN(d) && d.getMonth() === +m[2] - 1) return d;
    }
    return null;
  }

  // ---------- זיהוי פורמט ----------
  async function sniff(file) {
    const h = await readSlice(file, 0, 16);
    if (h.length >= 12 && fourcc(h, 0) === 'RIFF' && fourcc(h, 8) === 'WAVE') return 'wav';
    if (h.length >= 8 && fourcc(h, 4) === 'ftyp') return 'mp4';
    if (h.length >= 3 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return 'mp3'; // ID3
    if (h.length >= 2 && h[0] === 0xFF && (h[1] & 0xE6) === 0xE2) return 'mp3';
    if (h.length >= 4 && fourcc(h, 0) === 'OggS') return 'ogg';
    if (h.length >= 4 && fourcc(h, 0) === 'fLaC') return 'flac';
    if (h.length >= 4 && h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3) return 'webm';
    if (h.length >= 5 && fourcc(h, 0) === '#!AM') return 'amr';
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return { m4a: 'mp4', mp4: 'mp4', aac: 'mp4', '3gp': 'mp4', mp3: 'mp3', wav: 'wav', ogg: 'ogg', opus: 'ogg', flac: 'flac', webm: 'webm', amr: 'amr' }[ext] || 'unknown';
  }

  // ---------- מסנן biquad (Butterworth מסדר 2, נוסחאות RBJ) ----------
  const LOW_BAND_HZ = 300;  // "רעשי מבנה": דפיקות על קיר וגרירת רהיטים עוברים דרך הבניין בעיקר מתחת ל-300 Hz
  class Biquad {
    constructor(type, fc, fs, q) {
      q = q || Math.SQRT1_2;
      const w0 = (2 * Math.PI * fc) / fs, cw = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
      let b0, b1, b2;
      if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
      else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
      const a0 = 1 + alpha;
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha) / a0;
      this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    }
    run(x, out) {
      out = out || new Float32Array(x.length);
      let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
      const { b0, b1, b2, a1, a2 } = this;
      for (let i = 0; i < x.length; i++) { const v = x[i]; const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; out[i] = y; }
      this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
      return out;
    }
  }

  // ---------- צבירת רמות (כל התדרים + תדרים נמוכים בלבד) ----------
  class LevelAccumulator {
    constructor(sampleRate, estDurationSec) {
      this.sr = sampleRate;
      this.frameLen = Math.max(1, Math.round(sampleRate * FRAME_SEC));
      const n = Math.ceil(((estDurationSec || 60) * sampleRate) / this.frameLen) + 64;
      this.sumSq = new Float64Array(n); this.sumSqLf = new Float64Array(n); this.count = new Uint32Array(n); this.maxFrame = -1;
      this.lpf = new Biquad('lowpass', LOW_BAND_HZ, sampleRate); this.lpf2 = new Biquad('lowpass', LOW_BAND_HZ, sampleRate);
      this.tmp = null;
    }
    ensure(idx) {
      if (idx < this.sumSq.length) return;
      let n = this.sumSq.length; while (n <= idx) n *= 2;
      const s = new Float64Array(n); s.set(this.sumSq); const sl = new Float64Array(n); sl.set(this.sumSqLf); const c = new Uint32Array(n); c.set(this.count);
      this.sumSq = s; this.sumSqLf = sl; this.count = c;
    }
    add(samples, startSample) {
      if (!this.tmp || this.tmp.length < samples.length) this.tmp = new Float32Array(samples.length);
      const lf = this.lpf2.run(this.lpf.run(samples, this.tmp), this.tmp); // 4 קטבים
      const L = this.frameLen; let i = 0;
      while (i < samples.length) {
        const abs = startSample + i; const f = Math.floor(abs / L);
        const n = Math.min((f + 1) * L - abs, samples.length - i);
        this.ensure(f);
        let ss = 0, sl = 0; for (let k = 0; k < n; k++) { const v = samples[i + k]; ss += v * v; const w = lf[i + k]; sl += w * w; }
        this.sumSq[f] += ss; this.sumSqLf[f] += sl; this.count[f] += n;
        if (f > this.maxFrame) this.maxFrame = f;
        i += n;
      }
    }
    levels() {
      const n = this.maxFrame + 1; const out = new Float32Array(n), lf = new Float32Array(n);
      for (let f = 0; f < n; f++) { const c = this.count[f]; out[f] = c ? 10 * Math.log10(Math.max(this.sumSq[f] / c, 1e-12)) : -100; lf[f] = c ? 10 * Math.log10(Math.max(this.sumSqLf[f] / c, 1e-12)) : -100; }
      return { full: out, low: lf };
    }
  }

  // ---------- זיהוי אירועים על מערך רמות (זהה לכלי הפייתוני) ----------
  function detectFromLevels(levels, opts) {
    const thr = opts.threshold;
    const preF = Math.round(opts.pre / FRAME_SEC), tailF = Math.max(1, Math.round(opts.tail / FRAME_SEC));
    const maxF = Math.max(tailF + 1, Math.round(opts.maxClip / FRAME_SEC));
    const minF = Math.max(1, Math.round((opts.minMs || 0) / 1000 / FRAME_SEC));
    const n = levels.length, events = [];
    let i = 0, prevEnd = 0;
    while (i < n) {
      if (levels[i] < thr) { i++; continue; }
      let j = i; while (j < n && levels[j] >= thr && j - i < minF) j++;
      if (j - i < minF) { while (j < n && levels[j] >= thr) j++; i = j; continue; }
      const noiseF = i, startF = Math.max(prevEnd, noiseF - preF);
      let lastLoud = i, k = i + 1, truncated = false, endF;
      for (;;) {
        if (k >= n) { endF = n; break; }
        if (levels[k] >= thr) lastLoud = k;
        if (k - lastLoud >= tailF) { endF = lastLoud + tailF + 1; break; }
        if (k - startF + 1 >= maxF) { endF = k + 1; truncated = true; break; }
        k++;
      }
      endF = Math.min(endF, n);
      let peak = -200, sumLin = 0;
      for (let f = startF; f < endF; f++) { const v = levels[f]; if (v > peak) peak = v; sumLin += Math.pow(10, v / 10); }
      events.push({ startSec: startF * FRAME_SEC, noiseSec: noiseF * FRAME_SEC, endSec: endF * FRAME_SEC, peakDb: peak, avgDb: 10 * Math.log10(Math.max(sumLin / (endF - startF), 1e-12)), truncated });
      prevEnd = endF; i = endF;
    }
    return events;
  }
  function median(levels) {
    if (!levels.length) return -100;
    const a = Float32Array.from(levels).sort();
    return a[Math.floor(a.length / 2)];
  }

  // ---------- המרת AudioData למונו Float32 ----------
  function audioDataToMono(data) {
    const n = data.numberOfFrames, ch = data.numberOfChannels, fmt = data.format || 'f32-planar';
    const planar = fmt.endsWith('-planar'); const kind = fmt.split('-')[0];
    const Ctor = { u8: Uint8Array, s16: Int16Array, s32: Int32Array, f32: Float32Array }[kind];
    const scale = { u8: 1 / 128, s16: 1 / 32768, s32: 1 / 2147483648, f32: 1 }[kind];
    const off = kind === 'u8' ? 128 : 0;
    const out = new Float32Array(n);
    if (planar) {
      const plane = new Ctor(n);
      for (let c = 0; c < ch; c++) { data.copyTo(plane, { planeIndex: c }); for (let i = 0; i < n; i++) out[i] += (plane[i] - off) * scale; }
    } else {
      const buf = new Ctor(n * ch); data.copyTo(buf, { planeIndex: 0 });
      for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += buf[i * ch + c] - off; out[i] = s * scale; }
    }
    if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
    return out;
  }

  // ---------- פענוח זרם חבילות דרך WebCodecs ----------
  async function decodePackets(config, packets, onAudio, isCancelled) {
    let failure = null;
    const decoder = new AudioDecoder({
      output: (data) => { try { onAudio(data); } finally { data.close(); } },
      error: (e) => { failure = e; },
    });
    decoder.configure(config);
    try {
      for await (const p of packets) {
        if (failure) throw failure;
        if (isCancelled && isCancelled()) break;
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(p.ts * 1e6), data: p.data }));
        if (decoder.decodeQueueSize > 64) { while (decoder.decodeQueueSize > 16) await new Promise((r) => setTimeout(r, 2)); }
      }
      if (failure) throw failure;
      await decoder.flush();
    } finally {
      try { decoder.close(); } catch (e) { /* ignore */ }
    }
  }

  // ---------- בסיס לסורקים ----------
  class BaseScanner {
    constructor(file) { this.file = file; this.cancelled = false; this.outRate = null; }
    cancel() { this.cancelled = true; }
    async scanLevels(onProgress) {
      this.cancelled = false;
      let acc = null;
      await this.decodeAll((samples, startSample, sampleRate) => {
        if (!acc) { acc = new LevelAccumulator(sampleRate, this.info.durationSec); this.outRate = sampleRate; }
        acc.add(samples, startSample);
      }, onProgress);
      if (this.cancelled) return null;
      const lv = acc ? acc.levels() : { full: new Float32Array(0), low: new Float32Array(0) };
      return { levels: lv.full, levelsLow: lv.low, frameSec: FRAME_SEC, sampleRate: this.outRate || this.info.sampleRate, durationSec: lv.full.length * FRAME_SEC, floorDb: median(lv.full), floorLowDb: median(lv.low) };
    }
  }

  // ---------- WAV ----------
  class WavScanner extends BaseScanner {
    async open() {
      const f = this.file;
      const head = await readSlice(f, 0, Math.min(f.size, 1 << 20));
      let p = 12, fmt = null, data = null, icrd = null;
      while (p + 8 <= head.length) {
        const id = fourcc(head, p); const size = head[p + 4] | (head[p + 5] << 8) | (head[p + 6] << 16) | (head[p + 7] << 24) >>> 0;
        const body = p + 8;
        if (id === 'fmt ') {
          const dv = new DataView(head.buffer, head.byteOffset + body, Math.min(40, head.length - body));
          fmt = { tag: dv.getUint16(0, true), channels: dv.getUint16(2, true), sampleRate: dv.getUint32(4, true), bits: dv.getUint16(14, true) };
          if (fmt.tag === 0xFFFE && size >= 26) fmt.tag = dv.getUint16(24, true);
        } else if (id === 'data') {
          const len = (size === 0 || size === 0xFFFFFFFF || body + size > f.size) ? f.size - body : size;
          data = { offset: body, size: len };
          break;
        } else if (id === 'LIST' && fourcc(head, body) === 'INFO') {
          let q = body + 4;
          while (q + 8 <= Math.min(body + size, head.length)) {
            const sid = fourcc(head, q); const ssz = head[q + 4] | (head[q + 5] << 8) | (head[q + 6] << 16) | (head[q + 7] << 24) >>> 0;
            if (sid === 'ICRD') icrd = new TextDecoder().decode(head.subarray(q + 8, q + 8 + ssz)).replace(/\0+$/, '');
            q += 8 + ssz + (ssz & 1);
          }
        }
        p = body + size + (size & 1);
      }
      if (!fmt || !data) throw new Error('קובץ WAV לא תקין (חסר fmt או data)');
      if (![1, 3].includes(fmt.tag) || ![8, 16, 24, 32].includes(fmt.bits)) throw new Error(`WAV בפורמט לא נתמך (tag ${fmt.tag}, ${fmt.bits} ביט)`);
      this.fmt = fmt; this.data = data;
      this.blockAlign = fmt.channels * (fmt.bits / 8);
      const frames = Math.floor(data.size / this.blockAlign);
      let creation = null;
      if (icrd) { const d = new Date(icrd); if (!isNaN(d)) creation = d.getTime(); }
      this.info = { format: 'wav', codec: `pcm ${fmt.bits}bit`, sampleRate: fmt.sampleRate, channels: fmt.channels, durationSec: frames / fmt.sampleRate, creationTime: creation, creationSource: creation ? 'wav-icrd' : null, supported: true };
      return this;
    }
    convert(u8) {
      const { bits, channels, tag } = this.fmt; const frames = Math.floor(u8.length / this.blockAlign);
      const out = new Float32Array(frames);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) {
          const o = (i * channels + c) * (bits / 8);
          if (bits === 16) s += dv.getInt16(o, true) / 32768;
          else if (bits === 8) s += (u8[o] - 128) / 128;
          else if (bits === 24) s += (((u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) << 8) >> 8) / 8388608;
          else s += tag === 3 ? dv.getFloat32(o, true) : dv.getInt32(o, true) / 2147483648;
        }
        out[i] = s / channels;
      }
      return out;
    }
    async decodeAll(onSamples, onProgress) {
      const { offset, size } = this.data; const step = Math.floor(WINDOW / this.blockAlign) * this.blockAlign;
      for (let pos = 0; pos < size; pos += step) {
        if (this.cancelled) return;
        const u8 = await readSlice(this.file, offset + pos, offset + Math.min(size, pos + step));
        onSamples(this.convert(u8), Math.floor(pos / this.blockAlign), this.fmt.sampleRate);
        if (onProgress) onProgress(Math.min(1, (pos + step) / size));
        await yieldNow();
      }
    }
    async extract(t0, t1) {
      const sr = this.fmt.sampleRate; const s0 = Math.max(0, Math.round(t0 * sr)); const n = Math.max(0, Math.round((t1 - t0) * sr));
      const u8 = await readSlice(this.file, this.data.offset + s0 * this.blockAlign, this.data.offset + Math.min(this.data.size, (s0 + n) * this.blockAlign));
      const got = this.convert(u8); const out = new Float32Array(n); out.set(got.subarray(0, n));
      return out;
    }
  }

  // ---------- סורק מבוסס WebCodecs (MP4 / MP3) ----------
  class PacketScanner extends BaseScanner {
    // תת-מחלקות מספקות: this.config, this.packetCount(), packetsFrom(index, endIndex) (async generator), this.times (Float64Array שניות לכל חבילה)
    async checkSupport() {
      if (typeof AudioDecoder === 'undefined') { this.info.supported = false; this.info.reason = 'הדפדפן לא תומך ב-WebCodecs (נדרש Chrome 94+, Safari 17+ או Firefox 130+)'; return; }
      try {
        const r = await AudioDecoder.isConfigSupported(this.config);
        this.info.supported = !!r.supported;
        if (!r.supported) this.info.reason = `הדפדפן לא יודע לפענח ${this.config.codec}`;
      } catch (e) { this.info.supported = false; this.info.reason = 'בדיקת תמיכה בפענוח נכשלה: ' + e.message; }
    }
    async decodeAll(onSamples, onProgress) {
      const total = this.packetCount();
      let done = 0, lastReport = 0;
      const self = this;
      async function* gen() { for await (const p of self.packetsFrom(0, total)) { done++; if (onProgress && done - lastReport >= 200) { lastReport = done; onProgress(done / total); } yield p; } }
      await decodePackets(this.config, gen(), (data) => {
        const sr = data.sampleRate; const start = Math.round((data.timestamp / 1e6) * sr);
        onSamples(audioDataToMono(data), start, sr);
      }, () => this.cancelled);
      if (onProgress) onProgress(1);
    }
    findPacket(t) { // האינדקס האחרון שזמנו <= t
      const a = this.times; let lo = 0, hi = a.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid] <= t) lo = mid; else hi = mid - 1; }
      return lo;
    }
    async extract(t0, t1) {
      const sr = this.outRate || this.info.sampleRate;
      const s0 = Math.round(t0 * sr), n = Math.max(0, Math.round((t1 - t0) * sr)); const out = new Float32Array(n);
      const k0 = Math.max(0, this.findPacket(t0) - 2); const k1 = Math.min(this.packetCount(), this.findPacket(t1) + 2);
      await decodePackets(this.config, this.packetsFrom(k0, k1), (data) => {
        const start = Math.round((data.timestamp / 1e6) * data.sampleRate) - s0; const mono = audioDataToMono(data);
        const from = Math.max(0, -start), to = Math.min(mono.length, n - start);
        if (to > from) out.set(mono.subarray(from, to), start + from);
      });
      return out;
    }
  }

  // ---------- MP4 / M4A ----------
  function* boxes(u8, start, end) {
    let p = start;
    while (p + 8 <= end) {
      let size = u32(u8, p); const type = fourcc(u8, p + 4); let hdr = 8;
      if (size === 1) { size = u64(u8, p + 8); hdr = 16; } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) return;
      yield { type, start: p + hdr, end: p + size };
      p += size;
    }
  }
  function findBox(u8, start, end, type) { for (const b of boxes(u8, start, end)) if (b.type === type) return b; return null; }
  function parseEsds(u8, o) {
    function desc(p) { const tag = u8[p++]; let len = 0; for (let i = 0; i < 4; i++) { const b = u8[p++]; len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return { tag, len, start: p }; }
    let d = desc(o); if (d.tag !== 0x03) return null;
    let p = d.start + 2; const flags = u8[p++];
    if (flags & 0x80) p += 2; if (flags & 0x40) { p += 1 + u8[p]; } if (flags & 0x20) p += 2;
    d = desc(p); if (d.tag !== 0x04) return null;
    const oti = u8[d.start]; p = d.start + 13;
    d = desc(p); if (d.tag !== 0x05) return { oti, asc: null };
    return { oti, asc: u8.slice(d.start, d.start + d.len) };
  }
  class Mp4Scanner extends PacketScanner {
    async open() {
      const f = this.file;
      let pos = 0, moov = null;
      while (pos + 8 <= f.size) {
        const h = await readSlice(f, pos, pos + 16);
        let size = u32(h, 0); const type = fourcc(h, 4); let hdr = 8;
        if (size === 1) { size = u64(h, 8); hdr = 16; } else if (size === 0) size = f.size - pos;
        if (size < hdr) throw new Error('קובץ MP4 פגום');
        if (type === 'moov') { moov = { start: pos + hdr, end: pos + size }; break; }
        pos += size;
      }
      if (!moov) throw new Error('לא נמצא moov בקובץ. ייתכן שההקלטה לא נסגרה כראוי (האפליקציה נסגרה באמצע?)');
      if (moov.end - moov.start > 256 * 1024 * 1024) throw new Error('moov גדול מדי');
      const m = await readSlice(f, moov.start, moov.end);
      const mvhd = findBox(m, 0, m.length, 'mvhd');
      let creation = null;
      if (mvhd) {
        const v = m[mvhd.start]; const ct = v === 1 ? u64(m, mvhd.start + 4) : u32(m, mvhd.start + 4);
        if (ct > MP4_EPOCH + 315532800) creation = (ct - MP4_EPOCH) * 1000; // אחרי 1980
      }
      // ©day ב-udta/meta/ilst (iOS)
      let dayStr = null;
      const udta = findBox(m, 0, m.length, 'udta');
      if (udta) {
        const meta = findBox(m, udta.start, udta.end, 'meta');
        if (meta) {
          const ilst = findBox(m, meta.start + 4, meta.end, 'ilst') || findBox(m, meta.start, meta.end, 'ilst');
          if (ilst) for (const it of boxes(m, ilst.start, ilst.end)) if (it.type === '©day') { const d = findBox(m, it.start, it.end, 'data'); if (d) dayStr = new TextDecoder().decode(m.subarray(d.start + 8, d.end)); }
        }
      }
      // מסלול אודיו
      let trak = null;
      for (const t of boxes(m, 0, m.length)) {
        if (t.type !== 'trak') continue;
        const mdia = findBox(m, t.start, t.end, 'mdia'); if (!mdia) continue;
        const hdlr = findBox(m, mdia.start, mdia.end, 'hdlr'); if (!hdlr) continue;
        if (fourcc(m, hdlr.start + 8) === 'soun') { trak = { mdia }; break; }
      }
      if (!trak) throw new Error('לא נמצא מסלול אודיו בקובץ');
      const mdhd = findBox(m, trak.mdia.start, trak.mdia.end, 'mdhd');
      const mv = m[mdhd.start]; const timescale = mv === 1 ? u32(m, mdhd.start + 20) : u32(m, mdhd.start + 12);
      const minf = findBox(m, trak.mdia.start, trak.mdia.end, 'minf'); const stbl = findBox(m, minf.start, minf.end, 'stbl');
      const stsd = findBox(m, stbl.start, stbl.end, 'stsd');
      const entry = { start: stsd.start + 8 + 8, end: stsd.start + 8 + u32(m, stsd.start + 8), type: fourcc(m, stsd.start + 12) };
      const eb = entry.start + 8; // אחרי reserved(6)+data_ref(2)
      const sver = u16(m, eb); const channels = u16(m, eb + 8); const sampleRate = u32(m, eb + 16) >>> 16;
      let codec = null, description = null, oti = null;
      let esds = findBox(m, eb + 20 + (sver === 1 ? 16 : sver === 2 ? 36 : 0), entry.end, 'esds');
      if (!esds) { // חיפוש גס (למשל בתוך wave)
        for (let q = entry.start; q + 8 <= entry.end; q++) if (fourcc(m, q + 4) === 'esds') { esds = { start: q + 8, end: q + u32(m, q) }; break; }
      }
      if (esds) {
        const e = parseEsds(m, esds.start + 4);
        if (e) {
          oti = e.oti;
          if (e.oti === 0x40 || e.oti === 0x66 || e.oti === 0x67 || e.oti === 0x68) {
            let aot = e.asc ? e.asc[0] >> 3 : 2; if (aot === 31 && e.asc) aot = 32 + (((e.asc[0] & 7) << 3) | (e.asc[1] >> 5));
            codec = `mp4a.40.${aot}`; description = e.asc;
          } else if (e.oti === 0x69 || e.oti === 0x6B) codec = 'mp3';
        }
      }
      if (entry.type === 'samr' || entry.type === 'sawb') throw new Error('הקובץ מקודד ב-AMR (3gp), שהדפדפן לא יודע לפענח. המר ל-m4a/mp3/wav או השתמש בכלי הפייתוני עם ffmpeg');
      if (!codec) throw new Error(`קודק לא נתמך בקובץ MP4 (${entry.type}${oti !== null ? ', OTI 0x' + oti.toString(16) : ''})`);
      // טבלאות דגימות
      const stts = findBox(m, stbl.start, stbl.end, 'stts'), stsc = findBox(m, stbl.start, stbl.end, 'stsc'), stsz = findBox(m, stbl.start, stbl.end, 'stsz');
      const stco = findBox(m, stbl.start, stbl.end, 'stco'), co64 = findBox(m, stbl.start, stbl.end, 'co64');
      if (!stts || !stsc || !stsz || !(stco || co64)) throw new Error('טבלאות הדגימות בקובץ חסרות');
      const constSize = u32(m, stsz.start + 4); const n = u32(m, stsz.start + 8);
      const sizes = new Uint32Array(n); for (let i = 0; i < n; i++) sizes[i] = constSize || u32(m, stsz.start + 12 + i * 4);
      const times = new Float64Array(n); const durs = new Float64Array(n);
      { const c = u32(m, stts.start + 4); let k = 0, t = 0; for (let i = 0; i < c && k < n; i++) { const cnt = u32(m, stts.start + 8 + i * 8), d = u32(m, stts.start + 12 + i * 8); for (let j = 0; j < cnt && k < n; j++) { times[k] = t / timescale; durs[k] = d / timescale; t += d; k++; } } this.mediaDuration = t / timescale; }
      const offsets = new Float64Array(n);
      { const cc = stco ? u32(m, stco.start + 4) : u32(m, co64.start + 4); const sc = u32(m, stsc.start + 4);
        const ranges = []; for (let i = 0; i < sc; i++) ranges.push({ first: u32(m, stsc.start + 8 + i * 12), spc: u32(m, stsc.start + 12 + i * 12) });
        let s = 0, ri = 0;
        for (let ci = 1; ci <= cc && s < n; ci++) {
          while (ri + 1 < ranges.length && ranges[ri + 1].first <= ci) ri++;
          let off = stco ? u32(m, stco.start + 8 + (ci - 1) * 4) : u64(m, co64.start + 8 + (ci - 1) * 8);
          for (let j = 0; j < ranges[ri].spc && s < n; j++) { offsets[s] = off; off += sizes[s]; s++; }
        }
        if (s < n) throw new Error('טבלת ה-chunks לא מכסה את כל הדגימות'); }
      this.sizes = sizes; this.times = times; this.offsets = offsets; this.n = n;
      this.config = { codec, sampleRate, numberOfChannels: channels || 1 };
      if (description && description.length) this.config.description = description;
      let dayTime = null; if (dayStr) { const d = new Date(dayStr.trim()); if (!isNaN(d)) dayTime = d.getTime(); }
      this.info = { format: 'mp4', codec, sampleRate, channels, durationSec: this.mediaDuration, creationTime: dayTime || creation, creationSource: dayTime ? 'mp4-day' : creation ? 'mp4-mvhd' : null, packetCount: n };
      await this.checkSupport();
      return this;
    }
    packetCount() { return this.n; }
    async *packetsFrom(i0, i1) {
      let win = null, wStart = 0, wEnd = 0;
      for (let i = i0; i < i1; i++) {
        if (this.cancelled) return;
        const off = this.offsets[i], size = this.sizes[i];
        if (!(off >= wStart && off + size <= wEnd)) {
          wStart = off; wEnd = Math.min(this.file.size, off + Math.max(WINDOW, size));
          win = await readSlice(this.file, wStart, wEnd);
        }
        yield { ts: this.times[i], data: win.subarray(off - wStart, off - wStart + size) };
      }
    }
  }

  // ---------- MP3 ----------
  const MP3_BITRATES = [
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG1 Layer III
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],      // MPEG2/2.5 Layer III
  ];
  const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  function mp3Header(u8, p) {
    if (p + 4 > u8.length || u8[p] !== 0xFF || (u8[p + 1] & 0xE0) !== 0xE0) return null;
    const ver = (u8[p + 1] >> 3) & 3; if (ver === 1) return null;
    const layer = (u8[p + 1] >> 1) & 3; if (layer !== 1) return null; // רק Layer III
    const br = u8[p + 2] >> 4; if (br === 0 || br === 15) return null;
    const sri = (u8[p + 2] >> 2) & 3; if (sri === 3) return null;
    const pad = (u8[p + 2] >> 1) & 1; const mpeg1 = ver === 3;
    const sr = MP3_RATES[ver][sri]; const bitrate = MP3_BITRATES[mpeg1 ? 0 : 1][br] * 1000;
    return { len: Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sr + pad), spf: mpeg1 ? 1152 : 576, sr, channels: ((u8[p + 3] >> 6) & 3) === 3 ? 1 : 2, bitrate, mpeg1 };
  }
  class Mp3Scanner extends PacketScanner {
    async open() {
      const f = this.file; const head = await readSlice(f, 0, Math.min(f.size, 1 << 20));
      let p = 0;
      if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) { // ID3v2
        const sz = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
        p = 10 + sz + ((head[5] & 0x10) ? 10 : 0);
      }
      let h = null;
      for (; p + 4 < head.length; p++) { h = mp3Header(head, p); if (h && (p + h.len + 4 > head.length || mp3Header(head, p + h.len))) break; h = null; }
      if (!h) throw new Error('לא נמצאו פריימים של MP3 בקובץ');
      this.firstFrame = p; this.sr = h.sr; this.spf = h.spf; this.channels = h.channels;
      // הערכת אורך: Xing/Info אם קיים, אחרת לפי קצב הסיביות של הפריים הראשון
      let frames = null; const xo = p + 4 + (h.mpeg1 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17));
      if (xo + 12 <= head.length) { const tag = fourcc(head, xo); if ((tag === 'Xing' || tag === 'Info') && (u32(head, xo + 4) & 1)) frames = u32(head, xo + 8); }
      let est;
      if (frames) est = (frames * h.spf) / h.sr;
      else { // VBR בלי Xing: דגימת קצב הסיביות בכמה נקודות לאורך הקובץ
        let sum = h.bitrate, cnt = 1;
        for (let q = 1; q <= 6; q++) {
          const at = Math.floor(p + ((f.size - p) * q) / 7); const w = await readSlice(f, at, at + 65536);
          for (let o = 0, got = 0; o + 4 < w.length && got < 40; o++) { const hh = mp3Header(w, o); if (hh && hh.sr === h.sr && (o + hh.len + 4 > w.length || mp3Header(w, o + hh.len))) { sum += hh.bitrate; cnt++; got++; o += hh.len - 1; } }
        }
        est = ((f.size - p) * 8) / (sum / cnt);
      }
      this.config = { codec: 'mp3', sampleRate: h.sr, numberOfChannels: h.channels };
      this.info = { format: 'mp3', codec: 'mp3', sampleRate: h.sr, channels: h.channels, durationSec: est, durationEstimated: true, creationTime: null, creationSource: null };
      this.offsetsList = null;
      await this.checkSupport();
      return this;
    }
    packetCount() { return this.offsetsList ? this.offsetsList.length : Math.ceil((this.info.durationSec * this.sr) / this.spf); }
    // מעבר ראשון: סריקה סדרתית של הפריימים תוך בניית טבלת היסטים
    async decodeAll(onSamples, onProgress) {
      const f = this.file; const offsets = []; let carry = new Uint8Array(0); let pos = this.firstFrame; let idx = 0; const self = this;
      const spf = this.spf, sr = this.sr;
      async function* gen() {
        while (pos < f.size) {
          if (self.cancelled) return;
          const chunk = await readSlice(f, pos, pos + WINDOW); pos += chunk.length;
          let buf = carry.length ? (() => { const b = new Uint8Array(carry.length + chunk.length); b.set(carry); b.set(chunk, carry.length); return b; })() : chunk;
          const base = pos - buf.length; let q = 0;
          while (q + 4 <= buf.length) {
            const h = mp3Header(buf, q);
            if (!h || h.sr !== sr) { q++; continue; }
            if (q + h.len > buf.length) { if (pos >= f.size) { q = buf.length; } break; }
            offsets.push(base + q);
            yield { ts: (idx * spf) / sr, data: buf.subarray(q, q + h.len) };
            idx++; q += h.len;
          }
          carry = buf.subarray(q);
          if (onProgress) onProgress(pos / f.size);
        }
      }
      await decodePackets(this.config, gen(), (data) => {
        const r = data.sampleRate; onSamples(audioDataToMono(data), Math.round((data.timestamp / 1e6) * r), r);
      }, () => this.cancelled);
      this.offsetsList = Float64Array.from(offsets);
      this.times = new Float64Array(offsets.length); for (let i = 0; i < offsets.length; i++) this.times[i] = (i * spf) / sr;
      this.info.durationSec = (offsets.length * spf) / sr; this.info.durationEstimated = false;
      if (onProgress) onProgress(1);
    }
    async *packetsFrom(i0, i1) {
      if (!this.offsetsList) throw new Error('יש לסרוק את הקובץ לפני חילוץ');
      let win = null, wStart = 0, wEnd = 0;
      for (let i = i0; i < i1; i++) {
        const off = this.offsetsList[i]; const end = i + 1 < this.offsetsList.length ? this.offsetsList[i + 1] : this.file.size;
        if (!(off >= wStart && end <= wEnd)) { wStart = off; wEnd = Math.min(this.file.size, off + WINDOW); win = await readSlice(this.file, wStart, wEnd); }
        yield { ts: this.times[i], data: win.subarray(off - wStart, end - wStart) };
      }
    }
  }

  // ---------- סורק על AudioBuffer שפוענח כולו (נתיב חלופי בדף הראשי) ----------
  class DecodedScanner extends BaseScanner {
    constructor(file, audioBuffer) { super(file); this.buffer = audioBuffer; this.outRate = audioBuffer.sampleRate; this.info = { format: 'decoded', codec: 'decodeAudioData', sampleRate: audioBuffer.sampleRate, channels: audioBuffer.numberOfChannels, durationSec: audioBuffer.duration, creationTime: null, creationSource: null, supported: true }; }
    mono() {
      if (this._mono) return this._mono;
      const b = this.buffer, n = b.length, ch = b.numberOfChannels; const out = new Float32Array(n);
      for (let c = 0; c < ch; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i]; }
      if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
      return (this._mono = out);
    }
    async decodeAll(onSamples, onProgress) {
      const m = this.mono(); const step = this.outRate * 30;
      for (let i = 0; i < m.length; i += step) { if (this.cancelled) return; onSamples(m.subarray(i, Math.min(m.length, i + step)), i, this.outRate); if (onProgress) onProgress(Math.min(1, (i + step) / m.length)); await yieldNow(); }
    }
    async extract(t0, t1) {
      const sr = this.outRate; const s0 = Math.max(0, Math.round(t0 * sr)), n = Math.max(0, Math.round((t1 - t0) * sr)); const out = new Float32Array(n);
      const m = this.mono(); out.set(m.subarray(s0, Math.min(m.length, s0 + n))); return out;
    }
  }


  // ---------- סיווג גס של קליפ ----------
  // מחלק את הקטע הרועש למקטעים (לפי הפסקות שקט), ומסווג כל מקטע לפי מאפיינים אקוסטיים פשוטים:
  //   דפיקה  – שיא בולט שנעלם תוך 200ms, או התקפה מיידית (< 30ms) ודעיכה לאורך המקטע; גם כשהיא רק 10 dB מעל הרקע
  //   נשימה  – עלייה איטית, איוושה בתדרים גבוהים, כמעט בלי תדרים נמוכים, לא קולי
  //   רעש רציף (גרירה וכד') – מתמשך בלי דעיכה
  //   דיבור  – מחזוריות עם גובה צליל משתנה והברות (נמדד על כל הקליפ)
  // התוצאה היא רמז לסקירה, לא זיהוי ודאי.
  function classify(samples, sr) {
    const factor = Math.max(1, Math.round(sr / 8000)); const r = sr / factor;
    const n = Math.floor(samples.length / factor);
    const empty = { kind: 'unknown', loudSec: 0, voicedFrac: 0, crestDb: 0, pitchVar: 0, onsets: 0, segments: [] };
    if (n < r * 0.1) return empty;
    const x = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) { let acc = 0; const o = i * factor; for (let k = 0; k < factor; k++) acc += samples[o + k]; x[i] = acc / factor; mean += x[i]; }
    mean /= n; for (let i = 0; i < n; i++) x[i] -= mean;
    const lo = new Biquad('lowpass', LOW_BAND_HZ, r).run(x); new Biquad('lowpass', LOW_BAND_HZ, r).run(lo, lo);
    const hi = new Biquad('highpass', 2000, r).run(x); new Biquad('highpass', 2000, r).run(hi, hi);
    const frame = Math.round(r * 0.03), hop = Math.round(r * 0.01);
    const nf = Math.max(0, Math.floor((n - frame) / hop) + 1);
    if (nf < 3) return empty;
    const rms = new Float32Array(nf), eLo = new Float32Array(nf), eHi = new Float32Array(nf);
    let peakRms = 0, peakAbs = 0;
    for (let f = 0; f < nf; f++) {
      let a = 0, b = 0, c = 0; const o = f * hop;
      for (let i = 0; i < frame; i++) { const v = x[o + i]; a += v * v; const w = lo[o + i]; b += w * w; const u = hi[o + i]; c += u * u; }
      rms[f] = Math.sqrt(a / frame); eLo[f] = b / frame; eHi[f] = c / frame; if (rms[f] > peakRms) peakRms = rms[f];
    }
    for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); if (a > peakAbs) peakAbs = a; }
    // רמת הרקע של הקליפ (אחוזון 20 של הפריימים; הקליפ כולל שקט לפני הרעש ואחריו) וסף המקטעים:
    // 20 dB מתחת לשיא, אבל לא מתחת לרקע + 6 dB, אחרת דפיקה שקטה (10–15 dB מעל הרקע) נבלעת ברקע וכל הקליפ
    // נראה כמקטע אחד ארוך ("רעש רציף"); ולא מעל שיא − 6 dB, כדי שרעש ממושך שממלא את הקליפ יישאר מקטע אחד.
    const sorted = Float32Array.from(rms).sort(); const floorRms = sorted[Math.floor(nf * 0.2)];
    const gate = Math.max(peakRms * 0.1, Math.min(floorRms * 2, peakRms * 0.5));
    // מעטפת "מעל הרקע": מה שנשאר אחרי הפחתת אנרגיית הרקע. מדדי הצורה (התקפה, דעיכה) נמדדים עליה, כך שגם
    // דפיקה שקטה נראית כמו דפיקה ולא כמו גבעה נמוכה על רקע גבוה.
    const floorSq = floorRms * floorRms;
    const ex = new Float32Array(nf); for (let f = 0; f < nf; f++) ex[f] = Math.sqrt(Math.max(rms[f] * rms[f] - floorSq, 0));
    // מקטעים רועשים; הפסקות קצרות מ-150ms לא מפרידות
    const segs = []; let cur = null, quiet = 0, rawOnsets = 0, prevLoud = false;
    for (let f = 0; f < nf; f++) {
      const isLoud = rms[f] >= gate;
      if (isLoud && !prevLoud) rawOnsets++;
      prevLoud = isLoud;
      if (isLoud) { if (!cur) cur = { a: f, b: f }; cur.b = f; quiet = 0; }
      else if (cur) { quiet++; if (quiet > 15) { segs.push(cur); cur = null; quiet = 0; } }
    }
    if (cur) segs.push(cur);
    const minLag = Math.round(r / 400), maxLag = Math.round(r / 80); // גובה צליל 80–400 Hz
    let loud = 0, voiced = 0, sumLoudRms = 0; const lags = [];
    const voicedOf = (f) => {
      const o = f * hop; let best = 0, bestLag = 0, e0 = 0;
      for (let i = 0; i < frame; i++) e0 += x[o + i] * x[o + i];
      for (let lag = minLag; lag <= maxLag; lag++) {
        let c = 0, e1 = 0;
        for (let i = 0, m = frame - lag; i < m; i++) { c += x[o + i] * x[o + i + lag]; e1 += x[o + i + lag] * x[o + i + lag]; }
        const v = c / Math.sqrt((e0 + 1e-12) * (e1 + 1e-12));
        if (v > best) { best = v; bestLag = lag; }
      }
      return { best, bestLag };
    };
    const segments = [];
    for (const sg of segs) {
      const len = sg.b - sg.a + 1; let peakF = sg.a, segPeak = 0, sumEx = 0, sLo = 0, sAll = 0, sHi = 0, segVoiced = 0;
      for (let f = sg.a; f <= sg.b; f++) {
        if (rms[f] > segPeak) { segPeak = rms[f]; peakF = f; }
        sumEx += ex[f]; sLo += eLo[f]; sHi += eHi[f]; sAll += rms[f] * rms[f];
        if (rms[f] >= gate) { loud++; sumLoudRms += rms[f]; const v = voicedOf(f); if (v.best >= 0.6) { voiced++; segVoiced++; lags.push(v.bestLag); } }
      }
      const third = Math.max(1, Math.floor(len / 3));
      let first = 0, mid = 0, last = 0;
      for (let f = sg.a; f < sg.a + third; f++) first += ex[f];
      for (let f = sg.a + third; f < sg.a + 2 * third; f++) mid += ex[f];
      for (let f = sg.b - third + 1; f <= sg.b; f++) last += ex[f];
      const attackFrames = peakF - sg.a; const decayRatio = last / Math.max(first, 1e-9);
      const hump = mid / Math.max((first + last) / 2, 1e-9); // מעטפת "גבעה" (עלייה ואז ירידה) לעומת מעטפת שטוחה
      // כמה נשאר מהשיא 150–200 אלפיות שנייה אחריו (גם מעבר לסוף המקטע): דפיקה יורדת מתחת ל-45%, גרירה נשארת.
      // מקטע קצר של דפיקה שקטה נגמר קרוב לשיא, ולכן decayRatio (שליש אחרון מול שליש ראשון) לא מספיק שם.
      const peakEx = ex[peakF]; let after = 0, na = 0;
      for (let f = peakF + 15; f <= Math.min(nf - 1, peakF + 20); f++) { after += ex[f]; na++; }
      const decay200 = na ? after / na / Math.max(peakEx, 1e-9) : 0;
      const impulseDb = 20 * Math.log10((peakEx + 1e-9) / (sumEx / len + 1e-9)); // כמה השיא בולט מעל ממוצע המקטע
      const lfRatio = sLo / Math.max(sAll, 1e-12), hfRatio = sHi / Math.max(sAll, 1e-12);
      const dur = (len * hop) / r; const vFrac = segVoiced / len;
      let kind;
      // דפיקה: או התקפה מיידית ודעיכה לאורך המקטע (דפיקה שמהדהדת), או שיא בולט שנעלם תוך 200ms
      // (דפיקה קצרה, גם שקטה; אם ההתקפה איטית מ-100ms דורשים שיא בולט יותר, כדי לא לתפוס גבעות של גרירה)
      if (dur <= 1.5 && ((attackFrames <= 3 && decayRatio < 0.35) || (decay200 <= 0.45 && impulseDb >= (attackFrames <= 10 ? 3 : 6)))) kind = 'bang';
      else if (dur >= 0.3 && dur <= 4 && attackFrames >= 5 && lfRatio < 0.2 && hfRatio > 0.1 && hump >= 1.4 && vFrac < 0.3) kind = 'breath';
      else if (dur < 0.25) continue; // בליטה קצרה שרק חצתה את הסף: לא דפיקה ולא רעש רציף, לא נספרת
      else kind = 'drag';
      segments.push({ kind, sec: (sg.a * hop) / r, dur: Math.round(dur * 100) / 100, attackMs: Math.round((attackFrames * hop * 1000) / r), decayRatio: Math.round(decayRatio * 100) / 100, decay200: Math.round(decay200 * 100) / 100, impulseDb: Math.round(impulseDb * 10) / 10, hump: Math.round(hump * 100) / 100, lfRatio: Math.round(lfRatio * 100) / 100, hfRatio: Math.round(hfRatio * 100) / 100 });
    }
    const loudSec = (loud * hop) / r;
    const voicedFrac = loud ? voiced / loud : 0;
    const crestDb = 20 * Math.log10((peakAbs + 1e-9) / (sumLoudRms / Math.max(1, loud) + 1e-9));
    let pitchVar = 0;
    if (lags.length >= 5) { const m = lags.reduce((a, b) => a + b, 0) / lags.length; const v = lags.reduce((a, b) => a + (b - m) * (b - m), 0) / lags.length; pitchVar = Math.sqrt(v) / m; }
    const onsets = rawOnsets;
    let kind;
    const bangs = segments.filter((g) => g.kind === 'bang').length, drags = segments.filter((g) => g.kind === 'drag').length, breaths = segments.filter((g) => g.kind === 'breath').length;
    const breathSec = segments.filter((g) => g.kind === 'breath').reduce((a, g) => a + g.dur, 0), totalSec = segments.reduce((a, g) => a + g.dur, 0);
    if (voicedFrac >= 0.35 && loudSec >= 0.4 && pitchVar >= 0.06 && onsets >= 2) kind = 'speech';
    else if (bangs && drags) kind = 'bangdrag';
    else if (bangs) kind = 'bang';
    else if (breaths && breathSec >= 0.7 * totalSec) kind = 'breath';
    else kind = 'noise';
    return { kind, loudSec, voicedFrac, crestDb, pitchVar, onsets, segments };
  }

  // ---------- רעש מחזורי (נשימות): רצף אירועים במרווחים קבועים ----------
  // מסמן rhythmic=true על אירועים שנמצאים בתוך רצף של 6+ אירועים במרווחים סדירים (1.5–8 שניות, סטייה < 30%).
  function markRhythmic(list) {
    const items = list.map((e, i) => ({ i, t: e.noiseSec, dur: e.endSec - e.startSec, peak: e.peakDb, kind: e.kind })).sort((a, b) => a.t - b.t);
    const flagged = new Set();
    const W = 6;
    for (let k = 0; k + W <= items.length; k++) {
      const win = items.slice(k, k + W);
      if (win.some((w) => w.dur > 12 || w.kind === 'bang' || w.kind === 'bangdrag' || w.kind === 'speech')) continue;
      const peaks = win.map((w) => w.peak).filter((v) => typeof v === 'number');
      if (peaks.length && Math.max(...peaks) - Math.min(...peaks) > 10) continue; // רמות דומות, כמו נשימות; דפיקה חזקה באמצע שוברת את הרצף
      const iv = []; for (let j = 1; j < W; j++) iv.push(win[j].t - win[j - 1].t);
      const m = iv.reduce((a, b) => a + b, 0) / iv.length;
      if (m < 1.5 || m > 8) continue;
      const sd = Math.sqrt(iv.reduce((a, b) => a + (b - m) * (b - m), 0) / iv.length);
      if (sd / m < 0.3) for (const w of win) flagged.add(w.i);
    }
    list.forEach((e, i) => { e.rhythmic = flagged.has(i); });
    return flagged.size;
  }

  // ---------- איחוד אירועים צמודים ----------
  // הזיהוי סוגר אירוע אחרי זנב של שקט, ואירוע חדש מקבל pre-roll. כשהרעש הבא מגיע לפני שנגמרו הזנב וה-pre-roll,
  // הקליפים צמודים (השני מתחיל בדיוק איפה שהראשון נגמר) והם בעצם אפיזודה אחת: סדרת דפיקות, דפיקה וגרירה אחריה,
  // דפיקות ואז כיסא שנטרק. מאחדים אותם לאירוע אחד, חוץ מנשימות, דיבור ורעש מחזורי (שם ההפרדה היא המידע),
  // ובלי לעבור את אורך הקליפ המרבי. list: אירועי הסקירה אחרי הסיווג (startSec/endSec/kind/cls/rhythmic).
  function mergedKind(a, b) {
    const bangs = [a, b].filter((e) => e.kind === 'bang' || e.kind === 'bangdrag').length;
    const drags = [a, b].filter((e) => e.kind === 'noise' || e.kind === 'bangdrag').length;
    return bangs && drags ? 'bangdrag' : bangs ? 'bang' : drags ? 'noise' : (a.kind || b.kind || 'unknown');
  }
  function keepsApart(e) { return e.kind === 'breath' || e.kind === 'speech' || !!e.rhythmic; }
  function mergeTwo(a, b) {
    const da = a.endSec - a.startSec, db = b.endSec - b.startSec, kind = mergedKind(a, b);
    const shift = (g) => Object.assign({}, g, { sec: Math.round((g.sec + b.startSec - a.startSec) * 100) / 100 });
    const segments = [...((a.cls && a.cls.segments) || []), ...((b.cls && b.cls.segments) || []).map(shift)];
    const cls = Object.assign({}, a.cls || {}, { kind, segments, loudSec: ((a.cls && a.cls.loudSec) || 0) + ((b.cls && b.cls.loudSec) || 0) });
    const avgDb = 10 * Math.log10((da * Math.pow(10, a.avgDb / 10) + db * Math.pow(10, b.avgDb / 10)) / Math.max(da + db, 1e-9));
    return Object.assign({}, a, { endSec: b.endSec, peakDb: Math.max(a.peakDb, b.peakDb), avgDb, truncated: !!b.truncated, kind, cls, merged: (a.merged || 1) + (b.merged || 1), selected: a.selected !== false && b.selected !== false });
  }
  function mergeAdjacent(list, opts) {
    const maxClip = (opts && opts.maxClip) || Infinity;
    const out = [];
    for (const e of list.slice().sort((x, y) => x.startSec - y.startSec)) {
      const p = out[out.length - 1];
      if (p && !p.truncated && !keepsApart(p) && !keepsApart(e) && e.startSec - p.endSec <= FRAME_SEC / 2 && e.endSec - p.startSec <= maxClip + FRAME_SEC / 2) { out[out.length - 1] = mergeTwo(p, e); continue; }
      out.push(e);
    }
    return out;
  }

  async function open(file) {
    const kind = await sniff(file);
    if (kind === 'wav') return new WavScanner(file).open();
    if (kind === 'mp4') return new Mp4Scanner(file).open();
    if (kind === 'mp3') return new Mp3Scanner(file).open();
    const s = { info: { format: kind, supported: false, reason: kind === 'amr' ? 'קובץ AMR/3GP: הדפדפן לא יודע לפענח. המר ל-m4a/mp3/wav או השתמש בכלי הפייתוני עם ffmpeg' : `פורמט ${kind} לא נתמך בסריקה בזרימה. ננסה פענוח מלא בזיכרון (מתאים רק לקבצים קטנים)`, creationTime: null, creationSource: null, durationSec: null, needsFullDecode: kind !== 'amr' } };
    return s;
  }

  // הצעת זמן התחלה: מחזיר רשימת מועמדים לפי סדר עדיפות
  function startCandidates(file, info) {
    const c = [];
    const dur = info.durationSec || 0;
    if (info.creationSource === 'mp4-day' && info.creationTime) c.push({ time: info.creationTime, source: 'תאריך היצירה בקובץ (©day)' });
    const fromName = dateFromName(file.name || '');
    if (fromName) c.push({ time: fromName.getTime(), source: 'שם הקובץ' });
    if (info.creationTime && info.creationSource !== 'mp4-day') {
      const lm = file.lastModified || 0;
      const looksLikeEnd = dur > 120 && Math.abs(lm - info.creationTime) < 180000;
      if (looksLikeEnd) { c.push({ time: info.creationTime - dur * 1000, source: 'זמן היצירה בקובץ נראה כזמן סיום, פחות אורך ההקלטה' }); c.push({ time: info.creationTime, source: 'זמן היצירה בקובץ (אם הוא זמן ההתחלה)' }); }
      else { c.push({ time: info.creationTime, source: 'זמן היצירה במטא-דאטה של הקובץ' }); if (dur > 0) c.push({ time: info.creationTime - dur * 1000, source: 'זמן היצירה פחות אורך (אם המטא-דאטה מציין את הסיום)' }); }
    }
    if (file.lastModified && dur > 0) c.push({ time: file.lastModified - dur * 1000, source: 'זמן השינוי של הקובץ פחות אורך ההקלטה (הערכה)' });
    else if (file.lastModified) c.push({ time: file.lastModified, source: 'זמן השינוי של הקובץ (לא מדויק)' });
    return c;
  }

  root.NoiseScan = { open, sniff, detectFromLevels, median, startCandidates, dateFromName, classify, markRhythmic, mergeAdjacent, mergedKind, keepsApart, Biquad, LOW_BAND_HZ, DecodedScanner, FRAME_SEC, LevelAccumulator, mp3Header, parseEsds };
})(typeof self !== 'undefined' ? self : globalThis);
