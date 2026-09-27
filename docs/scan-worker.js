// Web Worker: מריץ את סריקת הקובץ, חילוץ הקליפים והסיווג ברקע כדי שהממשק יישאר מגיב.
// כל בקשה נושאת reqId, וכל התשובות אליה מחזירות אותו.
importScripts('scan.js');
let scanner = null;
self.onmessage = async (e) => {
  const m = e.data;
  const post = (msg, transfer) => postMessage(Object.assign({ reqId: m.reqId }, msg), transfer || []);
  const rate = () => (scanner.outRate || scanner.info.sampleRate);
  try {
    if (m.type === 'open') {
      scanner = await NoiseScan.open(m.file);
      post({ type: 'opened', info: scanner.info });
    } else if (m.type === 'scan') {
      const r = await scanner.scanLevels((f) => post({ type: 'progress', fraction: f }));
      if (!r) { post({ type: 'error', message: 'הסריקה בוטלה' }); return; }
      post({ type: 'levels', levels: r.levels, frameSec: r.frameSec, sampleRate: r.sampleRate, durationSec: r.durationSec, floorDb: r.floorDb, info: scanner.info }, [r.levels.buffer]);
    } else if (m.type === 'extract') {
      for (const rg of m.ranges) {
        const samples = await scanner.extract(rg.t0, rg.t1);
        post({ type: 'clip', id: rg.id, samples, sampleRate: rate() }, [samples.buffer]);
      }
      post({ type: 'extracted' });
    } else if (m.type === 'analyze') {
      const results = [];
      for (let i = 0; i < m.ranges.length; i++) {
        const rg = m.ranges[i];
        const samples = await scanner.extract(rg.t0, rg.t1);
        results.push(NoiseScan.classify(samples, rate()));
        if (i % 3 === 2 || i === m.ranges.length - 1) post({ type: 'progress', fraction: (i + 1) / m.ranges.length });
      }
      post({ type: 'analyzed', results });
    } else if (m.type === 'cancel') {
      if (scanner && scanner.cancel) scanner.cancel();
    }
  } catch (err) {
    post({ type: 'error', message: String((err && err.message) || err) });
  }
};
