// Builds the sic. logo images, app icon, Android adaptive icon layers, splash and favicon from the
// original artwork (scripts/brand/sic-source.png: black "sic", red full stop, "sharing is caring").
// Run: npm run icons
//
// The artwork is recoloured, never redrawn: each pixel is split into how much black ink and how much
// red ink it holds, then repainted in the brand colours, so the shapes stay exactly as drawn.
import { Resvg } from '@resvg/resvg-js';
import pngjs from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { PNG } = pngjs;
const here = dirname(fileURLToPath(import.meta.url));
const images = join(here, '../apps/mobile/assets/images');

const PURPLE = '#605574'; // Deep purple: the logo on light backgrounds, and the icon/splash background
const CREAM = '#FAF0EB'; // Cream: the logo on purple
const RED = '#EF4444'; // The full stop, in every version (part of the logo)
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ─── Read the artwork as ink coverage ────────────────────────────────────────
const src = PNG.sync.read(readFileSync(join(here, 'brand/sic-source.png')));
const { width: W, height: H } = src;
const ink = new Float32Array(W * H); // black ink, 0..1
const dot = new Float32Array(W * H); // red ink, 0..1
for (let p = 0; p < W * H; p++) {
  const r = src.data[p * 4], g = src.data[p * 4 + 1];
  // Black lowers red and green equally; the red ink lowers red by ~30 and green by ~242.
  let d = Math.min(1, Math.max(0, (r - g) / 212));
  let k = Math.min(1, Math.max(0, (255 - r - 30 * d) / 246));
  if (k + d < 0.03) k = d = 0; // paper texture
  ink[p] = k;
  dot[p] = d;
}

// Bounding boxes: "sic." on top, the tagline under it, split at the first empty row below the letters.
const rowHasInk = (y) => {
  for (let x = 0; x < W; x++) if (ink[y * W + x] + dot[y * W + x] > 0.2) return true;
  return false;
};
function box(y0, y1) {
  let x0 = W, x1 = 0, top = H, bottom = 0;
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < W; x++)
      if (ink[y * W + x] + dot[y * W + x] > 0.2) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
  return { x: x0, y: top, w: x1 - x0 + 1, h: bottom - top + 1 };
}
let firstInk = 0;
while (!rowHasInk(firstInk)) firstInk++;
let gap = firstInk;
while (rowHasInk(gap)) gap++;
const LOGO = box(0, gap);
const FULL = box(0, H); // logo + tagline

// ─── Recolour a region into a transparent PNG ────────────────────────────────
function paint(region, inkColour, dotColour = RED, pad = 8) {
  const out = new PNG({ width: region.w + pad * 2, height: region.h + pad * 2 });
  const [ik, dk] = [hex(inkColour), hex(dotColour)];
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const sx = region.x - pad + x, sy = region.y - pad + y;
      const o = (y * out.width + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const k = ink[sy * W + sx], d = dot[sy * W + sx], a = k + d;
      if (!a) continue;
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round((ik[c] * k + dk[c] * d) / a);
      out.data[o + 3] = Math.round(Math.min(1, a) * 255);
    }
  return out;
}
const png = (image) => PNG.sync.write(image);

// Place a recoloured logo on a square canvas (optionally filled), at a share of the canvas width.
function square(size, logo, share, bg) {
  const w = size * share, h = (w * logo.height) / logo.width;
  const href = `data:image/png;base64,${png(logo).toString('base64')}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}">` +
    (bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : '') +
    `<image x="${(size - w) / 2}" y="${(size - h) / 2}" width="${w}" height="${h}" xlink:href="${href}"/></svg>`;
  return new Resvg(svg).render().asPng();
}

const write = (path, data) => {
  writeFileSync(path, data);
  console.log('wrote', path.replace(join(here, '..') + '/', ''));
};

// In-app logo ("sic." without the tagline): purple for light screens, cream for purple screens and dark mode.
write(join(images, 'logo-dark.png'), png(paint(LOGO, PURPLE)));
write(join(images, 'logo-light.png'), png(paint(LOGO, CREAM)));
// The invite web page has a purple header.
write(join(here, '../docs/invite/logo.png'), png(paint(LOGO, CREAM)));
// The website's header: the whole logo with "sharing is caring" under it, cream for the purple header.
write(join(here, '../site/logo-full-light.png'), png(paint(FULL, CREAM)));

const light = paint(LOGO, CREAM);
// iOS / store icon: full-bleed purple with the cream logo.
write(join(images, 'icon.png'), square(1024, light, 0.66, PURPLE));
// Android adaptive icon: the launcher masks to ~66% of the canvas, so keep the logo inside that.
write(join(images, 'android-icon-foreground.png'), square(1024, light, 0.54));
write(join(images, 'android-icon-background.png'), square(1024, light, 0, PURPLE));
write(join(images, 'android-icon-monochrome.png'), square(1024, paint(LOGO, '#FFFFFF', '#FFFFFF'), 0.54));
// Splash: the whole logo with its tagline, cream, on the purple splash background from app.json.
write(join(images, 'splash-icon.png'), square(1024, paint(FULL, CREAM), 0.92));
write(join(images, 'favicon.png'), square(196, light, 0.74, PURPLE));
