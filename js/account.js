// bStoreX account. Signed out, the page is the landing page. Signed in with bWalletX, it becomes your storage: the
// same bDriveX storage API, accounts, quota and files as bdrivex.com (one storage API, two front doors).
// Files are sealed in this browser (BDX1, js/bdx-crypto.js) before upload, and each file key is wrapped by your own
// wallet (keyWrap), exactly as bDriveX does, so a file uploaded here opens in bDriveX and the other way round.
import { API, BDRIVEX } from './config.js';
import { ApiError, api, fileSource, saveKeyWrap, unwrapKey, uploadFile } from './bdx-client.js';
import { HEADER, SEG, TAG, checkHeader, hex, importKey, openMeta, openSegment, plainSizeOf, sealedSize, segmentCount, unb64u } from './bdx-crypto.js';
import { $, bytes, day, esc, eta, ext, store, tabStore, typeOf } from './ui.js';

const C = window.bWalletXConnect;
const K_SESSION = 'bsx:session', K_KEYS = 'bsx:keys', K_RESUME = 'bsx:resume';
const GiB = 1024 ** 3;
const TITLE = document.title;

// The session lives only as long as the tab, as on bDriveX (less for an injected script to find).
let session = tabStore.get(K_SESSION, null);
if (session && (session.scope === 'recipient' || !(session.expiresAt > Date.now() + 60_000))) session = null;
let wallet = null, handle = null, files = null, usage = null, view = 'landing', inviteKey = null;
let signing = false, wantSignIn = 0, confirming = null, unlocking = null, moved = false;
const opened = new Map(); // hash -> base64url file key, in memory for this tab only
const names = new Map(); // hash -> { meta: {name, type, size}, header }
const legacy = () => store.get(K_KEYS, {}); // keys the wallet couldn't take yet; moved into it on the next visit
const keyOf = (hash) => opened.get(hash) || legacy()[hash];
function dropLegacy(hash) {
  const k = legacy();
  if (!(hash in k)) return;
  delete k[hash];
  store.set(K_KEYS, Object.keys(k).length ? k : null);
}
const A = () => api(API, session?.token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('bWalletX didn’t answer.')), ms))]);
const shortKey = (k) => k.slice(0, 6) + '…' + k.slice(-4);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ---------- plain words for what went wrong

const denied = (e) => e?.code === 'ERR_PERMISSION_DENIED' || e?.code === 'ERR_USER_REJECTED' || e?.code === 4001
  || /denied|reject|cancel|declin|refused|user closed/i.test(e?.message || '');
const isNetwork = (e) => !(e instanceof ApiError) && (e instanceof TypeError || !navigator.onLine);
// The API answers 403 for a wallet that isn't invited (SIGNUP=invite), and for a "recipient" sign-in that may only open
// files sent to it. Both mean the same here: this wallet has no storage yet.
const notInvited = (e) => e instanceof ApiError && e.status === 403 && !/sign in from/i.test(e.message);
function waitWords(s) {
  if (!s) return 'a few minutes';
  return s < 90 ? `${Math.ceil(s)} seconds` : s < 5400 ? `${Math.ceil(s / 60)} minutes` : `${Math.ceil(s / 3600)} hours`;
}
function rateWords(e) {
  if (/tomorrow/i.test(e.message)) return 'You’ve uploaded a lot today. You can carry on tomorrow.';
  return `Too many tries just now. Try again in ${waitWords(e.retryAfter)}.`;
}
function words(e) {
  if (!e || e.name === 'AbortError') return null;
  if (e.code === 'NOT_FOUND') return 'No bWalletX found. Open this page in bWalletX, add the bWalletX extension, or connect again to pair your phone.';
  if (e instanceof ApiError) {
    if (e.status === 429) return rateWords(e);
    if (e.status >= 500) return 'Storage is having trouble right now. Try again in a minute.';
    return e.message; // the API's errors are sentences written for people
  }
  if (isNetwork(e)) return 'Can’t reach storage right now. Check your connection and try again.';
  if (denied(e)) return 'Cancelled in bWalletX.';
  return e.message || 'That didn’t work. Try again.';
}

let toastTimer = null;
function toast(msg, bad) {
  const t = $('#toast');
  $('#toast-t').textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 9000);
}

// ---------- views: landing (signed out), invite-only (connected, not admitted), account (signed in)

function show() {
  if (session) view = 'account';
  else if (view === 'account') view = 'landing';
  document.body.dataset.view = view;
  document.documentElement.classList.remove('bsx-in');
  document.title = view === 'account' ? 'Your storage · bStoreX' : TITLE;
  $('#landing').hidden = view === 'account';
  $('#account').hidden = view !== 'account';
  $('#invite').hidden = view !== 'invite';
  $('#hero').hidden = view === 'invite';
  // One wallet control in the nav: the connect button while signed out, your chip once signed in or connected.
  document.querySelectorAll('[data-bwx-connect]').forEach((s) => { s.hidden = view !== 'landing'; });
  drawWho();
  label();
  if (view === 'invite') drawInvite();
  if (view === 'account') { lookupHandle(session.identityKey); loadFiles(); drawResumes(); }
}

