// Copied from bitcoin-corp/bdrivex-site js/bdx-client.js at main 536791a.
// bStoreX and bDriveX are two front doors to the same storage API (files.bdrivex.com), so uploads, keys and links
// must work exactly the same way. Fix bugs upstream in bdrivex-site first, then copy the file here again.
// One change from upstream, worth taking back there: ApiError carries `retryAfter` (seconds) from a 429's
// Retry-After header, when the browser can read it (the API has to list it in Access-Control-Expose-Headers).

// bDriveX client: seal a file, upload it in resumable chunks, make and open share links.
// Plain ES module with no globals, so the site pages and the Node end-to-end test run the same code.
import { sha256 } from './vendor/sha256.js';
import {
  HEADER, SEG, TAG, b64u, checkHeader, hex, importKey, newSeal, openMeta, openSegment, plainSizeOf,
  sealMeta, sealSegment, sealedSize, segmentCount, unb64u,
} from './bdx-crypto.js';

/** Segments per PATCH. 8 MiB chunks: few round trips, small loss when a chunk has to be resent. */
// One 1 MiB segment per PATCH, so the progress bar moves every megabyte (owner, 2 Nov 2026: it sat at 0% for
// the first 8 MiB). The server has no per-request limit on PATCH; resumable offsets work the same at any size.
const PER_CHUNK = 1;
const RETRIES = 6;
const wait = (ms, signal) => new Promise((ok, no) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); no(signal.reason); }, { once: true });
});

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

export function api(base, token) {
  const call = async (method, path, { json, body, headers = {}, signal } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(base + path, { method, headers: h, body, signal });
    if (!r.ok) {
      let j = null;
      try { j = await r.json(); } catch {}
      const e = new ApiError(r.status, (j && j.error) || `bDriveX said ${r.status}.`, j);
      e.retryAfter = Number(r.headers.get('retry-after')) || null; // bStoreX: null when CORS hides the header
      throw e;
    }
    return r;
  };
  return {
    base,
    call,
    get: (p, o) => call('GET', p, o).then((r) => r.json()),
    post: (p, json, o) => call('POST', p, { ...o, json }).then((r) => (r.status === 204 ? null : r.json())),
    del: (p, o) => call('DELETE', p, o).then(() => null),
  };
}

/** Sign in: ask for a challenge, have the wallet sign it (signChallenge), trade the signature for a session token. */
export async function signIn(base, { identityKey, signChallenge }) {
  const a = api(base);
  const ch = await a.post('/v1/auth/challenge', { identityKey });
  const { signature, identityKey: key = identityKey } = await signChallenge(ch);
  return a.post('/v1/auth/verify', { identityKey: key, nonce: ch.nonce, signature });
}

/**
 * Seal and upload one file. `source` is { size, read(start, end) -> Promise<Uint8Array> } (see fileSource).
 * Pass `resume` ({ id, key, header } as saved from onStart) to carry on an upload after a reload: the same key
 * and header give the same ciphertext, so the chunks the server already has are re-made only to hash them.
 * Returns { hash, size, key, meta } where key is the base64url file key for the share link.
 */
