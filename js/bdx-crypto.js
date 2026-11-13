// Copied unchanged from bitcoin-corp/bdrivex-site js/bdx-crypto.js at main 536791a.
// bStoreX and bDriveX are two front doors to the same storage API (files.bdrivex.com), so files must be sealed
// exactly the same way. Fix bugs upstream in bdrivex-site first, then copy the file here again.

// BDX1: how bDriveX seals a file in the browser before upload. The server only ever sees the output.
//
//   header   16 bytes   "BDX1" | version 1 | log2(segment size) | 3 zero bytes | 7-byte random prefix
//   segments            each plaintext segment (1 MiB, the last may be shorter or empty) sealed with
//                       AES-256-GCM: IV = prefix | segment index (u32, big-endian) | 1 if last else 0,
//                       AAD = the header. The last-segment flag stops truncation, the index stops reordering.
//   meta                {name, type, size} as JSON, padded, sealed with IV = prefix | ffffffff | 2, stored
//                       beside the blob as base64url(header | sealed). The server can't read the file name.
//
// One random 256-bit key per file. It travels only in the share link's #fragment, never to the server.
// Works in browsers and Node 20+ (WebCrypto).

export const SEG_LOG2 = 20;
export const SEG = 1 << SEG_LOG2;
export const TAG = 16;
export const HEADER = 16;
const MAGIC = [0x42, 0x44, 0x58, 0x31]; // BDX1

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const u8 = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
  return u8;
};
export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

/** A fresh key and header for one file. */
export function newSeal() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const header = new Uint8Array(HEADER);
  header.set(MAGIC, 0);
  header[4] = 1;
  header[5] = SEG_LOG2;
  header.set(crypto.getRandomValues(new Uint8Array(7)), 9);
  return { key, header };
}

export function checkHeader(h) {
  if (!(h instanceof Uint8Array) || h.length !== HEADER || MAGIC.some((m, i) => h[i] !== m) || h[4] !== 1 || h[5] !== SEG_LOG2)
    throw new Error('Not a bDriveX file (bad header).');
}

export const importKey = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

function iv(header, index, flag) {
  const v = new Uint8Array(12);
  v.set(header.subarray(9, 16), 0);
  new DataView(v.buffer).setUint32(7, index >>> 0, false);
  v[11] = flag;
  return v;
}

/** Segments in a file of this many plaintext bytes (an empty file still has one, empty, last segment). */
export const segmentCount = (plainSize) => Math.max(1, Math.ceil(plainSize / SEG));
export const sealedSize = (plainSize) => HEADER + plainSize + segmentCount(plainSize) * TAG;
/** Plaintext size from the sealed size. */
export function plainSizeOf(sealed) {
  const body = sealed - HEADER;
  const n = Math.max(1, Math.ceil(body / (SEG + TAG)));
  const p = body - n * TAG;
  if (body < TAG || p < 0) throw new Error('Bad sealed size.');
  return p;
}

export async function sealSegment(ck, header, index, last, plain) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv(header, index, last ? 1 : 0), additionalData: header }, ck, plain));
}
export async function openSegment(ck, header, index, last, sealed) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv(header, index, last ? 1 : 0), additionalData: header }, ck, sealed));
  } catch {
    throw new Error('This file could not be decrypted: the link is wrong or the file was changed.');
  }
}

/** Meta padded to a multiple of 256 bytes so its length says little about the file name. */
export async function sealMeta(ck, header, meta) {
  const json = enc.encode(JSON.stringify(meta));
  const padded = new Uint8Array(Math.ceil((json.length + 1) / 256) * 256).fill(0x20);
  padded.set(json, 0);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv(header, 0xffffffff, 2), additionalData: header }, ck, padded));
  const out = new Uint8Array(HEADER + ct.length);
  out.set(header, 0);
  out.set(ct, HEADER);
  return b64u(out);
}
export async function openMeta(ck, metaB64) {
  const all = unb64u(metaB64);
  const header = all.subarray(0, HEADER);
  checkHeader(header);
  let pt;
  try {
    pt = await subtle.decrypt({ name: 'AES-GCM', iv: iv(header, 0xffffffff, 2), additionalData: header }, ck, all.subarray(HEADER));
  } catch {
    throw new Error('This link’s key is wrong or incomplete. Check you copied the whole link.');
  }
  return { meta: JSON.parse(dec.decode(pt).trimEnd()), header: header.slice() };
}

export const encodeText = (s) => enc.encode(s);
