/* drive.js – חיבור ל-Google Drive מהדפדפן: OAuth (Google Identity Services, token flow) + Drive REST v3.
   ההרשאה drive.file: האפליקציה רואה רק קבצים שהיא עצמה יצרה. */
'use strict';
(function (root) {
  const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
  const state = { apiBase: 'https://www.googleapis.com', clientId: '', token: null, expiresAt: 0, email: '', tokenClient: null, testToken: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function configure(opts) { Object.assign(state, opts); }
  function isConnected() { return !!state.token && Date.now() < state.expiresAt; }
  function restore() {
    try { const j = JSON.parse(sessionStorage.getItem('noise-log-gtoken') || 'null'); if (j && j.token && j.expiresAt > Date.now()) { state.token = j.token; state.expiresAt = j.expiresAt; state.email = j.email || ''; } } catch (e) { /* ignore */ }
    return isConnected();
  }
  function persist() { try { sessionStorage.setItem('noise-log-gtoken', JSON.stringify({ token: state.token, expiresAt: state.expiresAt, email: state.email })); } catch (e) { /* ignore */ } }

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (root.google && root.google.accounts && root.google.accounts.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => (root.google && root.google.accounts ? resolve() : reject(new Error('ספריית ההתחברות של גוגל נטענה חלקית')));
      s.onerror = () => reject(new Error('לא ניתן לטעון את ספריית ההתחברות של גוגל. יש חיבור לאינטרנט?'));
      document.head.appendChild(s);
    });
  }

  async function signIn(interactive) {
    if (state.testToken) { state.token = state.testToken; state.expiresAt = Date.now() + 3600e3; return state.token; }
    if (!state.clientId) throw new Error('חסר Google Client ID. הזן אותו בכרטיס Google Drive (ההוראות ב-README).');
    await loadGis();
    if (!state.tokenClient || state.tokenClient._cid !== state.clientId) {
      state.tokenClient = google.accounts.oauth2.initTokenClient({ client_id: state.clientId, scope: SCOPES, callback: () => {} });
      state.tokenClient._cid = state.clientId;
    }
    const resp = await new Promise((resolve, reject) => {
      state.tokenClient.callback = (r) => (r && r.access_token ? resolve(r) : reject(new Error((r && (r.error_description || r.error)) || 'ההתחברות נכשלה')));
      state.tokenClient.error_callback = (e) => reject(new Error(e && e.type === 'popup_closed' ? 'חלון ההתחברות נסגר לפני שההתחברות הושלמה' : e && e.type === 'popup_failed_to_open' ? 'הדפדפן חסם את חלון ההתחברות. אפשר חלונות קופצים לאתר ונסה שוב' : (e && e.message) || 'ההתחברות נכשלה'));
      state.tokenClient.requestAccessToken({ prompt: interactive ? 'select_account' : '' });
    });
    state.token = resp.access_token;
    state.expiresAt = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
    persist();
    return state.token;
  }
  function signOut() {
    const t = state.token;
    state.token = null; state.expiresAt = 0; state.email = '';
    try { sessionStorage.removeItem('noise-log-gtoken'); } catch (e) { /* ignore */ }
    if (t && root.google && root.google.accounts && root.google.accounts.oauth2) { try { root.google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ } }
  }
  async function ensureToken() { if (isConnected()) return state.token; return signIn(false); }

  async function api(path, opts, retries) {
    opts = opts || {}; retries = retries === undefined ? 2 : retries;
    const token = await ensureToken();
    const headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
    let res;
    try { res = await fetch(state.apiBase + path, Object.assign({}, opts, { headers })); }
    catch (e) { throw new Error('אין חיבור ל-Google Drive (' + e.message + ')'); }
    if (res.status === 401 && retries > 0) { state.token = null; await signIn(false); return api(path, opts, retries - 1); }
    if ((res.status === 429 || res.status >= 500) && retries > 0) { await sleep(1500); return api(path, opts, retries - 1); }
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (e) { /* ignore */ }
      if (res.status === 403 && /quota|storage/i.test(msg)) msg = 'אין מקום פנוי ב-Drive';
      throw new Error(`Drive ${res.status}: ${msg}`);
    }
    return res;
  }
  async function getEmail() {
    if (state.email) return state.email;
    try { const r = await api('/oauth2/v3/userinfo'); const j = await r.json(); state.email = j.email || ''; persist(); } catch (e) { state.email = ''; }
    return state.email;
  }

  const enc = encodeURIComponent;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function list(query, fields) {
    fields = fields || 'files(id,name,mimeType,size,modifiedTime,appProperties,parents)';
    const files = []; let pageToken = '';
    do {
      const res = await api(`/drive/v3/files?q=${enc(query)}&fields=${enc('nextPageToken,' + fields)}&pageSize=200&spaces=drive${pageToken ? '&pageToken=' + enc(pageToken) : ''}`);
      const j = await res.json(); files.push(...(j.files || [])); pageToken = j.nextPageToken || '';
    } while (pageToken);
    return files;
  }
  async function getMeta(fileId, fields) {
    const res = await api(`/drive/v3/files/${fileId}?fields=${enc(fields || 'id,name,trashed,size,modifiedTime,appProperties')}`);
    return res.json();
  }
  async function ensureFolder(name, parentId) {
    const found = await list(`name = '${esc(name)}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId || 'root'}' in parents and trashed = false`, 'files(id,name)');
    if (found.length) return found[0].id;
    const res = await api('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined }) });
    return (await res.json()).id;
  }
  // העלאה (resumable): שתי בקשות, מתאים לכל גודל
  async function upload(meta, blob, existingId) {
    const fields = 'id,name,size,modifiedTime,appProperties';
    const path = existingId ? `/upload/drive/v3/files/${existingId}?uploadType=resumable&fields=${fields}` : `/upload/drive/v3/files?uploadType=resumable&fields=${fields}`;
    const type = blob.type || 'application/octet-stream';
    const init = await api(path, { method: existingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) }, body: JSON.stringify(meta || {}) });
    const loc = init.headers.get('Location');
    if (!loc) throw new Error('Drive: לא התקבלה כתובת העלאה');
    let put;
    try { put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': type, Authorization: 'Bearer ' + state.token }, body: blob }); }
    catch (e) { throw new Error('ההעלאה נקטעה (' + e.message + ')'); }
    if (!put.ok) throw new Error(`Drive: ההעלאה נכשלה (${put.status})`);
    return put.json();
  }
  async function download(fileId) { const res = await api(`/drive/v3/files/${fileId}?alt=media`); return res.blob(); }
  async function getJson(fileId) { const res = await api(`/drive/v3/files/${fileId}?alt=media`); return res.json(); }
  async function del(fileId) { try { await api(`/drive/v3/files/${fileId}`, { method: 'DELETE' }, 1); } catch (e) { if (!/Drive 404/.test(e.message)) throw e; } }

  root.DriveClient = { configure, state, isConnected, restore, signIn, signOut, getEmail, api, list, getMeta, ensureFolder, upload, download, getJson, del, esc };
})(typeof self !== 'undefined' ? self : globalThis);
