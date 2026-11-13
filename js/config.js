// Where the storage API lives. bStoreX uses bDriveX's storage API: same accounts, same quota, same files.
// Production is always https://files.bdrivex.com. Only on a local copy of the site (127.0.0.1 or localhost) can it be
// pointed elsewhere, with ?api=http://127.0.0.1:8790 once (kept for the tab). Never on bstorex.com: a page that let a
// link choose its API could be made to hand a sign-in to someone else's server.
const PROD_API = 'https://files.bdrivex.com';
const LOCAL_API = 'http://127.0.0.1:8787';

function pick() {
  const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  if (!local) return PROD_API;
  const asked = new URLSearchParams(location.search).get('api');
  const ok = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u || '') || u === PROD_API;
  try {
    if (ok(asked)) sessionStorage.setItem('bsx:api', asked);
    const kept = sessionStorage.getItem('bsx:api');
    if (ok(kept)) return kept;
  } catch {}
  return LOCAL_API;
}

export const API = pick();
// bDriveX's site, for sharing links and the full file manager.
export const BDRIVEX = 'https://bdrivex.com';