function drawWho() {
  const who = $('#who');
  const k = view === 'account' ? session.identityKey : view === 'invite' ? inviteKey : null;
  who.hidden = !k;
  if (!k) { who.innerHTML = ''; return; }
  who.innerHTML = `<span class="chip" title="${esc(k)}"><i></i>${esc(handle || shortKey(k))}</span><button class="who-out" type="button" id="who-out">${view === 'account' ? 'Sign out' : 'Disconnect'}</button>`;
  $('#who-out').onclick = () => signOut();
}

async function lookupHandle(k) {
  try {
    const r = await fetch(`https://pay.bwallet.space/api/paymail/lookup?key=${encodeURIComponent(k)}`);
    const j = r.ok ? await r.json() : null;
    if (j && typeof j.paymail === 'string' && (session?.identityKey === k || inviteKey === k)) { handle = '$' + j.paymail.split('@')[0]; drawWho(); }
  } catch {}
}

function drawInvite() {
  $('#inv-key').textContent = inviteKey || '';
  $('#inv-key').title = inviteKey || '';
  const body = `Hello,\n\nI'd like storage on bStoreX. My wallet's identity key is:\n${inviteKey}\n`;
  $('#inv-mail').href = `mailto:support@bwalletx.com?subject=${encodeURIComponent('bStoreX storage invite')}&body=${encodeURIComponent(body)}`;
  lookupHandle(inviteKey);
}

function showInvite(key) {
  session = null;
  tabStore.set(K_SESSION, null);
  inviteKey = key;
  view = 'invite';
  show();
  scrollTo({ top: 0 });
  $('#invite h1').focus({ preventScroll: true });
}

// ---------- sign in (server challenge / verify on the storage API)

const STATUS = { finding: 'Opening your wallet…', opening: 'Approve in bWalletX…', signing: 'Approve in bWalletX…', pairing: 'Scan the QR with bWalletX…' };
let status = '';
function label(s) {
  if (s !== undefined) status = s;
  const b = $('#open-storage');
  if (!b) return;
  b.disabled = signing;
  const connected = !!document.querySelector('[data-bwx-connect] .bwxc.on');
  b.textContent = signing ? (status || STATUS.finding) : connected ? 'Open your storage' : 'Connect bWalletX';
}

async function signIn() {
  if (signing || session) return;
  if (!C) { toast('The bWalletX script didn’t load. Reload the page and try again.', true); return; }
  signing = true;
  label(STATUS.finding); // feedback before any await
  let modal = null;
  try {
    modal = C.pairingModal({ title: 'Open your bStoreX storage' });
    const a = api(API);
    const r = await C.signInWithBwalletX({
      pairing: modal,
      onStatus: (s) => { if (STATUS[s]) label(STATUS[s]); },
      challenge: (identityKey) => a.post('/v1/auth/challenge', { identityKey }),
    });
    let v;
    try {
      v = await a.post('/v1/auth/verify', { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature });
    } catch (e) {
      if (notInvited(e)) { wallet = r.wallet; showInvite(r.identityKey); return; }
      throw e;
    }
    // A wallet someone sent a file to gets a sign-in that can only open that file (on bdrivex.com). It has no storage.
    if (v.scope === 'recipient') {
      api(API, v.token).post('/v1/auth/signout', {}).catch(() => {});
      wallet = r.wallet;
      showInvite(r.identityKey);
      return;
    }
    session = v;
    wallet = r.wallet;
    inviteKey = null;
    tabStore.set(K_SESSION, v);
    show();
    scrollTo({ top: 0 });
  } catch (e) {
    const w = words(e);
    if (w) toast(w, true);
  } finally {
    try { modal && modal.close(); } catch {}
    signing = false;
    label('');
  }
}

// Sign out of storage, and disconnect the wallet from this site too, so the page is back to the landing page.
function signOut(ended) {
  if (session && !ended) A().post('/v1/auth/signout', {}).catch(() => {});
  for (const j of jobs) j.ctl?.abort();
  jobs.length = 0;
  session = null; handle = null; files = null; usage = null; inviteKey = null; confirming = null; moved = false;
  opened.clear(); names.clear();
  try { wallet?.close?.(); } catch {}
  wallet = null;
  tabStore.set(K_SESSION, null);
  view = 'landing';
  const chip = document.querySelector('[data-bwx-connect] .bwxc.on');
  if (chip) chip.click(); // bwx-connect.js disconnects: clears the pairing and tells bWalletX to drop this site's theme
  else {
    try { C?.clearPairing?.(); } catch {}
    try { window.postMessage({ type: 'bwallet:disconnect' }, location.origin); } catch {}
  }
  drawJobs();
  show();
}

