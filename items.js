// The list of items found while browsing a shared page. Pure: window.MatchItems in the browser, require() in tests.
// Each analysis hands in the patches it sees. A patch becomes an item once it has held still for two looks in a row
// (so scrolling past does not collect), and later sightings of the same-looking patch update that item instead of adding another.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MatchItems = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const iou = (a, b) => {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (w <= 0 || h <= 0) return 0;
    const i = w * h;
    return i / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i);
  };

  // mean absolute difference between two equal-size byte pictures
  function sigDiff(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  // Same patch seen again? Alike in shape and size, in picture, and in how close the color is to the target.
  const LIKE = { aspect: 0.15, area: 1.6, sig: 12, dE: 1.5 };
  function alike(it, r) {
    return Math.abs(it.aspect / r.aspect - 1) <= LIKE.aspect
      && Math.max(it.area / r.area, r.area / it.area) <= LIKE.area
      && Math.abs(it.dE - r.dE) <= LIKE.dE
      && sigDiff(it.sig, r.sig) <= LIKE.sig;
  }

  function create({ max = 40 } = {}) {
    const items = [];
    let nextId = 1, prev = [];

    // regions: [{ box:{x0,y0,x1,y1}, dE, hex, cells, sig, make() }]  (make() builds the thumbnail, called only when one is needed)
    function ingest(regions, now) {
      // steady: the same-looking patch, in about the same place, as in the last look (a different card sliding into the old one's
      // place, as in a fast scroll through a list, does not count)
      const steady = regions.filter((r) => prev.some((p) => iou(p.box, r.box) >= 0.5 && Math.abs(p.dE - r.dE) <= LIKE.dE && sigDiff(p.sig, r.sig) <= LIKE.sig));
      prev = regions.map((r) => ({ box: r.box, dE: r.dE, sig: r.sig }));
      const claimed = new Set(), events = [];
      for (const r of steady) {
        const aspect = (r.box.x1 - r.box.x0) / (r.box.y1 - r.box.y0), area = r.cells;
        const cand = { aspect, area, dE: r.dE, sig: r.sig };
        let best = null, bd = Infinity;
        for (const it of items) {
          if (claimed.has(it.id) || !alike(it, cand)) continue;
          const d = sigDiff(it.sig, r.sig);
          if (d < bd) { bd = d; best = it; }
        }
        if (best) {
          claimed.add(best.id); best.seen++; best.last = now;
          if (r.dE < best.dE - 0.1) { Object.assign(best, { dE: r.dE, hex: r.hex, sig: r.sig, aspect, area, thumb: r.make() }); events.push({ type: 'better', item: best }); }
        } else {
          const it = { id: nextId++, dE: r.dE, hex: r.hex, sig: r.sig, aspect, area, thumb: r.make(), seen: 1, first: now, last: now };
          items.push(it); claimed.add(it.id); events.push({ type: 'new', item: it });
        }
      }
      while (items.length > max) {   // over the cap: the worst match goes
        let w = 0;
        for (let i = 1; i < items.length; i++) if (items[i].dE > items[w].dE) w = i;
        items.splice(w, 1);
      }
      return events;
    }

    return {
      ingest,
      list: () => items.slice().sort((a, b) => a.dE - b.dE || b.seen - a.seen),
      remove: (id) => { const i = items.findIndex((it) => it.id === id); if (i >= 0) items.splice(i, 1); },
      clear: () => { items.length = 0; prev = []; },
      reset: () => { prev = []; },     // forget what the last look saw (the picture changed), keep the items
      get size() { return items.length; },
    };
  }

  return { create, sigDiff, alike, iou, LIKE };
});
