// Color maths for Color Match (window.ColorLib in the browser, require() in node tests).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ColorLib = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

  // Accepts "#7B0323", "7b0323", "#7b0", "7B 03 23" (Digital Color Meter style),
  // "rgb(123, 3, 35)" and "123,3,35". Returns [r, g, b] or null.
  function parseHex(input) {
    const s = String(input == null ? '' : input).trim();
    // Three space-separated two-digit groups are hex pairs ("12 34 56" is #123456)
    const pairs = s.match(/^#?([0-9a-f]{2})\s+([0-9a-f]{2})\s+([0-9a-f]{2})$/i);
    if (pairs) return [parseInt(pairs[1], 16), parseInt(pairs[2], 16), parseInt(pairs[3], 16)];
    const nums = s.match(/^(?:rgb\(\s*)?(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?$/i);
    if (nums) {
      const rgb = [Number(nums[1]), Number(nums[2]), Number(nums[3])];
      return rgb.every((v) => v <= 255) ? rgb : null;
    }
    let h = s.replace(/^#|^0x/i, '').replace(/\s+/g, '');
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  const toHex = (r, g, b) => '#' + hex2(r) + hex2(g) + hex2(b);

  // sRGB byte -> linear light
  const LIN = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  // linear light 0..1 -> sRGB byte (clamped)
  function linearToByte(v) {
    if (!(v > 0)) return 0;
    if (v >= 1) return 255;
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  }

  const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);

  // linear sRGB (D65) -> CIE L*a*b*
  function linearToLab(R, G, B) {
    const x = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
    const y = labF(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
    const z = labF((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  const rgbToLab = (r, g, b) => linearToLab(LIN[r], LIN[g], LIN[b]);

  // CIEDE2000 (Sharma, Wu, Dalal 2005). kL > 1 makes lightness differences count less
  // (textile practice uses 2); a camera in a shop sees brightness change more than color.
  function deltaE2000(lab1, lab2, kL) {
    const kl = kL || 1;
    const rad = Math.PI / 180, deg = 180 / Math.PI;
    const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cbar7 = Math.pow((C1 + C2) / 2, 7);
    const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const hue = (a, b) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) * deg + 360) % 360);
    const h1p = hue(a1p, b1), h2p = hue(a2p, b2);
    const dLp = L2 - L1, dCp = C2p - C1p;
    const CC = C1p * C2p;
    let dhp = 0;
    if (CC !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(CC) * Math.sin((dhp * rad) / 2);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p;
    if (CC !== 0) {
      if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
      else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    }
    const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
      + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
    const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Cbp7 = Math.pow(Cbp, 7);
    const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 6103515625));
    const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
    const Sc = 1 + 0.045 * Cbp;
    const Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;
    const x = dLp / (kl * Sl), y = dCp / Sc, z = dHp / Sh;
    return Math.sqrt(x * x + y * y + z * z + Rt * y * z);
  }

  const deltaE = (rgb, targetLab, kL) => deltaE2000(rgbToLab(rgb[0], rgb[1], rgb[2]), targetLab, kL);

  return { parseHex, toHex, rgbToLab, linearToLab, linearToByte, srgbToLinear: LIN, deltaE2000, deltaE };
});