// Any 401 means the session ended; a 403 means this wallet isn't invited (any more). Returns true if handled.
function ended(e) {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 401 && session) { signOut(true); toast('Your sign-in ended. Connect again to carry on.'); return true; }
  if (notInvited(e) && session) { const k = session.identityKey; showInvite(k); return true; }
  return false;
}

// The wallet that signed in. After a reload only the session is left, so find it again: the extension, the in-app
// browser or this browser's phone pairing answer without a QR. interactive: pair the phone by QR if need be.
async function getWallet(interactive) {
  if (wallet) return wallet;
  let modal = null;
  try {
    if (interactive) modal = C.pairingModal({ title: 'Unlock your files' });
    const r = await C.connectBwalletX(modal ? { pairing: modal } : {});
    const { publicKey } = await r.wallet.getPublicKey({ identityKey: true });
    if (publicKey !== session?.identityKey) throw new Error('That’s a different wallet from the one you signed in with.');
    return (wallet = r.wallet);
  } finally {
    try { modal && modal.close(); } catch {}
  }
}

// ---------- storage used

function free() { return usage ? Math.max(0, usage.quota - usage.bytes - usage.pending) : Infinity; }

function drawUsage() {
  if (!usage) return;
  const pc = usage.quota ? Math.min(1, (usage.bytes + usage.pending) / usage.quota) : 1;
  const left = free();
  const state = left < 1024 * 1024 ? 'full' : pc >= 0.85 ? 'warn' : '';
  const m = $('#meter');
  m.dataset.state = state;
  $('#use-n').textContent = bytes(usage.bytes);
  $('#use-q').textContent = bytes(usage.quota);
  $('#use-bar').style.width = (pc * 100).toFixed(2) + '%';
  const bar = $('#use-track');
  bar.setAttribute('aria-valuenow', String(Math.round(pc * 100)));
  bar.setAttribute('aria-valuetext', `${bytes(usage.bytes)} of ${bytes(usage.quota)} used`);
  $('#use-s').textContent = state === 'full' ? 'Your storage is full. Delete something to upload more.'
    : state === 'warn' ? `Nearly full: ${bytes(left)} left. Delete files you don’t need to make room.`
    : `${plural(usage.files, 'file')} · ${bytes(left)} free`;
  $('#drop').classList.toggle('full', state === 'full');
  $('#drop-s').textContent = state === 'full' ? 'Your storage is full. Delete something first.' : `or choose files. Up to ${Math.floor((usage.maxFile || 2 * GiB) / GiB)} GB each.`;
}

// ---------- your files

async function nameOf(f) {
  if (names.has(f.hash)) return names.get(f.hash).meta;
  const key = keyOf(f.hash);
  if (!key || !f.meta) return null;
  try {
    const r = await openMeta(await importKey(unb64u(key)), f.meta);
    names.set(f.hash, r);
    return r.meta;
  } catch { return null; }
}

let loading = null;
function loadFiles() {
  if (loading) return loading;
  loading = (async () => {
    try {
      ({ files, usage } = await A().get('/v1/files'));
      $('#files-err').hidden = true;
    } catch (e) {
      if (ended(e)) return;
      $('#files-err-t').textContent = words(e) || 'Your files didn’t load.';
      $('#files-err').hidden = false;
      if (!files) $('#files').innerHTML = '';
      return;
    }
    drawUsage();
    await drawFiles();
    unlock(false);
  })().finally(() => { loading = null; });
  return loading;
}

const LOCK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', txt: 'text/plain' };
// Only types a browser shows without running anything. A decrypted file opens from this site's own origin, so HTML,
// SVG and the like are only ever downloaded, never opened here.
const SAFE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|aac|flac)|application\/pdf|text\/plain)$/;
const safeType = (m) => {
  const t = String(m.type || '').toLowerCase().split(';')[0].trim() || MEDIA[ext(m.name).toLowerCase()] || '';
  return SAFE.test(t) ? t : null;
};
const busyRows = new Map(); // hash -> status text while opening, downloading or deleting

