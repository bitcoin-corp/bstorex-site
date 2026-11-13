// Copied unchanged from bitcoin-corp/bdrivex-site js/ui.js at main 536791a (formatting helpers shared with bDriveX).

// Small helpers shared by /send and /s/:id.
export const $ = (s, el = document) => el.querySelector(s);
export const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function bytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
export const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
export const ext = (name) => { const m = /\.([a-z0-9]{1,5})$/i.exec(name || ''); return m ? m[1] : 'file'; };
export function eta(sent, total, startedAt) {
  const s = (Date.now() - startedAt) / 1000;
  if (s < 1 || !sent) return '';
  const rate = sent / s, left = (total - sent) / rate;
  return `${bytes(rate)}/s${left > 2 ? ` · ${left < 90 ? Math.ceil(left) + ' s' : Math.ceil(left / 60) + ' min'} left` : ''}`;
}
const TYPES = { apk: 'application/vnd.android.package-archive', pdf: 'application/pdf', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
export const typeOf = (file) => file.type || TYPES[ext(file.name).toLowerCase()] || 'application/octet-stream';
export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// The sign-in token lives only as long as the tab (CTO, 2 Nov 2026): less for a script injected into the page to find.
export const tabStore = {
  get(k, d) { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
