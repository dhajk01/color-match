// Frame analysis for Color Match. Pure functions, no DOM: window.MatchLogic in the browser, require() in tests.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./color.js') : root.ColorLib);
  if (isNode) module.exports = api;
  else root.MatchLogic = api;
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const LIN = C.srgbToLinear;
  const clamp01 = (v) => (v > 1 ? 1 : v);

  // What counts as "white enough to calibrate on", in linear light.
  const WHITE = { minMean: 0.2, maxSpread: 3.5, clipAt: 0.985 };

  // Cells of a w x h grid whose centre lies within the ring {x, y, r} (cell units). Never empty.
  function cellsInRing(w, h, ring) {
    const { x, y, r } = ring, out = [];
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(w - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(h - 1, Math.ceil(y + r));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx + 0.5 - x, dy = yy + 0.5 - y;
        if (dx * dx + dy * dy <= r * r) out.push(yy * w + xx);
      }
    }
    if (!out.length) out.push(Math.min(h - 1, Math.max(0, Math.floor(y))) * w + Math.min(w - 1, Math.max(0, Math.floor(x))));
    return out;
  }

  // Average linear-light color under the ring, with white-balance gains applied.
  function sampleLinear(rgba, w, h, ring, gains) {
    const g = gains || [1, 1, 1];
    const cells = cellsInRing(w, h, ring);
    let r = 0, gg = 0, b = 0;
    for (const i of cells) {
      const q = i * 4;
      r += clamp01(LIN[rgba[q]] * g[0]);
      gg += clamp01(LIN[rgba[q + 1]] * g[1]);
      b += clamp01(LIN[rgba[q + 2]] * g[2]);
    }
    return [r / cells.length, gg / cells.length, b / cells.length];
  }

  // Gains that make a sample of white paper neutral without darkening it (the brightest channel is the reference).
  // Refuses, with a reason, when the sample is not plausibly white.
  function whiteGains(lin) {
    const [r, g, b] = lin;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if ((r + g + b) / 3 < WHITE.minMean) return { ok: false, reason: 'That is too dark to be white. Aim the ring at white paper in good light.' };
    if (mn <= 0 || mx / mn > WHITE.maxSpread) return { ok: false, reason: 'That is too colorful to be white. Aim the ring at white paper.' };
    const gains = [mx / r, mx / g, mx / b];
    // the brightest channel is clipped, so the true cast is a little stronger than it looks: still apply it, but say so
    if (mx >= WHITE.clipAt && mx / mn > 1.1) return { ok: true, gains, warning: 'The paper is very bright, so the correction may be a little weak. Tilt it away from the light for a better one.' };
    return { ok: true, gains };
  }

  // The connected patch of cells whose ΔE is within `limit`, grown from the closest cell: its centroid is where to point.
  function closestRegion(dE, w, h, seed, limit) {
    const seen = new Uint8Array(w * h), stack = [seed];
    seen[seed] = 1;
    let sx = 0, sy = 0, n = 0;
    const push = (j) => { if (!seen[j] && dE[j] <= limit) { seen[j] = 1; stack.push(j); } };
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      sx += x; sy += y; n++;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    return { x: sx / n, y: sy / n, cells: n };
  }

  // Per-cell ΔE to the target (each cell averaged with its 8 neighbours so one noisy pixel cannot win),
  // the closest cell, and the reading under the ring.
  function analyzeFrame({ rgba, w, h, gains, targetLab, kL, ring, margin }) {
    const g = gains || [1, 1, 1];
    const n = w * h, lin = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const q = i * 4, p = i * 3;
      lin[p] = clamp01(LIN[rgba[q]] * g[0]);
      lin[p + 1] = clamp01(LIN[rgba[q + 1]] * g[1]);
      lin[p + 2] = clamp01(LIN[rgba[q + 2]] * g[2]);
    }
    const dE = new Float32Array(n);
    let bestI = 0, bestD = Infinity;
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        let r = 0, gg = 0, b = 0, k = 0;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const p = (yy * w + xx) * 3;
            r += lin[p]; gg += lin[p + 1]; b += lin[p + 2]; k++;
          }
        }
        const d = C.deltaE2000(C.linearToLab(r / k, gg / k, b / k), targetLab, kL);
        const i = y * w + x;
        dE[i] = d;
        if (d < bestD) { bestD = d; bestI = i; }
      }
    }
    const cells = cellsInRing(w, h, ring);
    let r = 0, gg = 0, b = 0;
    for (const i of cells) { r += lin[i * 3]; gg += lin[i * 3 + 1]; b += lin[i * 3 + 2]; }
    r /= cells.length; gg /= cells.length; b /= cells.length;
    const rgb = [C.linearToByte(r), C.linearToByte(gg), C.linearToByte(b)];
    const region = closestRegion(dE, w, h, bestI, bestD + (margin == null ? 1 : margin));
    return {
      dE,
      best: { x: region.x, y: region.y, dE: bestD, cells: region.cells },
      reading: { rgb, hex: C.toHex(rgb[0], rgb[1], rgb[2]), dE: C.deltaE2000(C.linearToLab(r, gg, b), targetLab, kL) },
    };
  }

  // RGBA overlay: clear where the cell matches, darker the further it is from the target.
  function maskFromDE(dE, w, h, tol) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const d = dE[i];
      if (d > tol) out[i * 4 + 3] = 30 + 150 * Math.min(1, (d - tol) / (2 * tol)); // never fully black: the scene stays visible
    }
    return out;
  }

  const verdict = (dE, tol) => (dE <= tol ? 'match' : dE <= 2 * tol ? 'close' : 'no');

  return { WHITE, cellsInRing, sampleLinear, whiteGains, closestRegion, analyzeFrame, maskFromDE, verdict };
});
