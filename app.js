(() => {
  'use strict';
  const C = window.ColorLib, L = window.MatchLogic, M = window.MatchItems;
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries(['cam', 'freeze', 'mask', 'stage', 'best', 'bestTag', 'ring', 'topbar', 'panel', 'targetBtn', 'tSw', 'tHex', 'wbPill', 'settingsBtn',
    'verdict', 'vText', 'vDe', 'seeSw', 'seeHex', 'tgtSw', 'tgtHex', 'bestInfo', 'hint', 'holdBtn', 'hlBtn', 'wbBtn', 'srcBtn', 'toast',
    'gate', 'gateMsg', 'gateStart', 'gateScreen', 'targetDlg', 'targetForm', 'hexIn', 'hexErr', 'colIn', 'recents', 'tdCancel',
    'viewTabs', 'tabPic', 'tabFound', 'foundBadge', 'found', 'foundCount', 'foundEmpty', 'foundList', 'collectBtn', 'clearBtn',
    'settingsDlg', 'tolIn', 'tolOut', 'kLNote', 'wbStatus', 'wbReset', 'setClose'].map((id) => [id, $(id)]));

  const KEY = 'colormatch.v1';
  // Two sources. A camera is noisy and lit by the shop, so it gets a coarse grid, white balance and forgiving brightness.
  // A shared screen is exact and mostly still, so it gets a fine grid, a slower refresh and no corrections.
  const SCAN_W = { camera: 80, screen: 240 };         // analysis grid width in cells; height follows the picture shape
  const FRAME_MS = { camera: 80, screen: 250 };       // camera: about 12 analyses a second
  const RING = { camera: { S: 0.035, M: 0.07, L: 0.13 }, screen: { S: 0.004, M: 0.01, L: 0.025 } }; // ring radius as a fraction of picture width
  const MIN_RING_PX = { camera: 0, screen: 11 };      // a screen ring is tiny: keep it visible
  const WORDS = { match: 'Match', close: 'Close', no: 'Not a match', idle: 'Aim the ring at something' };

  // ---- settings (kept on this device only) -------------------------------------------------
  const hexOf = (rgb) => C.toHex(rgb[0], rgb[1], rgb[2]);
  function loadSettings() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { raw = {}; }
    const tol = Number(raw.tol), tolS = Number(raw.tolS);
    const gains = Array.isArray(raw.gains) && raw.gains.length === 3 && raw.gains.every((g) => Number.isFinite(g) && g > 0.2 && g < 6) ? raw.gains : null;
    return {
      target: C.parseHex(raw.target) || [123, 3, 35],
      recents: (Array.isArray(raw.recents) ? raw.recents : []).filter((h) => C.parseHex(h)).slice(0, 6),
      tol: tol >= 1 && tol <= 15 ? tol : 5,
      tolS: tolS >= 1 && tolS <= 15 ? tolS : 3,   // a screen is exact, so a match can be stricter
      kL: raw.kL === 1 ? 1 : 3,
      ring: RING.camera[raw.ring] ? raw.ring : 'M',
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
  let source = 'camera';                    // 'camera' | 'screen' (a shared tab, window or screen: computers only)
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  const pos = { x: 0.5, y: 0.5 };           // ring position, 0..1 of the picture (centre while the camera is live)
  let live = null, held = null, lastT = 0, last = null, laidOut = '';
  const scan = { key: '', crop: null, stages: [] };
  let view = 'picture', collecting = true, foundAt = '';   // shared page only: 'picture' | 'list'
  const items = M.create({ max: 40 });
  const tolNow = () => (source === 'screen' ? S.tolS : S.tol);
  const kLNow = () => (source === 'screen' ? 1 : S.kL);           // a screen has no lighting: brightness counts fully
  const gainsNow = () => (source === 'screen' ? null : S.gains);  // ...and no white balance

  function describeCameraError(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError':
        return 'The camera is blocked. iPhone: Settings, Safari, Camera, choose Allow (or tap aA in the address bar, Website Settings, Camera). Android: tap the lock icon by the address, Permissions, Camera, Allow. Then tap Try again.';
      case 'NotFoundError': case 'OverconstrainedError': return 'No camera was found on this device.';
      case 'NotReadableError': case 'AbortError': return 'The camera is in use by another app. Close it, then tap Try again.';
      default: return `The camera could not start (${(e && (e.name || e.message)) || 'unknown error'}). Tap Try again.`;
    }
  }

  function describeShareError(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError':
        return 'Sharing was cancelled or blocked. Pick a tab or window and tap Share. On a Mac, if windows or screens are blocked: System Settings, Privacy & Security, Screen Recording, allow this browser, then restart it.';
      case 'NotFoundError': return 'There is nothing to share on this computer.';
      default: return `Sharing could not start (${(e && (e.name || e.message)) || 'unknown error'}).`;
    }
  }

  function showGate(msg, label) {
    document.body.dataset.camera = label === 'error' ? 'error' : 'off';
    ui.gateMsg.textContent = msg;
    ui.gateStart.textContent = label === 'error' ? 'Try again' : 'Start camera';
    ui.gate.hidden = false;
  }

  // The newest request wins: a slower, older one (say the camera auto-starting while you tap "Read a page") must not replace it.
  let wanted = 0;
  const drop = (s) => { for (const t of s.getTracks()) t.stop(); };

  function stopStream() {
    if (stream) for (const t of stream.getTracks()) t.stop();   // stop() does not fire 'ended', so no stray "stopped" message
    stream = null;
  }

  // Switch to a new live stream: drop the old picture and everything measured from it.
  async function adopt(s, src, onEnded) {
    stopStream();
    if (held) resume();
    stream = s; source = src; live = null; last = null; laidOut = ''; scan.key = '';
    s.getVideoTracks()[0].addEventListener('ended', onEnded);   // before anything is awaited, so an early stop is not missed
    document.body.dataset.source = src;
    if (src === 'camera') { pos.x = 0.5; pos.y = 0.5; }
    items.reset(); setView('picture');
    ui.cam.srcObject = s;
    try { await ui.cam.play(); } catch (e) { /* autoplay is allowed for muted inline video; keep going */ }
    if (s.getVideoTracks()[0].readyState === 'ended') { onEnded(); return; }   // stopped while starting
    ui.gate.hidden = true;
    document.body.dataset.camera = 'live';
    renderStatic(); updateHint();
    requestWake();
  }

  async function startCamera() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      showGate('This browser cannot use the camera on this page. Open the link in Safari on iPhone or Chrome on Android, over https.', 'error');
      return;
    }
    ui.gateStart.disabled = true;
    const mine = ++wanted;
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      ui.gateStart.disabled = false;
      if (mine === wanted) showGate(describeCameraError(e), 'error');
      return;
    }
    ui.gateStart.disabled = false;
    if (mine !== wanted) { drop(s); return; }
    await adopt(s, 'camera', () => showGate('The camera stopped. Tap Start camera to turn it back on.', 'off'));
  }

  // Read another tab, window or the whole screen, like Digital Color Meter does. The browser asks what to share.
  async function startScreen() {
    if (!canShare) { toast('This browser cannot share a screen. Use Chrome, Edge or Firefox on a computer.', 'error'); return; }
    const mine = ++wanted;
    let s;
    try {
      s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 15 } }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' });
    } catch (e) {   // cancelled or blocked: the camera, if it was running or starting, carries on
      if (mine === wanted) { wanted--; toast(describeShareError(e), 'error'); }
      return;
    }
    if (mine !== wanted) { drop(s); return; }
    await adopt(s, 'screen', () => { showGate('Sharing stopped. Share again to keep reading a page, or switch to the camera.', 'off'); });
  }

  async function requestWake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  }

  // The visible part of the video (it is shown "cover"), shrunk by halves to a small grid so every cell is an average.
  function prepareScan(vw, vh, ew, eh, key) {
    const s = Math.max(ew / vw, eh / vh), sw = ew / s, sh = eh / s;
    scan.crop = [(vw - sw) / 2, (vh - sh) / 2, sw, sh];
    const W = SCAN_W[source], H = Math.max(8, Math.round((W * eh) / ew));
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
    const key = `${source}/${vw}x${vh}/${ew}x${eh}`;
    if (scan.key !== key) prepareScan(vw, vh, ew, eh, key);
    let src = ui.cam, a = scan.crop;
    for (const st of scan.stages) {
      st.ctx.drawImage(src, a[0], a[1], a[2], a[3], 0, 0, st.w, st.h);
      src = st.canvas; a = [0, 0, st.w, st.h];
    }
    const end = scan.stages[scan.stages.length - 1];
    return { rgba: end.ctx.getImageData(0, 0, end.w, end.h).data, W: end.w, H: end.h, ew, eh };
  }

  // A shared screen is shown whole (not cropped to fill), in a box with the screen's own shape between the top bar and the panel.
  function layoutScreen() {
    const vw = ui.cam.videoWidth, vh = ui.cam.videoHeight, st = document.body.style;
    let box = '';
    if (source === 'screen' && vw && vh) {
      const top = ui.topbar.offsetHeight, aw = window.innerWidth, ah = Math.max(80, window.innerHeight - top - ui.panel.offsetHeight);
      const k = Math.min(aw / vw, ah / vh), w = Math.floor(vw * k), h = Math.floor(vh * k);
      box = [Math.round((aw - w) / 2), Math.round(top + (ah - h) / 2), w, h].join(' ');
    }
    if (box === laidOut) return;
    laidOut = box;
    const [x, y, w, h] = box ? box.split(' ') : [];
    for (const [k, v] of [['--bx', x], ['--by', y], ['--bw', w], ['--bh', h]]) { if (box) st.setProperty(k, `${v}px`); else st.removeProperty(k); }
    scan.key = '';
  }

  function tick(t) {
    requestAnimationFrame(tick);
    if (held || !stream || t - lastT < FRAME_MS[source] || ui.cam.readyState < 2 || !ui.cam.videoWidth) return;
    lastT = t;
    if (source === 'screen') layoutScreen();
    live = grab();
    render();
    if (source === 'screen') { collect(); if (view === 'list') layoutFound(); }
  }

  // ---- analysis + drawing ------------------------------------------------------------------
  const setText = (n, v) => { if (n.textContent !== v) n.textContent = v; };

  function ringOf(fr) { return { x: pos.x * fr.W, y: pos.y * fr.H, r: Math.max(1, RING[source][S.ring] * fr.W) }; }

  // ringOnly: just the ring moved, so keep the analysis of the frame and read the new spot (the whole frame is a lot of work on a screen)
  function render(ringOnly) {
    const fr = held || live;
    if (!fr) return;
    const ring = ringOf(fr);
    const tol = tolNow();
    const margin = Math.max(1, 0.3 * tol);
    const reuse = ringOnly && last && last.fr === fr && last.tol === tol ? last.res : null;
    const res = reuse
      ? { dE: reuse.dE, best: reuse.best, reading: L.readingAt(fr.rgba, fr.W, fr.H, ring, gainsNow(), targetLab, kLNow()) }
      : L.analyzeFrame({ rgba: fr.rgba, w: fr.W, h: fr.H, gains: gainsNow(), targetLab, kL: kLNow(), ring, margin });
    last = { fr, ring, res, tol };
    const { reading, best } = res;

    const st = L.verdict(reading.dE, tol);
    ui.verdict.dataset.state = st;
    setText(ui.vText, WORDS[st]);
    setText(ui.vDe, `ΔE ${reading.dE.toFixed(1)}`);
    setText(ui.seeHex, reading.hex);
    ui.seeSw.style.background = reading.hex;

    const ringPx = { x: pos.x * fr.ew, y: pos.y * fr.eh, r: Math.max(MIN_RING_PX[source], RING[source][S.ring] * fr.ew) };
    ui.ring.style.left = `${ringPx.x}px`; ui.ring.style.top = `${ringPx.y}px`;
    ui.ring.style.width = ui.ring.style.height = `${ringPx.r * 2}px`;

    // marker (at the middle of the closest patch): only when something clearly closer than the ring exists elsewhere in view
    if (best.dE > 2 * tol) {
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

    if (S.hl && !reuse) {
      const m = ui.mask;
      if (m.width !== fr.W || m.height !== fr.H) { m.width = fr.W; m.height = fr.H; }
      m.getContext('2d').putImageData(new ImageData(L.maskFromDE(res.dE, fr.W, fr.H, tol), fr.W, fr.H), 0, 0);
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
    ui.srcBtn.hidden = !canShare;                     // phones cannot share a screen
    setText(ui.srcBtn, source === 'screen' ? 'Use camera' : 'Share a page');
    ui.gateScreen.hidden = !canShare;
    ui.kLNote.hidden = source !== 'screen';
    ui.viewTabs.hidden = source !== 'screen';
    const when = S.wbAt ? new Date(S.wbAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    setText(ui.wbStatus, S.gains ? `White set${when ? ' at ' + when : ''}` : 'White not set');
    ui.wbReset.disabled = !S.gains;
    ui.tolIn.value = String(tolNow());
    setText(ui.tolOut, `ΔE ${tolNow()}`);
    for (const r of document.querySelectorAll('input[name=kL]')) r.checked = Number(r.value) === S.kL;
    for (const r of document.querySelectorAll('input[name=ring]')) r.checked = r.value === S.ring;
  }

  function toast(msg, kind) {
    ui.toast.textContent = msg;
    ui.toast.className = `toast show ${kind || ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { ui.toast.className = 'toast'; }, 4200);
  }

  // ---- found list (shared page): patches that stay on screen and are close to the target, best first ------------
  const SIG = 16, THUMB = 220, MAX_REGIONS = 6;
  const sigCv = Object.assign(document.createElement('canvas'), { width: SIG, height: SIG });
  const sigCtx = sigCv.getContext('2d', { willReadFrequently: true });
  const thumbCv = document.createElement('canvas'), thumbCtx = thumbCv.getContext('2d');

  // the part of the live video under a box of grid cells (plus a margin), in video pixels
  function videoRect(fr, b, pad) {
    const [cx, cy, cw, ch] = scan.crop, kx = cw / fr.W, ky = ch / fr.H, px = pad * (b.x1 - b.x0), py = pad * (b.y1 - b.y0);
    const x0 = Math.max(0, b.x0 - px), y0 = Math.max(0, b.y0 - py), x1 = Math.min(fr.W, b.x1 + px), y1 = Math.min(fr.H, b.y1 + py);
    return [cx + x0 * kx, cy + y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky];
  }
  function signature(fr, b) {   // a tiny picture of the patch: how the same item is recognised when it comes back
    const [x, y, w, h] = videoRect(fr, b, 0);
    sigCtx.drawImage(ui.cam, x, y, w, h, 0, 0, SIG, SIG);
    const px = sigCtx.getImageData(0, 0, SIG, SIG).data, out = new Uint8Array(SIG * SIG * 3);
    for (let i = 0, j = 0; i < px.length; i += 4) { out[j++] = px[i]; out[j++] = px[i + 1]; out[j++] = px[i + 2]; }
    return out;
  }
  function thumbnail(fr, b) {
    const [x, y, w, h] = videoRect(fr, b, 0.06), k = Math.min(1, THUMB / Math.max(w, h));
    thumbCv.width = Math.max(1, Math.round(w * k)); thumbCv.height = Math.max(1, Math.round(h * k));
    thumbCtx.drawImage(ui.cam, x, y, w, h, 0, 0, thumbCv.width, thumbCv.height);
    return thumbCv.toDataURL('image/jpeg', 0.82);
  }

  function collect() {
    if (!collecting || !last || last.fr !== live) return;
    const fr = live, dE = last.res.dE;
    // patches cut off by the screen's edge wait until they are scrolled fully into view
    const found = L.findRegions(dE, fr.W, fr.H, { limit: 2 * tolNow(), minCells: 16 }).filter((r) => !r.edge);
    const cands = found.sort((a, b) => b.cells.length - a.cells.length).slice(0, 12)
      .map((r) => ({ r, st: L.regionStats(fr.rgba, r, null, targetLab, 1, dE) }))
      .sort((a, b) => a.st.dE - b.st.dE).slice(0, MAX_REGIONS)
      .map(({ r, st }) => ({ box: r.box, dE: st.dE, hex: st.hex, cells: r.cells.length, sig: signature(fr, r.box), make: () => thumbnail(fr, r.box) }));
    const ev = items.ingest(cands, Date.now());
    if (!ev.length) return;
    renderList();
    const hit = ev.find((e) => e.type === 'new' && L.verdict(e.item.dE, tolNow()) === 'match');
    if (hit && view === 'picture') toast(`Found a match (ΔE ${hit.item.dE.toFixed(1)}). See the Found tab.`, 'ok');
  }

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  function renderList() {
    const list = items.list(), tol = tolNow();
    setText(ui.foundBadge, String(list.length));
    setText(ui.foundCount, `${list.length ? `${list.length} item${list.length === 1 ? '' : 's'}, best first` : 'Nothing yet'}${collecting ? '' : ' (paused)'}`);
    ui.foundEmpty.hidden = list.length > 0;
    ui.foundList.replaceChildren(...list.map((it, i) => {
      const st = L.verdict(it.dE, tol), li = el('li', 'card');
      li.dataset.state = st;
      const img = new Image(); img.src = it.thumb; img.alt = `Item ${i + 1}`;
      const rm = el('button', 'rm', '✕'); rm.type = 'button'; rm.setAttribute('aria-label', `Remove item ${i + 1}`);
      rm.addEventListener('click', () => { items.remove(it.id); renderList(); });
      const col = el('div', 'col'), dot = el('i'); dot.style.background = it.hex; col.append(dot, it.hex);
      const when = new Date(it.last).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      li.append(img, el('span', 'rank', `#${i + 1}`), rm, el('div', 'res', `${WORDS[st]} · ΔE ${it.dE.toFixed(1)}`), col, el('small', '', `Seen ${it.seen}× · last ${when}`));
      return li;
    }));
  }

  function layoutFound() {   // the list fills the space between the top bar and the panel
    const t = ui.topbar.offsetHeight, b = ui.panel.offsetHeight, key = `${t}/${b}`;
    if (key === foundAt) return;
    foundAt = key; ui.found.style.top = `${t}px`; ui.found.style.bottom = `${b}px`;
  }
  function setView(v) {
    view = v; foundAt = '';
    document.body.dataset.view = v;
    ui.found.hidden = v !== 'list';
    ui.tabPic.setAttribute('aria-pressed', String(v === 'picture'));
    ui.tabFound.setAttribute('aria-pressed', String(v === 'list'));
    if (v === 'list') { ui.toast.className = 'toast'; layoutFound(); }   // the list is the answer to "Found a match"
  }

  // ---- hold / white balance / target -------------------------------------------------------
  function hold() {
    if (!live) { toast('Wait for the camera picture first.', 'error'); return; }
    held = live;
    const fz = ui.freeze, dpr = Math.min(2, window.devicePixelRatio || 1);
    fz.width = Math.round(live.ew * dpr); fz.height = Math.round(live.eh * dpr);
    fz.getContext('2d').drawImage(ui.cam, scan.crop[0], scan.crop[1], scan.crop[2], scan.crop[3], 0, 0, fz.width, fz.height);
    fz.hidden = false;
    ui.holdBtn.textContent = 'Resume'; ui.holdBtn.setAttribute('aria-pressed', 'true');
    updateHint();
    render();
  }
  function resume() {
    held = null;
    if (source === 'camera') { pos.x = 0.5; pos.y = 0.5; }   // a camera ring sits in the middle; a screen ring stays where you put it
    ui.freeze.hidden = true;
    ui.holdBtn.textContent = 'Hold'; ui.holdBtn.setAttribute('aria-pressed', 'false');
    updateHint();
  }
  function updateHint() {
    const screen = source === 'screen';
    ui.hint.hidden = !(held || screen);   // always there on a shared page, so the panel (and the picture above it) never changes height
    ui.hint.textContent = held ? `Held. ${screen ? 'Click' : 'Tap'} anywhere on the picture to read that spot.` : 'Click or drag to move the ring. The green marker shows the closest spot.';
    if (screen) layoutScreen();
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
    if (hexOf(rgb) !== hexOf(S.target) && items.size) { items.clear(); renderList(); toast('The found list was cleared for the new target.'); }
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
  ui.gateScreen.addEventListener('click', startScreen);
  ui.tabPic.addEventListener('click', () => setView('picture'));
  ui.tabFound.addEventListener('click', () => setView('list'));
  ui.clearBtn.addEventListener('click', () => { items.clear(); renderList(); });
  ui.collectBtn.addEventListener('click', () => {
    collecting = !collecting; items.reset();
    setText(ui.collectBtn, collecting ? 'Pause' : 'Collect');
    ui.collectBtn.setAttribute('aria-pressed', String(!collecting));
    renderList();
  });
  ui.srcBtn.addEventListener('click', () => (source === 'screen' ? startCamera() : startScreen()));
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

  ui.tolIn.addEventListener('input', () => {
    if (source === 'screen') S.tolS = Number(ui.tolIn.value); else S.tol = Number(ui.tolIn.value);
    setText(ui.tolOut, `ΔE ${tolNow()}`); save(); render();
  });
  for (const r of document.querySelectorAll('input[name=kL]')) r.addEventListener('change', () => { if (r.checked) { S.kL = Number(r.value); save(); render(); } });
  for (const r of document.querySelectorAll('input[name=ring]')) r.addEventListener('change', () => { if (r.checked) { S.ring = r.value; save(); render(); } });

  // The camera ring sits in the middle; while held, a tap moves it. A shared screen's ring goes wherever you click or drag.
  let dragging = false;
  function moveRing(e) {
    const r = ui.stage.getBoundingClientRect();
    pos.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    pos.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    render(true);
  }
  ui.stage.addEventListener('pointerdown', (e) => {
    if (!held && source !== 'screen') return;
    dragging = true;
    try { ui.stage.setPointerCapture(e.pointerId); } catch (err) { /* optional */ }
    moveRing(e);
  });
  ui.stage.addEventListener('pointermove', (e) => { if (dragging) moveRing(e); });
  for (const ev of ['pointerup', 'pointercancel']) ui.stage.addEventListener(ev, () => { dragging = false; });

  window.addEventListener('resize', () => {
    scan.key = '';
    if (source === 'screen') {   // the picture rescales; a held frame stays held
      layoutScreen(); foundAt = ''; if (view === 'list') layoutFound();
      if (held) { held.ew = ui.cam.clientWidth; held.eh = ui.cam.clientHeight; render(true); }
    } else if (held) resume();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    requestWake();
    const t = stream && stream.getVideoTracks()[0];
    if (t && t.readyState === 'ended') showGate(source === 'screen' ? 'Sharing stopped. Share again to keep reading a page, or switch to the camera.' : 'The camera stopped. Tap Start camera to turn it back on.', 'off');
  });

  renderStatic(); renderList();
  requestAnimationFrame(tick);

  // reopen straight into the camera when this device already allowed it
  (async () => {
    try { const p = await navigator.permissions.query({ name: 'camera' }); if (p.state === 'granted') startCamera(); } catch (e) { /* Safari has no camera permission query: show the Start button */ }
  })();

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
})();