async function drawFiles() {
  if (!files) return;
  const ul = $('#files');
  const locked = files.filter((f) => !keyOf(f.hash) && f.keyWrap).length;
  $('#unlock-row').hidden = !locked || !!unlocking;
  $('#files-n').textContent = files.length ? plural(files.length, 'file') : '';
  if (!files.length) {
    ul.innerHTML = `<li class="empty"><span class="empty-i" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 3h10l6 6v12H4z"/><path d="M14 3v6h6"/></svg></span><b>No files yet</b><span>Files you upload here, or in bDriveX, show up here.</span></li>`;
    return;
  }
  const metas = await Promise.all(files.map(nameOf));
  const t = Date.now();
  ul.innerHTML = files.map((f, i) => {
    const m = metas[i];
    const live = f.links.filter((l) => !l.revokedAt && !l.reported && (!l.expiresAt || l.expiresAt > t)).length;
    const busy = busyRows.get(f.hash);
    const name = m ? esc(m.name) : 'Locked file';
    let acts;
    if (confirming === f.hash) {
      acts = `<div class="confirm" role="group" aria-label="Delete ${name}?">
        <p>Delete <b>${name}</b> for good? It goes from bDriveX too${live ? `, and ${live === 1 ? 'its share link stops' : `its ${live} share links stop`} working` : ''}.</p>
        <div class="confirm-b"><button class="btn-s danger" type="button" data-act="del-yes" data-hash="${f.hash}">Delete for good</button><button class="btn-s" type="button" data-act="del-no" data-hash="${f.hash}">Keep it</button></div>
        <p class="row-err" role="alert" hidden></p>
      </div>`;
    } else {
      acts = `<span class="acts">
        ${m && safeType(m) ? `<button class="btn-s" type="button" data-act="open" data-hash="${f.hash}"${busy ? ' disabled' : ''}>Open</button>` : ''}
        ${m ? `<button class="btn-s" type="button" data-act="save" data-hash="${f.hash}"${busy ? ' disabled' : ''}>Download</button>` : ''}
        <button class="btn-s quiet" type="button" data-act="del" data-hash="${f.hash}" aria-label="Delete ${name}"${busy ? ' disabled' : ''}>Delete</button>
      </span>`;
    }
    const sub = busy ? `<span class="busy-t" aria-live="polite">${esc(busy)}</span>`
      : `${bytes(m ? m.size : f.size)} · ${day(f.createdAt)}${live ? ` · ${plural(live, 'share link')}` : ''}${m ? '' : ' · unlock to see its name'}`;
    return `<li class="${confirming === f.hash ? 'confirming' : ''}" data-hash="${f.hash}">
      <span class="ext${m ? '' : ' lock'}">${m ? esc(ext(m.name)) : LOCK}</span>
      <b title="${name}">${name}</b>
      <small>${sub}</small>
      ${acts}
    </li>`;
  }).join('');
  if (confirming) ul.querySelector(`[data-act="del-no"][data-hash="${confirming}"]`)?.focus();
}

// Open the keys your wallet wrapped, and move keys kept on this device into the wallet (once per tab).
// Quietly on load; interactive (the Unlock button) may pair the phone by QR.
function unlock(interactive) {
  if (unlocking || !files || !session) return unlocking;
  const shut = files.filter((f) => !keyOf(f.hash) && f.keyWrap);
  const move = moved ? [] : files.filter((f) => !f.keyWrap && legacy()[f.hash]);
  if (!shut.length && !move.length) return null;
  const err = $('#unlock-err');
  err.hidden = true;
  unlocking = (async () => {
    let w;
    try { w = await getWallet(interactive); } catch (e) {
      if (interactive && words(e)) { err.textContent = words(e); err.hidden = false; }
      return;
    }
    $('#unlock-row').hidden = true;
    if (shut.length) $('#keys-note').textContent = 'Opening your files with bWalletX. Approve if it asks.';
    for (const f of shut) {
      try { opened.set(f.hash, await unwrapKey(w, f.hash, f.keyWrap)); } catch {}
    }
    if (move.length) {
      moved = true;
      $('#keys-note').textContent = `Moving ${move.length === 1 ? 'a file key' : move.length + ' file keys'} from this device into your wallet. Approve in bWalletX.`;
      for (const f of move) {
        try {
          await saveKeyWrap({ base: API, token: session.token, wallet: w, hash: f.hash, key: legacy()[f.hash] });
          opened.set(f.hash, legacy()[f.hash]);
          dropLegacy(f.hash);
        } catch (e) { if (ended(e)) return; break; }
      }
    }
  })().finally(() => {
    unlocking = null;
    $('#keys-note').textContent = KEYS_NOTE;
    drawFiles();
  });
  return unlocking;
}
const KEYS_NOTE = 'Each file’s key is kept in your wallet, so your files open on any device you sign in on, here or in bDriveX. Your files and their names are stored encrypted: bCorp can see which wallet they belong to and each file’s size and upload date, but not its name, type or what’s inside.';

// ---------- open and download (decrypted in this browser)

