/* Connect bWalletX (client only, no server). Put <span data-bwx-connect></span> in the header and load this after
   @bwalletx/connect's global build. Asks the wallet for your identity key over BRC-100: the bWalletX extension or
   the iPhone/Android app's in-app browser answer straight away; otherwise a QR pairs the phone app (or paste the
   link into web.bwalletx.com). Once connected, bWalletX wears this site's /.well-known/bwalletx-theme.json.
   It is a connection, not a sign-in: nothing here proves who you are to a server. */
(() => {
  const C = window.bWalletXConnect;
  const slots = [...document.querySelectorAll('[data-bwx-connect]')];
  if (!C || !slots.length) return;
  const STORE = 'bwx:connected';
  const get = () => { try { return localStorage.getItem(STORE); } catch { return null; } };
  const set = (v) => { try { v ? localStorage.setItem(STORE, v) : localStorage.removeItem(STORE); } catch {} };
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const short = (k) => k.slice(0, 6) + '…' + k.slice(-4);
  const css = document.createElement('style');
  css.textContent = `.bwxc{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 16px;border-radius:999px;border:1px solid var(--bwxc-edge,rgba(255,210,77,.45));background:var(--bwxc-bg,#0b0b0c);color:var(--bwxc-fg,#ffd24d);font-family:inherit;font-size:14px;font-weight:600;line-height:1;cursor:pointer;white-space:nowrap}
  .bwxc:hover{border-color:var(--bwxc-fg,#ffd24d)}.bwxc:focus-visible{outline:2px solid var(--bwxc-fg,#ffd24d);outline-offset:2px}
  .bwxc.on{background:var(--bwxc-fg,#ffd24d);color:var(--bwxc-on,#000);border-color:transparent}
  .bwxc i{width:8px;height:8px;border-radius:50%;background:currentColor;display:block;flex:none}
  .bwxc{max-width:min(46vw,260px);overflow:hidden;text-overflow:ellipsis}@media(max-width:520px){.bwxc{padding:0 12px}.bwxc .w{display:none}}`;
  document.head.appendChild(css);
  // Brand colour for the button: <span data-bwx-connect data-fg="#5ab8ff" data-on="#000"></span> (default gold).
  slots.forEach((s) => { if (s.dataset.fg) s.style.setProperty('--bwxc-fg', s.dataset.fg); if (s.dataset.on) s.style.setProperty('--bwxc-on', s.dataset.on); if (s.dataset.fg) s.style.setProperty('--bwxc-edge', s.dataset.fg + '73'); });

  let key = null, handle = null, busy = false;
  const draw = () => slots.forEach((s) => {
    s.innerHTML = '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bwxc' + (key ? ' on' : '');
    b.innerHTML = key ? `<i></i>${esc(handle || short(key))}` : busy ? 'Connecting…' : 'Connect<span class="w"> bWalletX</span>';
    b.title = key ? 'Connected to bWalletX. Click to disconnect.' : 'Connect your bWalletX';
    b.disabled = busy;
    b.onclick = key ? disconnect : () => connect(true);
    s.appendChild(b);
  });
  // Public, CORS-open lookup of the $handle (bWalletX paymail) for an identity key.
  const lookup = async (k) => {
    try {
      const r = await fetch(`https://pay.bwallet.space/api/paymail/lookup?key=${encodeURIComponent(k)}`);
      const j = r.ok ? await r.json() : null;
      if (j && typeof j.paymail === 'string' && key === k) { handle = '$' + j.paymail.split('@')[0]; draw(); }
    } catch {}
  };

  // interactive: the user clicked (pair by QR if no wallet is in this browser). Otherwise only a wallet already in
  // this browser is asked, quietly, so the theme comes back after a reload.
  async function connect(interactive) {
    let modal = null;
    busy = interactive; draw();
    try {
      let wallet;
      if (interactive) {
        modal = C.pairingModal({ title: 'Connect bWalletX' });
        ({ wallet } = await C.connectBwalletX({ pairing: modal }));
      } else {
        const f = await C.discoverBwalletX(800);
        if (!f) return;
        wallet = f.wallet;
      }
      const { publicKey } = await wallet.getPublicKey({ identityKey: true });
      key = publicKey; handle = null; set(key);
      lookup(key);
      document.dispatchEvent(new CustomEvent('bwalletx:connected', { detail: { identityKey: key } }));
    } catch (e) {
      if (interactive && e && e.code === 'NOT_FOUND') location.href = 'https://bwalletx.com/get';
      else if (interactive && !(e && e.name === 'AbortError')) console.warn('bWalletX connect:', e);
    } finally {
      try { modal && modal.close(); } catch {}
      busy = false; draw();
    }
  }
  function disconnect() {
    try { C.clearPairing && C.clearPairing(); } catch {}
    // Tell the bWalletX extension this site disconnected, so it stops wearing the site's theme.
    try { window.postMessage({ type: 'bwallet:disconnect' }, location.origin); } catch {}
    key = null; handle = null; set(null); draw();
    document.dispatchEvent(new CustomEvent('bwalletx:disconnected'));
  }

  draw();
  if (get()) connect(false);
})();
