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

  // What the ring reads: its average linear color as bytes, hex and ΔE to the target.
  function readingOf(r, g, b, targetLab, kL) {
    const rgb = [C.linearToByte(r), C.linearToByte(g), C.linearToByte(b)];
    return { rgb, hex: C.toHex(rgb[0], rgb[1], rgb[2]), dE: C.deltaE2000(C.linearToLab(r, g, b), targetLab, kL) };
  }

  // Reading under the ring alone, straight from the pixels: for moving the ring without re-analysing the whole frame.
  function readingAt(rgba, w, h, ring, gains, targetLab, kL) {
    const lin = sampleLinear(rgba, w, h, ring, gains);
    return readingOf(lin[0], lin[1], lin[2], targetLab, kL);
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

  // Every connected patch (4-neighbour) of cells whose ΔE is within `limit` and that has at least `minCells` cells: candidate items.
  // box is in cells, x1/y1 exclusive. `edge` is true when the patch touches the picture's border, so it may be cut off by the screen.
  // Thin strips (an item half-hidden under a sticky header, a border, an underline) are not items: at least minSide cells across, and no more than maxAspect times longer than wide.
  function findRegions(dE, w, h, { limit, minCells = 16, minSide = 4, maxAspect = 6 }) {
    const seen = new Uint8Array(w * h), out = [], stack = [];
    for (let s = 0; s < w * h; s++) {
      if (seen[s] || dE[s] > limit) continue;
      seen[s] = 1; stack.length = 0; stack.push(s);
      const cells = [];
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i - x) / w;
        cells.push(i);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        const go = (j) => { if (!seen[j] && dE[j] <= limit) { seen[j] = 1; stack.push(j); } };
        if (x > 0) go(i - 1);
        if (x < w - 1) go(i + 1);
        if (y > 0) go(i - w);
        if (y < h - 1) go(i + w);
      }
      if (cells.length < minCells) continue;
      const bw = x1 + 1 - x0, bh = y1 + 1 - y0;
      if (Math.min(bw, bh) < minSide || Math.max(bw, bh) > maxAspect * Math.min(bw, bh)) continue;
      out.push({ cells, box: { x0, y0, x1: x1 + 1, y1: y1 + 1 }, edge: x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1 });
    }
    return out;
  }

  // What a patch looks like: the average color of its closest half (so a shaded photo is judged by its good part) and that color's ΔE.
  function regionStats(rgba, region, gains, targetLab, kL, dE) {
    const g = gains || [1, 1, 1];
    const idx = region.cells.slice().sort((a, b) => dE[a] - dE[b]).slice(0, Math.max(1, Math.ceil(region.cells.length / 2)));
    let r = 0, gg = 0, b = 0;
    for (const i of idx) {
      const q = i * 4;
      r += clamp01(LIN[rgba[q]] * g[0]); gg += clamp01(LIN[rgba[q + 1]] * g[1]); b += clamp01(LIN[rgba[q + 2]] * g[2]);
    }
    return readingOf(r / idx.length, gg / idx.length, b / idx.length, targetLab, kL);
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
    const region = closestRegion(dE, w, h, bestI, bestD + (margin == null ? 1 : margin));
    return {
      dE,
      best: { x: region.x, y: region.y, dE: bestD, cells: region.cells },
      reading: readingOf(r, gg, b, targetLab, kL),
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

  return { WHITE, cellsInRing, sampleLinear, whiteGains, readingAt, findRegions, regionStats, closestRegion, analyzeFrame, maskFromDE, verdict };
});