/** Stream your own file from the API and decrypt it as it arrives. Resumes with Range after a dropped connection. */
async function fetchOwn({ hash, size, want, key, sink, onProgress }) {
  const ck = await importKey(unb64u(key));
  const plainSize = plainSizeOf(size), nSeg = segmentCount(plainSize);
  let buf = new Uint8Array(0), got = 0, seg = 0, header = null;
  const take = async () => {
    if (!header) {
      if (buf.length < HEADER) return false;
      header = buf.slice(0, HEADER);
      checkHeader(header);
      if (want && hex(header) !== hex(want)) throw new Error('This file doesn’t match its name record.');
      buf = buf.subarray(HEADER);
    }
    const last = seg === nSeg - 1;
    const need = last ? plainSize - seg * SEG + TAG : SEG + TAG;
    if (buf.length < need) return false;
    const plain = await openSegment(ck, header, seg, last, buf.subarray(0, need));
    buf = buf.subarray(need);
    await sink.write(plain);
    seg++;
    return true;
  };
  for (let attempt = 0; got < size;) {
    try {
      const headers = { authorization: `Bearer ${session.token}` };
      if (got) headers.range = `bytes=${got}-`;
      const r = await fetch(`${API}/v1/blobs/${hash}`, { headers });
      if (!r.ok) {
        let j = null;
        try { j = await r.json(); } catch {}
        const e = new ApiError(r.status, (j && j.error) || `Storage said ${r.status}.`, j);
        e.retryAfter = Number(r.headers.get('retry-after')) || null;
        throw e;
      }
      if (got && r.status !== 206) throw new Error('The server could not resume this download.');
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        const joined = new Uint8Array(buf.length + value.length);
        joined.set(buf, 0); joined.set(value, buf.length);
        buf = joined;
        while (await take());
        onProgress?.(got, size);
        attempt = 0;
      }
    } catch (e) {
      if (e instanceof ApiError || /decrypt|match|header/i.test(e.message) || ++attempt > 6) throw e;
      await sleep(Math.min(15000, 500 * 2 ** attempt));
    }
  }
  if (seg !== nSeg || buf.length) throw new Error('The download ended early. Try again.');
  await sink.close?.();
}

async function getFile(hash, mode, btn) {
  const f = files?.find((x) => x.hash === hash), rec = names.get(hash), key = keyOf(hash);
  if (!f || !rec || !key || busyRows.has(hash)) return;
  const m = rec.meta;
  const type = mode === 'open' ? safeType(m) : null;
  if (mode === 'open' && !type) return;
  // A tab opened now, inside the click, so the browser doesn't block it as a pop-up once the file is ready.
  let win = null;
  if (mode === 'open') {
    win = window.open('', '_blank');
    try { win && (win.document.title = m.name, win.document.body.style.cssText = 'margin:0;background:#000;color:#a9a69c;font:15px system-ui;display:grid;place-items:center;height:100vh', win.document.body.textContent = 'Decrypting…'); } catch {}
  }
  const step = (t) => { busyRows.set(hash, t); const s = $(`#files li[data-hash="${hash}"] small`); if (s) s.innerHTML = `<span class="busy-t">${esc(t)}</span>`; };
  busyRows.set(hash, 'Decrypting…');
  drawFiles();
  let disk = null;
  try {
    const parts = [];
    let sink = { write: (u8) => { parts.push(u8); } };
    if (mode === 'save' && m.size > GiB && window.showSaveFilePicker) {
      const h = await showSaveFilePicker({ suggestedName: m.name });
      disk = await h.createWritable();
      sink = { write: (u8) => disk.write(u8), close: () => disk.close() };
    }
    await fetchOwn({ hash, size: f.size, want: rec.header, key, sink, onProgress: (got, total) => step(`Decrypting · ${Math.floor((got / total) * 100)}%`) });
    if (!disk) {
      const url = URL.createObjectURL(new Blob(parts, { type: type || 'application/octet-stream' }));
      if (win) { win.location.href = url; try { win.opener = null; } catch {} }
      else {
        const a = Object.assign(document.createElement('a'), { href: url, download: m.name });
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    }
    busyRows.delete(hash);
    drawFiles();
  } catch (e) {
    try { win?.close(); } catch {}
    try { await disk?.abort(); } catch {}
    busyRows.delete(hash);
    if (ended(e)) return;
    await drawFiles();
    const w = words(e);
    if (w) toast(`${m.name}: ${w}`, true);
  }
}

async function onFilesClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, hash } = b.dataset;
  if (act === 'open' || act === 'save') return getFile(hash, act, b);
  if (act === 'del') { confirming = hash; return drawFiles(); }
  if (act === 'del-no') {
    confirming = null;
    await drawFiles();
    $(`#files [data-act="del"][data-hash="${hash}"]`)?.focus();
    return;
  }
  if (act === 'del-yes') {
    const row = b.closest('li');
    row.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    b.textContent = 'Deleting…';
    try {
      await A().del(`/v1/files/${hash}`);
      const name = names.get(hash)?.meta?.name;
      opened.delete(hash); names.delete(hash); dropLegacy(hash);
      confirming = null;
      await loadFiles();
      toast(name ? `${name} deleted.` : 'File deleted.');
      $('#drop input').focus({ preventScroll: true });
    } catch (err) {
      if (ended(err)) return;
      row.querySelectorAll('button').forEach((x) => { x.disabled = false; });
      b.textContent = 'Delete for good';
      const p = row.querySelector('.row-err');
      p.textContent = words(err) || 'That didn’t work. Try again.';
      p.hidden = false;
    }
  }
}

