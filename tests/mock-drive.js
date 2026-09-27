// הדמיה מקומית של Google Drive REST v3 (התת-קבוצה שהאפליקציה משתמשת בה), לבדיקות בלי חשבון גוגל.
// תומך ב: files.list עם q, files.create (מטא-דאטה / resumable), files.get (מטא-דאטה / alt=media), files.update (resumable), files.delete, userinfo.
const http = require('http');
const { URL } = require('url');

function startMockDrive(port) {
  const files = new Map(); // id → { id, name, mimeType, parents, appProperties, description, trashed, content(Buffer), modifiedTime }
  const sessions = new Map(); // sid → { id (existing) | meta }
  let seq = 0;
  const newId = () => 'f' + (++seq).toString(36).padStart(6, '0');
  const meta = (f, fields) => {
    const all = { id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, appProperties: f.appProperties, description: f.description, trashed: f.trashed, size: String(f.content ? f.content.length : 0), modifiedTime: f.modifiedTime };
    return all;
  };
  function matchQ(q, f) {
    // תמיכה במחרוזות בסגנון: name = 'x' and mimeType = 'y' and 'id' in parents and trashed = false and appProperties has { key='k' and value='v' }
    const clauses = []; let rest = q;
    const re = /\s*(?:name = '((?:[^'\\]|\\.)*)'|mimeType = '([^']*)'|'([^']*)' in parents|trashed = (true|false)|appProperties has \{ key='([^']*)' and value='((?:[^'\\]|\\.)*)' \}|mimeType != '([^']*)')\s*(?:and)?/y;
    let pos = 0;
    while (pos < rest.length) {
      re.lastIndex = pos; const m = re.exec(rest);
      if (!m || !m[0].length) throw new Error('mock drive: unsupported query: ' + q);
      clauses.push(m); pos = re.lastIndex;
    }
    const unesc = (s) => s.replace(/\\(.)/g, '$1');
    for (const c of clauses) {
      if (c[1] !== undefined && f.name !== unesc(c[1])) return false;
      if (c[2] !== undefined && f.mimeType !== c[2]) return false;
      if (c[3] !== undefined && !(f.parents || []).includes(c[3])) return false;
      if (c[4] !== undefined && f.trashed !== (c[4] === 'true')) return false;
      if (c[5] !== undefined && (!f.appProperties || f.appProperties[c[5]] !== unesc(c[6]))) return false;
      if (c[7] !== undefined && f.mimeType === c[7]) return false;
    }
    return true;
  }
  const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
  const log = [];
  const server = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Upload-Content-Type,X-Upload-Content-Length', 'Access-Control-Expose-Headers': 'Location' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (code, obj, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, cors, extra || {})); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    log.push(req.method + ' ' + u.pathname + u.search);
    if (u.pathname === '/__state') return send(200, { files: Array.from(files.values()).map((f) => Object.assign(meta(f), { text: f.content && /json|csv|text/.test(f.mimeType) ? f.content.toString('utf8') : undefined })), log });
    if (u.pathname === '/__reset') { files.clear(); sessions.clear(); log.length = 0; return send(200, {}); }
    if (!/^Bearer test-token/.test(req.headers.authorization || '') && !u.pathname.startsWith('/upload/session/')) return send(401, { error: { message: 'Invalid Credentials' } });
    if (u.pathname === '/oauth2/v3/userinfo') return send(200, { email: 'test@example.com' });
    const body = await readBody(req);
    let m;
    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const out = Array.from(files.values()).filter((f) => matchQ(q, f)).map((f) => meta(f));
      return send(200, { files: out });
    }
    if (u.pathname === '/drive/v3/files' && req.method === 'POST') {
      const j = JSON.parse(body.toString() || '{}'); const f = { id: newId(), name: j.name, mimeType: j.mimeType || 'application/octet-stream', parents: j.parents || ['root'], appProperties: j.appProperties, description: j.description, trashed: false, content: Buffer.alloc(0), modifiedTime: new Date().toISOString() };
      files.set(f.id, f); return send(200, meta(f));
    }
    if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      const j = JSON.parse(body.toString() || '{}'); const sid = 's' + (++seq); sessions.set(sid, { meta: j });
      return send(200, undefined, { Location: `http://127.0.0.1:${port}/upload/session/${sid}` });
    }
    if ((m = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/)) && req.method === 'PATCH') {
      if (!files.has(m[1])) return send(404, { error: { message: 'File not found' } });
      const j = JSON.parse(body.toString() || '{}'); const sid = 's' + (++seq); sessions.set(sid, { id: m[1], meta: j });
      return send(200, undefined, { Location: `http://127.0.0.1:${port}/upload/session/${sid}` });
    }
    if ((m = u.pathname.match(/^\/upload\/session\/(.+)$/)) && req.method === 'PUT') {
      const s = sessions.get(m[1]); if (!s) return send(404, { error: { message: 'no session' } });
      let f;
      if (s.id) { f = files.get(s.id); Object.assign(f, s.meta.name ? { name: s.meta.name } : {}); }
      else { f = { id: newId(), name: s.meta.name, parents: s.meta.parents || ['root'], appProperties: s.meta.appProperties, description: s.meta.description, trashed: false }; files.set(f.id, f); }
      f.mimeType = s.meta.mimeType || req.headers['content-type'] || 'application/octet-stream'; f.content = body; f.modifiedTime = new Date().toISOString();
      sessions.delete(m[1]);
      return send(200, meta(f));
    }
    if ((m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/))) {
      const f = files.get(m[1]); if (!f || f.trashed) return send(404, { error: { message: 'File not found: ' + m[1] } });
      if (req.method === 'GET' && u.searchParams.get('alt') === 'media') { res.writeHead(200, Object.assign({ 'Content-Type': f.mimeType }, cors)); return res.end(f.content); }
      if (req.method === 'GET') return send(200, meta(f));
      if (req.method === 'DELETE') { files.delete(f.id); res.writeHead(204, cors); return res.end(); }
      if (req.method === 'PATCH') {
        const j = JSON.parse(body.toString() || '{}');
        if (j.name) f.name = j.name; if (j.appProperties) f.appProperties = Object.assign({}, f.appProperties, j.appProperties); if (j.description !== undefined) f.description = j.description;
        const add = u.searchParams.get('addParents'), rm = u.searchParams.get('removeParents');
        if (rm) f.parents = (f.parents || []).filter((p) => p !== rm);
        if (add) f.parents = (f.parents || []).concat([add]);
        f.modifiedTime = new Date().toISOString();
        return send(200, meta(f));
      }
    }
    send(404, { error: { message: 'mock: unhandled ' + req.method + ' ' + u.pathname } });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, files, log })));
}
module.exports = { startMockDrive };
if (require.main === module) startMockDrive(Number(process.argv[2] || 8767)).then(() => console.log('mock drive listening'));