export async function uploadFile({ base, token, source, name, type = '', onStart, onProgress, signal, resume }) {
  const a = api(base, token);
  const { key, header } = resume ? { key: unb64u(resume.key), header: unb64u(resume.header) } : newSeal();
  checkHeader(header);
  const ck = await importKey(key);
  const plainSize = source.size;
  const total = sealedSize(plainSize);
  const nSeg = segmentCount(plainSize);

  let id = resume?.id, offset = 0;
  if (id) {
    try { offset = (await a.get(`/v1/uploads/${id}`)).offset; } catch (e) { if (e.status !== 404) throw e; id = null; }
    if (!id) return uploadFile({ base, token, source, name, type, onStart, onProgress, signal });
  } else {
    ({ id } = await a.post('/v1/uploads', { size: total }, { signal }));
  }
  onStart?.({ id, key: b64u(key), header: b64u(header) });

  const hash = sha256.create();
  let at = 0; // sealed bytes made so far
  for (let first = 0; first < nSeg; first += PER_CHUNK) {
    const parts = first === 0 ? [header] : [];
    for (let i = first; i < Math.min(first + PER_CHUNK, nSeg); i++) {
      const plain = await source.read(i * SEG, Math.min((i + 1) * SEG, plainSize));
      parts.push(await sealSegment(ck, header, i, i === nSeg - 1, plain));
    }
    const chunk = concat(parts);
    hash.update(chunk);
    const start = at;
    at += chunk.length;
    if (at <= offset) { onProgress?.({ sent: at, total }); continue; } // already on the server
    if (start !== offset) throw new Error('The server’s copy of this upload doesn’t line up. Start the upload again.');
    offset = await sendChunk(a, id, start, chunk, signal);
    onProgress?.({ sent: offset, total });
  }
  const digest = hex(hash.digest());
  const meta = await sealMeta(ck, header, { name, type, size: plainSize });
  const done = await a.post(`/v1/uploads/${id}/complete`, { sha256: digest, meta }, { signal });
  return { hash: done.hash, size: done.size, key: b64u(key), meta };
}

async function sendChunk(a, id, start, chunk, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await a.call('PATCH', `/v1/uploads/${id}`, {
        body: chunk, signal,
        headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': String(start) },
      });
      return Number(r.headers.get('upload-offset'));
    } catch (e) {
      if (signal?.aborted || attempt >= RETRIES || (e instanceof ApiError && e.status < 500 && e.status !== 409 && e.status !== 429)) throw e;
      await wait(Math.min(15000, 500 * 2 ** attempt), signal);
      // The chunk may have landed and only the reply was lost: ask where the server is.
      const now = (await a.get(`/v1/uploads/${id}`).catch(() => null))?.offset;
      if (now === start + chunk.length) return now;
      if (now != null && now !== start) throw new Error('The upload moved on without this chunk. Start the upload again.');
    }
  }
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** A source for uploadFile from a browser File/Blob. */
export const fileSource = (file) => ({
  size: file.size,
  read: async (s, e) => new Uint8Array(await file.slice(s, e).arrayBuffer()),
});

