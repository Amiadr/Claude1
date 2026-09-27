// Web Worker: מריץ את סריקת הקובץ ברקע כדי שהממשק יישאר מגיב.
importScripts('scan.js');
let scanner = null;
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'open') {
      scanner = await NoiseScan.open(m.file);
      postMessage({ type: 'opened', info: scanner.info });
    } else if (m.type === 'scan') {
      const r = await scanner.scanLevels((f) => postMessage({ type: 'progress', fraction: f }));
      if (!r) { postMessage({ type: 'cancelled' }); return; }
      postMessage({ type: 'levels', levels: r.levels, frameSec: r.frameSec, sampleRate: r.sampleRate, durationSec: r.durationSec, floorDb: r.floorDb, info: scanner.info }, [r.levels.buffer]);
    } else if (m.type === 'extract') {
      for (const rg of m.ranges) {
        const samples = await scanner.extract(rg.t0, rg.t1);
        postMessage({ type: 'clip', id: rg.id, samples, sampleRate: scanner.outRate || scanner.info.sampleRate }, [samples.buffer]);
      }
      postMessage({ type: 'extracted' });
    } else if (m.type === 'cancel') {
      if (scanner && scanner.cancel) scanner.cancel();
    }
  } catch (err) {
    postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