// ---------- upload: sealed here, resumable, one file at a time

const jobs = [];
let jobSeq = 0, pumping = false, tick = null;
const fpOf = (f) => `${f.name}|${f.size}|${f.lastModified}`;
function forgetResume(fp) {
  const r = store.get(K_RESUME, {});
  if (!(fp in r)) return;
  delete r[fp];
  store.set(K_RESUME, Object.keys(r).length ? r : null);
}

function addFiles(list) {
  if (!session || !list?.length) return;
  for (const file of list) {
    // The same file twice in the queue would race for one upload: keep the one already there.
    if (jobs.some((j) => fpOf(j.file) === fpOf(file) && !['done', 'big', 'full', 'error'].includes(j.state))) continue;
    jobs.push({ id: ++jobSeq, file, state: 'queued', sent: 0, total: sealedSize(file.size) });
  }
  drawJobs();
  drawResumes();
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let j;
    while (session && (j = jobs.find((x) => x.state === 'queued'))) await run(j);
  } finally { pumping = false; }
}

function stop(j, state, msg) { j.state = state; j.err = msg; drawJob(j); }

async function run(j) {
  const f = j.file, max = usage?.maxFile || 2 * GiB;
  if (f.size > max) return stop(j, 'big', `This file is ${bytes(f.size)}. Files can be up to ${Math.floor(max / GiB)} GB each for now.`);
  const fp = fpOf(f);
  const resuming = store.get(K_RESUME, {})[fp];
  const need = sealedSize(f.size);
  if (!resuming && need > free()) {
    return stop(j, 'full', free() < 1024 * 1024 ? 'Your storage is full. Delete something to make room for this file.'
      : `Not enough room: this file needs ${bytes(need)} and you have ${bytes(free())} free. Delete something to make room.`);
  }
  j.state = 'sending'; j.err = null; j.ctl = new AbortController(); j.startedAt = Date.now(); j.from = j.sent;
  drawJob(j);
  try {
    const up = await uploadFile({
      base: API, token: session.token, source: fileSource(f), name: f.name, type: typeOf(f), resume: resuming, signal: j.ctl.signal,
      onStart: (s) => {
        j.uploadId = s.id;
        store.set(K_RESUME, { ...store.get(K_RESUME, {}), [fp]: { ...s, name: f.name, size: f.size, at: Date.now() } });
        if (usage && !resuming) { usage.pending += need; drawUsage(); }
      },
      onProgress: ({ sent, total }) => { j.sent = sent; j.total = total; drawJob(j); },
    });
    forgetResume(fp);
    opened.set(up.hash, up.key);
    j.hash = up.hash;
    j.state = 'wrapping';
    drawJob(j);
    try {
      await within(90_000, (async () => saveKeyWrap({ base: API, token: session.token, wallet: await getWallet(false), hash: up.hash, key: up.key }))());
    } catch (e) {
      if (ended(e)) return;
      store.set(K_KEYS, { ...legacy(), [up.hash]: up.key }); // not in the wallet yet: keep it here and move it next visit
      j.kept = true;
    }
    j.state = 'done';
    drawJob(j);
    loadFiles();
    setTimeout(() => { const i = jobs.indexOf(j); if (i >= 0 && j.state === 'done') { jobs.splice(i, 1); drawJobs(); } }, j.kept ? 20_000 : 8000);
  } catch (e) {
    if (!session) return;
    if (j.ctl.signal.aborted || e?.name === 'AbortError') return;
    if (ended(e)) return;
    if (e instanceof ApiError && e.status === 413) {
      loadFiles();
      return stop(j, /allowance/i.test(e.message) ? 'full' : 'big', /allowance/i.test(e.message) ? 'Not enough room for this file. Delete something to make room.' : e.message);
    }
    if (e instanceof ApiError && e.status === 429) {
      if (/tomorrow/i.test(e.message)) return stop(j, 'error', rateWords(e));
      j.state = 'waiting'; j.retryAt = Date.now() + (e.retryAfter || 60) * 1000;
      drawJob(j); ticking();
      return;
    }
    if (isNetwork(e)) { j.state = 'offline'; drawJob(j); ticking(); return; }
    stop(j, 'error', words(e));
  }
}