/** Share link for a file: the key goes after #, which browsers never send to a server. */
export const shareUrl = (site, linkId, key) => `${site.replace(/\/$/, '')}/s/${linkId}#k=${key}`;
export function parseShare(hash) {
  const k = new URLSearchParams(String(hash).replace(/^#/, '')).get('k');
  if (!k || !/^[A-Za-z0-9_-]{43}$/.test(k)) return null;
  return k;
}

/** What a share link holds: { size, createdAt, expiresAt, meta: {name, type, size} }. No wallet needed. */
export async function openLink({ base, id, key }) {
  const info = await api(base).get(`/v1/s/${encodeURIComponent(id)}`);
  if (info.bound) throw new ApiError(403, 'This file was sent to one person. They sign in with bWalletX to open it.', info);
  const ck = await importKey(unb64u(key));
  const { meta, header } = await openMeta(ck, info.meta);
  return { ...info, meta, header, ck };
}

/**
 * Download a share link and decrypt it as it streams in. `sink` is { write(u8) -> Promise|void, close() }.
 * Resumes with Range after a dropped connection. Returns { sha256 } of the plaintext, for checking against a
 * published hash (the GCM tags already prove nothing was changed).
 */
export async function downloadLink({ base, id, link, sink, onProgress, signal, token = link.token }) {
  const total = link.size;
  const plainSize = plainSizeOf(total);
  const nSeg = segmentCount(plainSize);
  const hash = sha256.create();
  // A link sent to one person tells its recipient the file's hash (its wrap is bound to it): check the bytes match.
  const blobHash = link.hash ? sha256.create() : null;
  let buf = new Uint8Array(0), got = 0, seg = 0, header = null;

  const take = async () => {
    if (!header) {
      if (buf.length < HEADER) return false;
      header = buf.slice(0, HEADER);
      checkHeader(header);
      if (hex(header) !== hex(link.header)) throw new Error('This file doesn’t match its link.');
      buf = buf.subarray(HEADER);
    }
    const last = seg === nSeg - 1;
    const need = last ? plainSize - seg * SEG + TAG : SEG + TAG;
    if (buf.length < need) return false;
    const plain = await openSegment(link.ck, header, seg, last, buf.subarray(0, need));
    buf = buf.subarray(need);
    hash.update(plain);
    await sink.write(plain);
    seg++;
    return true;
  };

  for (let attempt = 0; got < total; ) {
    try {
      const headers = got ? { range: `bytes=${got}-` } : {};
      if (token) headers.authorization = `Bearer ${token}`;
      const r = await fetch(`${base}/v1/s/${encodeURIComponent(id)}/blob`, { signal, headers });
      if (!r.ok) {
        let j = null;
        try { j = await r.json(); } catch {}
        throw new ApiError(r.status, (j && j.error) || `bDriveX said ${r.status}.`);
      }
      if (got && r.status !== 206) throw new Error('The server could not resume this download.');
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        blobHash?.update(value);
        const joined = new Uint8Array(buf.length + value.length);
        joined.set(buf, 0); joined.set(value, buf.length);
        buf = joined;
        while (await take());
        onProgress?.({ got, total });
        attempt = 0;
      }
    } catch (e) {
      if (signal?.aborted || e instanceof ApiError || /decrypt|match|header/i.test(e.message) || ++attempt > RETRIES) throw e;
      await wait(Math.min(15000, 500 * 2 ** attempt), signal);
    }
  }
  if (seg !== nSeg || buf.length) throw new Error('The download ended early. Try again.');
  if (blobHash && hex(blobHash.digest()) !== link.hash) throw new Error('This file doesn’t match its link.');
  await sink.close?.();
  return { sha256: hex(hash.digest()) };
}

/**
 * v1.1: the owner's wallet wraps each file key to itself (BRC-2 encrypt, counterparty self, key ID = the file's
 * hash) and bDriveX keeps the wrap beside the file, so any device signed in to that wallet can open its files.
 * Protocol security level 1: the wallet asks once per site, not once per file. `wallet` is any BRC-100 wallet.
 */
export const KEY_PROTOCOL = [1, 'bdrivex file key'];
export async function wrapKey(wallet, hash, key) {
  const { ciphertext } = await wallet.encrypt({ plaintext: Array.from(unb64u(key)), protocolID: KEY_PROTOCOL, keyID: hash, counterparty: 'self' });
  return b64u(Uint8Array.from(ciphertext));
}
export async function unwrapKey(wallet, hash, keyWrap) {
  const { plaintext } = await wallet.decrypt({ ciphertext: Array.from(unb64u(keyWrap)), protocolID: KEY_PROTOCOL, keyID: hash, counterparty: 'self' });
  if (plaintext.length !== 32) throw new Error('That isn’t a bDriveX file key.');
  return b64u(Uint8Array.from(plaintext));
}
/** Wrap a file's key with the wallet and hand the wrap to bDriveX. */
export async function saveKeyWrap({ base, token, wallet, hash, key }) {
  await api(base, token).call('PUT', `/v1/files/${hash}/key`, { json: { keyWrap: await wrapKey(wallet, hash, key) } });
}

/**
 * v1.2: send to one person. The sender's wallet wraps the file key for the recipient's identity key (BRC-2 encrypt,
 * protocol [2,'bdrivex share'], key ID '<file hash>.<link id>', counterparty = the recipient), so only that wallet
 * can open it, and only for that file and that link. The link carries no key: the recipient signs in with bWalletX,
 * gets the wrap from bDriveX and decrypts it with counterparty = the sender. Security level 2: the derivation is
 * bound to the counterparty, so each recipient gets keys no one else's wallet can derive.
 */
export const SHARE_PROTOCOL = [2, 'bdrivex share'];
const IDENTITY_KEY = /^0[23][0-9a-f]{64}$/;
const shareKeyID = (hash, linkId) => `${hash}.${linkId}`;
export async function wrapForRecipient(wallet, { hash, linkId, key, recipient }) {
  if (!IDENTITY_KEY.test(recipient)) throw new Error('That isn’t an identity key.');
  const { ciphertext } = await wallet.encrypt({ plaintext: Array.from(unb64u(key)), protocolID: SHARE_PROTOCOL, keyID: shareKeyID(hash, linkId), counterparty: recipient });
  return b64u(Uint8Array.from(ciphertext));
}
export async function unwrapFromSender(wallet, { hash, linkId, wrap, senderKey }) {
  if (!IDENTITY_KEY.test(senderKey)) throw new Error('This link’s sender key is not valid.');
  const { plaintext } = await wallet.decrypt({ ciphertext: Array.from(unb64u(wrap)), protocolID: SHARE_PROTOCOL, keyID: shareKeyID(hash, linkId), counterparty: senderKey });
  if (plaintext.length !== 32) throw new Error('That isn’t a bDriveX file key.');
  return b64u(Uint8Array.from(plaintext));
}

/**
 * Make a link. With `recipient` (identity key) the link is bound to that wallet: it is made first, then the wallet
 * wraps the key with the new link's id and the wrap is handed to bDriveX. If the wallet declines, the half-made link
 * is switched off. Returns { id, createdAt, expiresAt, bound, url }.
 * `alongside(link)` (bound links only) runs right after the wallet is asked to wrap the key, before the answer, so
 * other wallet requests it starts (the bMail notice) reach the wallet together with the wrap and the wrap stays the
 * first thing asked. What it starts is the caller's to await: nothing it does can fail or delay the link.
 */
export async function makeLink({ base, token, site, hash, key, ttl = null, recipient = null, recipientLabel = null, wallet = null, alongside = null }) {
  const a = api(base, token);
  if (!recipient) {
    const l = await a.post('/v1/links', { hash, ttl });
    return { ...l, url: shareUrl(site, l.id, key) };
  }
  const l = await a.post('/v1/links', { hash, ttl, recipient, ...(recipientLabel ? { recipientLabel } : {}) });
  try {
    const wrapping = wrapForRecipient(wallet, { hash, linkId: l.id, key, recipient });
    try { alongside?.({ ...l, url: boundUrl(site, l.id) }); } catch {}
    const recipientWrap = await wrapping;
    await a.call('PUT', `/v1/links/${l.id}/recipient`, { json: { recipient, recipientWrap } });
  } catch (e) {
    await a.del(`/v1/links/${l.id}`).catch(() => {});
    throw e;
  }
  return { ...l, url: boundUrl(site, l.id) };
}
/** A link sent to one person has no key in it, and needs none. */
export const boundUrl = (site, linkId) => `${site.replace(/\/$/, '')}/s/${linkId}`;

/** A share link's public view, signed in or not. Bound links say { bound, forYou, from, size, ... }. */
export const linkInfo = ({ base, id, token }) => api(base, token).get(`/v1/s/${encodeURIComponent(id)}`);

/** Open a link sent to you: unwrap its key with your wallet, then read its name. Same shape as openLink. */
export async function openBoundLink({ base, id, token, wallet }) {
  const info = await linkInfo({ base, id, token });
  if (!info.bound) throw new Error('This link isn’t for one person.');
  if (!info.forYou) throw new ApiError(403, 'This file was sent to someone else.', info);
  const key = await unwrapFromSender(wallet, { hash: info.hash, linkId: id, wrap: info.recipientWrap, senderKey: info.senderKey });
  const ck = await importKey(unb64u(key));
  const { meta, header } = await openMeta(ck, info.meta);
  return { ...info, meta, header, ck, token };
}
