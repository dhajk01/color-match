(() => {
  'use strict';
  const C = window.ColorLib, L = window.MatchLogic;
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries(['cam', 'freeze', 'mask', 'stage', 'best', 'bestTag', 'ring', 'targetBtn', 'tSw', 'tHex', 'wbPill', 'settingsBtn',
    'verdict', 'vText', 'vDe', 'seeSw', 'seeHex', 'tgtSw', 'tgtHex', 'bestInfo', 'hint', 'holdBtn', 'hlBtn', 'wbBtn', 'toast',
    'gate', 'gateMsg', 'gateStart', 'targetDlg', 'targetForm', 'hexIn', 'hexErr', 'colIn', 'recents', 'tdCancel',
    'settingsDlg', 'tolIn', 'tolOut', 'wbStatus', 'wbReset', 'setClose'].map((id) => [id, $(id)]));

  const KEY = 'colormatch.v1';
  const SCAN_W = 80;          // analysis grid width in cells; height follows the screen shape
  const FRAME_MS = 80;        // at most about 12 analyses a second
  const RING = { S: 0.035, M: 0.07, L: 0.13 }; // ring radius as a fraction of screen width
  const WORDS = { match: 'Match', close: 'Close', no: 'Not a match', idle: 'Aim the ring at something' };

  // ---- settings (kept on this device only) -------------------------------------------------
  const hexOf = (rgb) => C.toHex(rgb[0], rgb[1], rgb[2]);
  function loadSettings() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { raw = {}; }
    const tol = Number(raw.tol);
    const gains = Array.isArray(raw.gains) && raw.gains.length === 3 && raw.gains.every((g) => Number.isFinite(g) && g > 0.2 && g < 6) ? raw.gains : null;
    return {
      target: C.parseHex(raw.target) || [123, 3, 35],
      recents: (Array.isArray(raw.recents) ? raw.recents : []).filter((h) => C.parseHex(h)).slice(0, 6),
      tol: tol >= 1 && tol <= 15 ? tol : 5,
      kL: raw.kL === 1 ? 1 : 3,
      ring: RING[raw.ring] ? raw.ring : 'M',
      gains,
      wbAt: gains ? Number(raw.wbAt) || 0 : 0,
      hl: raw.hl === true,
    };
  }
  const S = loadSettings();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ ...S, target: hexOf(S.target) })); } catch (e) { /* private mode: fine */ } };
  let targetLab = C.rgbToLab(...S.target);

  // ---- camera ----------------------------------------------------------------------------
  let stream = null, wakeLock = null;
  const pos = { x: 0.5, y: 0.5 };           // ring position, 0..1 of the screen (centre while live)
  let live = null, held = null, lastT = 0, last = null;
  const scan = { key: '', crop: null, stages: [] };

  function describeCameraError(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError':
        return 'The camera is blocked. iPhone: Settings, Safari, Camera, choose Allow (or tap aA in the address bar, Website Settings, Camera). Android: tap the lock icon by the address, Permissions, Camera, Allow. Then tap Try again.';
      case 'NotFoundError': case 'OverconstrainedError': return 'No camera was found on this device.';
      case 'NotReadableError': case 'AbortError': return 'The camera is in use by another app. Close it, then tap Try again.';
      default: return `The camera could not start (${(e && (e.name || e.message)) || 'unknown error'}). Tap Try again.`;
    }
  }

  function showGate(msg, label) {
    document.body.dataset.camera = label === 'error' ? 'error' : 'off';
    ui.gateMsg.textContent = msg;
    ui.gateStart.textContent = label === 'error' ? 'Try again' : 'Start camera';
    ui.gate.hidden = false;
  }

  async function startCamera() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      showGate('This browser cannot use the camera on this page. Open the link in Safari on iPhone or Chrome on Android, over https.', 'error');
      return;
    }
    ui.gateStart.disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      ui.gateStart.disabled = false;
      showGate(describeCameraError(e), 'error');
      return;
    }
    ui.gateStart.disabled = false;
    ui.cam.srcObject = stream;
    try { await ui.cam.play(); } catch (e) { /* autoplay is allowed for muted inline video; keep going */ }
    stream.getVideoTracks()[0].addEventListener('ended', () => showGate('The camera stopped. Tap Start camera to turn it back on.', 'off'));
    ui.gate.hidden = true;
    document.body.dataset.camera = 'live';
    requestWake();
  }

  async function requestWake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  }

  // The visible part of the video (it is shown "cover"), shrunk by halves to a small grid so every cell is an average.
  function prepareScan(vw, vh, ew, eh, key) {
    const s = Math.max(ew / vw, eh / vh), sw = ew / s, sh = eh / s;
    scan.crop = [(vw - sw) / 2, (vh - sh) / 2, sw, sh];
    const W = SCAN_W, H = Math.max(8, Math.round((W * eh) / ew));
    const sizes = [];
    let cw = sw, ch = sh;
    while (cw >= 2 * W) { cw = Math.floor(cw / 2); ch = Math.floor(ch / 2); sizes.push([cw, ch]); }
    sizes.push([W, H]);
    scan.stages = sizes.map(([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      return { canvas, w, h, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
    });
    scan.key = key;
  }

  function grab() {
    const vw = ui.cam.videoWidth, vh = ui.cam.videoHeight, ew = ui.cam.clientWidth, eh = ui.cam.clientHeight;
    const key = `${vw}x${vh}/${ew}x${eh}`;
    if (scan.key !== key) prepareScan(vw, vh, ew, eh, key);
    let src = ui.cam, a = scan.crop;
    for (const st of scan.stages) {
      st.ctx.drawImage(src, a[0], a[1], a[2], a[3], 0, 0, st.w, st.h);
      src = st.canvas; a = [0, 0, st.w, st.h];
    }
    const end = scan.stages[scan.stages.length - 1];
    return { rgba: end.ctx.getImageData(0, 0, end.w, end.h).data, W: end.w, H: end.h, ew, eh };
  }

  function tick(t) {
    requestAnimationFrame(tick);
    if (held || !stream || t - lastT < FRAME_MS || ui.cam.readyState < 2 || !ui.cam.videoWidth) return;
    lastT = t;
    live = grab();
    render();
  }

  // ---- analysis + drawing ------------------------------------------------------------------
  const setText = (n, v) => { if (n.textContent !== v) n.textContent = v; };

  function ringOf(fr) { return { x: pos.x * fr.W, y: pos.y * fr.H, r: Math.max(1, RING[S.ring] * fr.W) }; }

  function render() {
    const fr = held || live;
    if (!fr) return;
    const ring = ringOf(fr);
    const margin = Math.max(1, 0.3 * S.tol);
    const res = L.analyzeFrame({ rgba: fr.rgba, w: fr.W, h: fr.H, gains: S.gains, targetLab, kL: S.kL, ring, margin });
    last = { fr, ring, res };
    const { reading, best } = res;

    const st = L.verdict(reading.dE, S.tol);
    ui.verdict.dataset.state = st;
    setText(ui.vText, WORDS[st]);
    setText(ui.vDe, `ΔE ${reading.dE.toFixed(1)}`);
    setText(ui.seeHex, reading.hex);
    ui.seeSw.style.background = reading.hex;

    const ringPx = { x: pos.x * fr.ew, y: pos.y * fr.eh, r: RING[S.ring] * fr.ew };
    ui.ring.style.left = `${ringPx.x}px`; ui.ring.style.top = `${ringPx.y}px`;
    ui.ring.style.width = ui.ring.style.height = `${ringPx.r * 2}px`;

    // marker (at the middle of the closest patch): only when something clearly closer than the ring exists elsewhere in view
    if (best.dE > 2 * S.tol) {
      ui.best.hidden = true;
      setText(ui.bestInfo, `Nothing close to the target in view (closest ΔE ${best.dE.toFixed(0)}).`);
    } else if (reading.dE <= best.dE + margin) {
      ui.best.hidden = true;
      setText(ui.bestInfo, 'The closest spot in view is right here.');
    } else {
      ui.best.hidden = false;
      ui.best.style.left = `${((best.x + 0.5) / fr.W) * fr.ew}px`;
      ui.best.style.top = `${((best.y + 0.5) / fr.H) * fr.eh}px`;
      setText(ui.bestTag, `ΔE ${best.dE.toFixed(1)}`);
      setText(ui.bestInfo, `Closest spot in view: ΔE ${best.dE.toFixed(1)} (green marker).`);
    }

    if (S.hl) {
      const m = ui.mask;
      if (m.width !== fr.W || m.height !== fr.H) { m.width = fr.W; m.height = fr.H; }
      m.getContext('2d').putImageData(new ImageData(L.maskFromDE(res.dE, fr.W, fr.H, S.tol), fr.W, fr.H), 0, 0);
    }
  }

  function renderStatic() {
    const hex = hexOf(S.target);
    setText(ui.tHex, hex); setText(ui.tgtHex, hex);
    ui.tSw.style.background = hex; ui.tgtSw.style.background = hex;
    ui.hlBtn.setAttribute('aria-pressed', String(S.hl));
    ui.mask.hidden = !S.hl;
    ui.wbPill.hidden = !S.gains;
    document.body.dataset.wb = S.gains ? 'on' : 'off';
    const when = S.wbAt ? new Date(S.wbAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    setText(ui.wbStatus, S.gains ? `White set${when ? ' at ' + when : ''}` : 'White not set');
    ui.wbReset.disabled = !S.gains;
    ui.tolIn.value = String(S.tol);
    setText(ui.tolOut, `ΔE ${S.tol}`);
    for (const r of document.querySelectorAll('input[name=kL]')) r.checked = Number(r.value) === S.kL;
    for (const r of document.querySelectorAll('input[name=ring]')) r.checked = r.value === S.ring;
  }

  function toast(msg, kind) {
    ui.toast.textContent = msg;
    ui.toast.className = `toast show ${kind || ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { ui.toast.className = 'toast'; }, 4200);
  }

  // ---- hold / white balance / target -------------------------------------------------------
  function hold() {
    if (!live) { toast('Wait for the camera picture first.', 'error'); return; }
    held = live;
    const fz = ui.freeze, dpr = Math.min(2, window.devicePixelRatio || 1);
    fz.width = Math.round(live.ew * dpr); fz.height = Math.round(live.eh * dpr);
    fz.getContext('2d').drawImage(ui.cam, scan.crop[0], scan.crop[1], scan.crop[2], scan.crop[3], 0, 0, fz.width, fz.height);
    fz.hidden = false;
    ui.holdBtn.textContent = 'Resume'; ui.holdBtn.setAttribute('aria-pressed', 'true'); ui.hint.hidden = false;
    render();
  }
  function resume() {
    held = null; pos.x = 0.5; pos.y = 0.5;
    ui.freeze.hidden = true; ui.hint.hidden = true;
    ui.holdBtn.textContent = 'Hold'; ui.holdBtn.setAttribute('aria-pressed', 'false');
  }

  function setWhite() {
    if (!last) { toast('Wait for the camera picture first.', 'error'); return; }
    const { fr, ring } = last;
    const raw = L.sampleLinear(fr.rgba, fr.W, fr.H, ring); // before any correction
    const r = L.whiteGains(raw);
    if (!r.ok) { toast(r.reason, 'error'); return; }       // refuse, and leave the current setting alone
    S.gains = r.gains; S.wbAt = Date.now(); save(); renderStatic(); render();
    toast(r.warning ? `White set. ${r.warning}` : 'White set. Colors are now corrected for this light.', 'ok');
  }
  function clearWhite() { S.gains = null; S.wbAt = 0; save(); renderStatic(); render(); toast('White cleared.'); }

  function openDlg(d) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
  function closeDlg(d) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }

  function applyTarget(rgb) {
    S.target = rgb; targetLab = C.rgbToLab(...rgb);
    const hex = hexOf(rgb);
    S.recents = [hex, ...S.recents.filter((h) => h.toUpperCase() !== hex)].slice(0, 6);
    save(); renderStatic(); render();
  }

  function openTarget() {
    ui.hexIn.value = hexOf(S.target); ui.hexIn.removeAttribute('aria-invalid'); ui.hexErr.hidden = true;
    ui.colIn.value = hexOf(S.target).toLowerCase();
    ui.recents.replaceChildren(...S.recents.map((h) => {
      const b = document.createElement('button');
      b.type = 'button';
      const dot = document.createElement('i'); dot.style.background = h;
      b.append(dot, h);
      b.addEventListener('click', () => { applyTarget(C.parseHex(h)); closeDlg(ui.targetDlg); });
      return b;
    }));
    openDlg(ui.targetDlg);
  }

  // ---- wiring ---------------------------------------------------------------------------------
  ui.gateStart.addEventListener('click', startCamera);
  ui.holdBtn.addEventListener('click', () => (held ? resume() : hold()));
  ui.hlBtn.addEventListener('click', () => { S.hl = !S.hl; save(); renderStatic(); render(); });
  ui.wbBtn.addEventListener('click', setWhite);
  ui.wbPill.addEventListener('click', clearWhite);
  ui.wbReset.addEventListener('click', clearWhite);
  ui.targetBtn.addEventListener('click', openTarget);
  ui.tdCancel.addEventListener('click', () => closeDlg(ui.targetDlg));
  ui.settingsBtn.addEventListener('click', () => openDlg(ui.settingsDlg));
  ui.setClose.addEventListener('click', () => closeDlg(ui.settingsDlg));

  ui.hexIn.addEventListener('input', () => {
    const rgb = C.parseHex(ui.hexIn.value);
    ui.hexErr.hidden = true; ui.hexIn.removeAttribute('aria-invalid');
    if (rgb) ui.colIn.value = hexOf(rgb).toLowerCase();
  });
  ui.colIn.addEventListener('input', () => { ui.hexIn.value = ui.colIn.value.toUpperCase(); ui.hexErr.hidden = true; ui.hexIn.removeAttribute('aria-invalid'); });
  ui.targetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const rgb = C.parseHex(ui.hexIn.value);
    if (!rgb) { ui.hexIn.setAttribute('aria-invalid', 'true'); ui.hexErr.hidden = false; ui.hexIn.focus(); return; }
    applyTarget(rgb);
    closeDlg(ui.targetDlg);
  });

  ui.tolIn.addEventListener('input', () => { S.tol = Number(ui.tolIn.value); setText(ui.tolOut, `ΔE ${S.tol}`); save(); render(); });
  for (const r of document.querySelectorAll('input[name=kL]')) r.addEventListener('change', () => { if (r.checked) { S.kL = Number(r.value); save(); render(); } });
  for (const r of document.querySelectorAll('input[name=ring]')) r.addEventListener('change', () => { if (r.checked) { S.ring = r.value; save(); render(); } });

  // while held, a tap moves the ring to read that spot
  ui.stage.addEventListener('pointerdown', (e) => {
    if (!held) return;
    pos.x = Math.min(1, Math.max(0, e.clientX / ui.cam.clientWidth));
    pos.y = Math.min(1, Math.max(0, e.clientY / ui.cam.clientHeight));
    render();
  });

  window.addEventListener('resize', () => { if (held) resume(); scan.key = ''; });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    requestWake();
    const t = stream && stream.getVideoTracks()[0];
    if (t && t.readyState === 'ended') showGate('The camera stopped. Tap Start camera to turn it back on.', 'off');
  });

  renderStatic();
  requestAnimationFrame(tick);

  // reopen straight into the camera when this device already allowed it
  (async () => {
    try { const p = await navigator.permissions.query({ name: 'camera' }); if (p.state === 'granted') startCamera(); } catch (e) { /* Safari has no camera permission query: show the Start button */ }
  })();

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
})();