// Waiting jobs carry on by themselves: after a 429's wait, or when the connection comes back.
function ticking() {
  if (tick) return;
  tick = setInterval(() => {
    let left = false;
    for (const j of jobs) {
      if (j.state === 'waiting') {
        if (Date.now() >= j.retryAt) j.state = 'queued';
        else left = true;
        drawJob(j);
      } else if (j.state === 'offline') {
        if (navigator.onLine && Date.now() - (j.tried || 0) > 20_000) { j.tried = Date.now(); j.state = 'queued'; drawJob(j); }
        else left = true;
      }
    }
    if (jobs.some((j) => j.state === 'queued')) pump();
    if (!left) { clearInterval(tick); tick = null; }
  }, 1000);
}
addEventListener('online', () => { jobs.forEach((j) => { if (j.state === 'offline') { j.state = 'queued'; drawJob(j); } }); pump(); });
addEventListener('offline', () => jobs.forEach((j) => j.state === 'sending' && drawJob(j)));

function retry(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j || j.state === 'sending' || j.state === 'wrapping') return;
  j.state = 'queued'; j.err = null;
  drawJob(j);
  pump();
}

async function cancel(id) {
  const i = jobs.findIndex((x) => x.id === id);
  if (i < 0) return;
  const j = jobs[i];
  jobs.splice(i, 1);
  j.ctl?.abort();
  drawJobs();
  if (j.state === 'done') return;
  forgetResume(fpOf(j.file));
  if (j.uploadId) { await A().del(`/v1/uploads/${j.uploadId}`).catch(() => {}); loadFiles(); }
}

function jobText(j) {
  const pc = j.total ? Math.floor((j.sent / j.total) * 100) : 0;
  switch (j.state) {
    case 'queued': return j.sent ? `Carrying on from ${pc}%…` : 'Waiting its turn…';
    case 'sending':
      if (!navigator.onLine) return `Connection lost at ${pc}%. It carries on from where it stopped when you’re back online.`;
      return j.sent ? `Encrypting and uploading · ${pc}% · ${bytes(j.sent)} of ${bytes(j.total)}` : 'Encrypting and uploading · starting…';
    case 'wrapping': return 'Keeping the key in your wallet. Approve in bWalletX if it asks…';
    case 'done': return j.kept ? 'Uploaded and encrypted. Its key is kept on this device until your wallet can take it.' : 'Uploaded and encrypted.';
    case 'waiting': return `Too many requests, so it’s paused at ${pc}%. Carrying on in ${waitWords(Math.max(1, (j.retryAt - Date.now()) / 1000))}.`;
    case 'offline': return `Connection lost at ${pc}%. It carries on from where it stopped when you’re back online.`;
    default: return j.err || 'The upload stopped.';
  }
}

function jobHtml(j) {
  const pc = j.total ? Math.floor((j.sent / j.total) * 100) : 0;
  const bad = ['big', 'full', 'error'].includes(j.state);
  const live = ['sending', 'queued', 'waiting', 'offline', 'wrapping'].includes(j.state);
  const rate = j.state === 'sending' && j.sent > j.from ? eta(j.sent - j.from, j.total - j.from, j.startedAt) : '';
  return `<li class="job" data-job="${j.id}" data-state="${j.state}">
    <span class="ext">${esc(ext(j.file.name))}</span>
    <b title="${esc(j.file.name)}">${esc(j.file.name)}</b>
    <small>${bytes(j.file.size)}${rate ? ` · ${rate}` : ''}${j.state === 'queued' ? ` · ${esc(jobText(j))}` : ''}</small>
    <span class="job-acts">
      ${['error', 'offline'].includes(j.state) ? `<button class="btn-s" type="button" data-job-act="retry" data-id="${j.id}">Try again</button>` : ''}
      ${j.state === 'done' ? '' : `<button class="btn-s quiet" type="button" data-job-act="cancel" data-id="${j.id}">${live ? 'Cancel' : 'Remove'}</button>`}
    </span>
    ${bad || j.state === 'queued' ? '' : `<div class="bar" role="progressbar" aria-label="Upload progress for ${esc(j.file.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pc}"><span style="width:${j.state === 'done' ? 100 : pc}%"></span></div>`}
    ${j.state === 'queued' ? '' : `<p class="job-t${bad ? ' bad' : j.state === 'done' ? ' ok' : ''}" ${bad ? 'role="alert"' : ''}>${esc(jobText(j))}</p>`}
  </li>`;
}

function drawJobs() {
  const ul = $('#jobs');
  ul.hidden = !jobs.length;
  ul.innerHTML = jobs.map(jobHtml).join('');
}
function drawJob(j) {
  const li = $(`#jobs li[data-job="${j.id}"]`);
  if (!li) return drawJobs();
  if (li.dataset.state !== j.state) { li.outerHTML = jobHtml(j); return; }
  const pc = j.total ? Math.floor((j.sent / j.total) * 100) : 0;
  const bar = li.querySelector('.bar');
  if (bar) { bar.setAttribute('aria-valuenow', String(pc)); bar.firstElementChild.style.width = (j.state === 'done' ? 100 : pc) + '%'; }
  const t = li.querySelector('.job-t');
  if (t) t.textContent = jobText(j);
  const rate = j.state === 'sending' && j.sent > j.from ? eta(j.sent - j.from, j.total - j.from, j.startedAt) : '';
  li.querySelector('small').textContent = `${bytes(j.file.size)}${rate ? ` · ${rate}` : ''}${j.state === 'queued' ? ` · ${jobText(j)}` : ''}`;
}

// Uploads that stopped part way in an earlier visit (the tab closed, the laptop slept). Choosing the same file again
// carries on from where it stopped: the key and header kept for it make the same sealed bytes.
async function drawResumes() {
  const box = $('#resumes');
  const r = store.get(K_RESUME, {});
  const items = Object.entries(r).filter(([fp]) => !jobs.some((j) => fpOf(j.file) === fp));
  box.hidden = !items.length || !session;
  if (box.hidden) { box.innerHTML = ''; return; }
  box.innerHTML = `<p class="res-h">Unfinished uploads. Choose the same file again to carry on from where it stopped.</p><ul>${items.map(([fp, x]) =>
    `<li><span class="ext">${esc(ext(x.name || ''))}</span><b title="${esc(x.name || '')}">${esc(x.name || 'A file')}</b><small data-res="${esc(x.id)}">${x.size != null ? bytes(x.size) : ''}</small>
      <span class="job-acts"><button class="btn-s" type="button" data-res-act="pick">Choose file</button><button class="btn-s quiet" type="button" data-res-act="forget" data-fp="${esc(fp)}">Forget</button></span></li>`).join('')}</ul>`;
  for (const [, x] of items) {
    A().get(`/v1/uploads/${x.id}`).then((u) => {
      const s = box.querySelector(`small[data-res="${CSS.escape(x.id)}"]`);
      if (s && u.size) s.textContent = `${bytes(x.size)} · ${Math.floor((u.offset / u.size) * 100)}% sent`;
    }).catch(() => {});
  }
}
async function onResumesClick(e) {
  const b = e.target.closest('button[data-res-act]');
  if (!b) return;
  if (b.dataset.resAct === 'pick') return $('#pick').click();
  const fp = b.dataset.fp, x = store.get(K_RESUME, {})[fp];
  forgetResume(fp);
  drawResumes();
  if (x?.id) { await A().del(`/v1/uploads/${x.id}`).catch(() => {}); loadFiles(); }
}

// ---------- wire up

function wire() {
  $('#open-storage').onclick = () => signIn();
  try { C?.bindPrewarm?.($('#open-storage')); } catch {}
  // The header's Connect (bwx-connect.js) connects the wallet; a click there also opens your storage. A quiet
  // reconnect on page load doesn't: nothing asks the wallet to sign without a click.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bwx-connect] button');
    if (b && !b.classList.contains('on')) wantSignIn = Date.now();
  }, true);
  document.addEventListener('bwalletx:connected', () => {
    label();
    if (!session && wantSignIn && Date.now() - wantSignIn < 180_000) { wantSignIn = 0; signIn(); }
  });
  document.addEventListener('bwalletx:disconnected', () => {
    label();
    if (session || view === 'invite') signOut();
  });
  $('#inv-copy').onclick = async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(inviteKey); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy it'; }
    setTimeout(() => { b.textContent = 'Copy key'; }, 1600);
  };
  $('#inv-out').onclick = () => signOut();
  $('#signout-all').onclick = () => { if (session) A().post('/v1/auth/signout-all', {}).catch(() => {}); signOut(true); toast('Signed out on every device, here and in bDriveX.'); };
  $('#toast-x').onclick = () => { $('#toast').hidden = true; };
  $('#files').addEventListener('click', onFilesClick);
  $('#files').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && confirming) { const h = confirming; confirming = null; drawFiles().then(() => $(`#files [data-act="del"][data-hash="${h}"]`)?.focus()); }
  });
  $('#files-retry').onclick = () => loadFiles();
  $('#unlock').onclick = () => unlock(true);
  $('#jobs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-job-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (b.dataset.jobAct === 'retry') retry(id); else cancel(id);
  });
  $('#resumes').addEventListener('click', onResumesClick);
  $('#pick').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  // Drop anywhere on the page while signed in; the drop zone lights up.
  const drop = $('#drop');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (view !== 'account' || !hasFiles(e)) return; e.preventDefault(); depth++; drop.classList.add('over'); });
  addEventListener('dragover', (e) => { if (view !== 'account' || !hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('over'); } });
  addEventListener('drop', (e) => {
    if (view !== 'account' || !hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.classList.remove('over');
    addFiles([...e.dataTransfer.files]);
  });
  addEventListener('beforeunload', (e) => { if (jobs.some((j) => ['sending', 'wrapping'].includes(j.state))) { e.preventDefault(); e.returnValue = ''; } });
  $('#share-link').href = `${BDRIVEX}/send`;
}

wire();
show();
