#!/usr/bin/env node
/**
 * Generates the extension icons and Chrome Web Store promo images from inline SVG/HTML.
 *
 *   npm run icons
 *
 * Outputs (all committed to the repo, so building the extension never needs this script):
 *   public/icons/icon.svg             master artwork (detailed variant)
 *   public/icons/{16,32,48,128}.png   toolbar / extensions page / store icons
 *   store/icon-128x128.png             Web Store icon (96×96 artwork, 16 px transparent padding)
 *   store/promo-small-440x280.png     Web Store small promo tile
 *   store/marquee-1400x560.png        Web Store marquee promo tile
 *   store/edge-logo-300x300.png       Edge Add-ons store logo
 *
 * Rendering uses playwright-core driving a locally installed Chrome. Override the browser with
 * CHROME_PATH=/path/to/chrome; when unset, the default Chrome location for the OS is used and,
 * failing that, Playwright's own Chromium (if `npx playwright install chromium` was run).
 *
 * The artwork is original: a stack of pages (one page, a page tree, a space) with a round amber
 * lightning badge ("fast export"). It names no output format (PDF, Markdown and text are all
 * supported) and deliberately avoids Atlassian/Confluence logos, colours and shapes.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'public', 'icons');
const storeDir = join(root, 'store');

// ── Palette ────────────────────────────────────────────────────────────────────────────────
const C = {
  pageBack: '#B9C6FF',
  pageMid: '#7F98FF',
  pageTop: '#4F7CFF',
  pageBottom: '#2F4FD8',
  line: '#FFFFFF',
  badgeTop: '#FFD54A',
  badgeBottom: '#FF9F1C',
  badgeRing: '#FFFFFF',
  bolt: '#FFFFFF',
};

// ── Detailed icon (48px and up), 128×128 artboard ─────────────────────────────────────────
// Artwork spans x 18–115.5, y 14–115.5; the 48/128/300 px renders crop to it (ICON_VIEWBOX).
function detailedSvg({ id = 'd' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="${id}-page" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${C.pageTop}"/>
      <stop offset="1" stop-color="${C.pageBottom}"/>
    </linearGradient>
    <linearGradient id="${id}-badge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.badgeTop}"/>
      <stop offset="1" stop-color="${C.badgeBottom}"/>
    </linearGradient>
  </defs>
  <!-- stack of pages -->
  <rect x="34" y="14" width="62" height="78" rx="10" fill="${C.pageBack}"/>
  <rect x="26" y="22" width="62" height="78" rx="10" fill="${C.pageMid}"/>
  <rect x="18" y="30" width="62" height="80" rx="10" fill="url(#${id}-page)"/>
  <!-- title and text lines -->
  <rect x="28" y="42" width="34" height="7" rx="3.5" fill="${C.line}"/>
  <rect x="28" y="56" width="42" height="5" rx="2.5" fill="${C.line}" opacity="0.75"/>
  <rect x="28" y="66" width="36" height="5" rx="2.5" fill="${C.line}" opacity="0.75"/>
  <rect x="28" y="76" width="40" height="5" rx="2.5" fill="${C.line}" opacity="0.75"/>
  <!-- fast-export badge -->
  <circle cx="88" cy="88" r="25" fill="url(#${id}-badge)" stroke="${C.badgeRing}" stroke-width="5"/>
  <path d="M92 70 L78 91 H88 L84 106 L99 84 H89 Z" fill="${C.bolt}"/>
</svg>`;
}

// ── Simplified icon (16px / 32px), 32×32 artboard on a pixel grid ─────────────────────────
// Two pages instead of three and fewer lines, so the shapes stay crisp at toolbar size.
function smallSvg({ id = 's' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="${id}-page" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${C.pageTop}"/>
      <stop offset="1" stop-color="${C.pageBottom}"/>
    </linearGradient>
  </defs>
  <rect x="10" y="1" width="17" height="21" rx="3" fill="${C.pageMid}"/>
  <rect x="3" y="6" width="18" height="23" rx="3" fill="url(#${id}-page)"/>
  <rect x="6" y="10" width="9" height="2.4" rx="1.2" fill="${C.line}"/>
  <rect x="6" y="15" width="11" height="1.8" rx="0.9" fill="${C.line}" opacity="0.8"/>
  <rect x="6" y="19" width="8" height="1.8" rx="0.9" fill="${C.line}" opacity="0.8"/>
  <circle cx="23" cy="23" r="8" fill="${C.badgeBottom}" stroke="${C.badgeRing}" stroke-width="1.6"/>
  <path d="M24.4 17 L19.6 24 H23 L21.6 29 L26.6 21.6 H23.3 Z" fill="${C.bolt}"/>
</svg>`;
}

/** Renders `svg` at `art`×`art` px, centered on a transparent `size`×`size` canvas. */
function iconPage(svg, size, art = size) {
  const pad = (size - art) / 2;
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent}
    body{padding:${pad}px}
    svg{display:block;width:${art}px;height:${art}px}
  </style></head><body>${svg}</body></html>`;
}

// Chrome Web Store icon rule: a 128×128 PNG whose artwork is 96×96, centered, with 16 px of
// transparent padding on each side. The artboard is cropped to the artwork's bounds first.
const ICON_VIEWBOX = '16 13 102 102';
function croppedSvg(id = 'st') {
  return detailedSvg({ id }).replace('viewBox="0 0 128 128"', `viewBox="${ICON_VIEWBOX}"`);
}

// ── Promo tiles ────────────────────────────────────────────────────────────────────────────
function promoHtml({ width, height, large }) {
  const icon = croppedSvg('p').replace('width="128" height="128"', `width="${large ? 190 : 110}" height="${large ? 190 : 110}"`);
  const sheet = (x, y, r, label) => `
    <div class="sheet" style="left:${x}px;top:${y}px;transform:rotate(${r}deg)">
      <div class="bar w80"></div><div class="bar w60"></div><div class="bar w90"></div>
      <div class="bar w40"></div><div class="block"></div><div class="bar w70"></div>
      ${label ? `<div class="label"${label === 'MD' ? ' style="background:#1F2937"' : ''}>${label}</div>` : ''}
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
      background:#17113F;color:#fff;position:relative;
    }
    .bg{position:absolute;inset:0;background:radial-gradient(120% 140% at 0% 0%,#2B1F7A 0%,#17113F 55%,#0E0A29 100%)}
    .glow{position:absolute;border-radius:50%;filter:blur(${large ? 90 : 40}px);opacity:.55}
    .g1{width:${large ? 520 : 200}px;height:${large ? 520 : 200}px;background:#6D5BF5;right:${large ? -80 : -50}px;top:${large ? -120 : -60}px}
    .g2{width:${large ? 380 : 150}px;height:${large ? 380 : 150}px;background:#FFB020;right:${large ? 260 : 60}px;bottom:${large ? -220 : -110}px;opacity:.25}
    .content{position:absolute;inset:0;display:flex;align-items:center;padding:0 ${large ? 80 : 28}px;gap:${large ? 44 : 18}px}
    .text{display:flex;flex-direction:column;gap:${large ? 18 : 8}px;max-width:${large ? 560 : 260}px;z-index:2}
    h1{margin:0;font-size:${large ? 64 : 27}px;line-height:1.05;font-weight:800;letter-spacing:-.02em}
    h1 .for{display:block;font-size:${large ? 34 : 15}px;font-weight:600;color:#C9C2FF;letter-spacing:0;margin-top:${large ? 10 : 4}px}
    p{margin:0;font-size:${large ? 24 : 13}px;line-height:1.35;color:#E2DEFF}
    .chips{display:flex;flex-wrap:wrap;gap:${large ? 12 : 6}px;margin-top:${large ? 10 : 4}px}
    .chip{font-size:${large ? 18 : 10}px;font-weight:600;padding:${large ? '8px 16px' : '3px 8px'};border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);color:#fff}
    .stack{position:absolute;right:${large ? 30 : 0}px;top:0;bottom:0;width:${large ? 440 : 0}px;display:${large ? 'block' : 'none'}}
    .sheet{position:absolute;width:190px;height:260px;background:#fff;border-radius:14px;padding:26px 22px;
      box-shadow:0 24px 60px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:12px}
    .bar{height:10px;border-radius:5px;background:#DCD8F5}
    .bar.w80{width:80%;background:#4330C9;height:14px}.bar.w60{width:60%}.bar.w90{width:90%}.bar.w40{width:40%}.bar.w70{width:70%}
    .block{height:70px;border-radius:8px;background:linear-gradient(135deg,#EDEBFF,#D7D1FF)}
    .label{position:absolute;left:-18px;bottom:22px;background:#E5343A;color:#fff;font-weight:800;font-size:26px;
      padding:6px 16px;border-radius:10px;border:3px solid #fff;letter-spacing:.04em}
    .icon{flex:0 0 auto;z-index:2;filter:drop-shadow(0 ${large ? 18 : 8}px ${large ? 30 : 14}px rgba(0,0,0,.45))}
  </style></head><body>
    <div class="bg"></div>
    <div class="glow g1"></div><div class="glow g2"></div>
    <div class="content">
      <div class="icon">${icon}</div>
      <div class="text">
        <h1>Fast Confluence Exporter<span class="for">PDF &amp; Markdown</span></h1>
        <p>${large
          ? 'Pages, page trees, folders and whole spaces as one clean PDF or Markdown file. Made in your browser, using your existing session.'
          : 'Pages, trees and folders as PDF or Markdown, made in your browser.'}</p>
        ${large ? `<div class="chips"><span class="chip">Cover &amp; TOC</span><span class="chip">PDF bookmarks</span><span class="chip">Cloud &amp; Data Center</span><span class="chip">No data leaves your browser</span></div>` : ''}
      </div>
    </div>
    <div class="stack">
      ${large ? sheet(20, 160, -9, '') + sheet(120, 135, 3, 'MD') + sheet(225, 150, 10, 'PDF') : ''}
    </div>
  </body></html>`;
}

// ── Browser ────────────────────────────────────────────────────────────────────────────────
function defaultChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: [
      `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
  }[process.platform] ?? [];
  return candidates.find((p) => existsSync(p));
}

async function launch() {
  const executablePath = defaultChromePath();
  try {
    return await chromium.launch({ executablePath, headless: true });
  } catch (err) {
    throw new Error(
      `Could not launch Chrome${executablePath ? ` at ${executablePath}` : ''}. ` +
        `Set CHROME_PATH to a Chrome/Chromium binary or run "npx playwright install chromium".\n${err?.message ?? err}`,
    );
  }
}

async function main() {
  mkdirSync(iconsDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  writeFileSync(join(iconsDir, 'icon.svg'), croppedSvg('i').replace('width="128" height="128"', 'width="102" height="102"') + '\n');

  const browser = await launch();
  // A fresh page per image: resizing one page's viewport between screenshots makes headless
  // Chrome occasionally reuse stale raster tiles (garbled output).
  const render = async (html, width, height, out, transparent) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
      console.log(`wrote ${out}`);
    } finally {
      await page.close();
    }
  };
  try {
    for (const size of [16, 32]) {
      await render(iconPage(smallSvg(), size), size, size, join(iconsDir, `${size}.png`), true);
    }
    await render(iconPage(croppedSvg(), 48, 44), 48, 48, join(iconsDir, '48.png'), true);
    // 128: 96×96 artwork + 16 px padding (manifest icon and Web Store icon are the same file).
    await render(iconPage(croppedSvg(), 128, 96), 128, 128, join(iconsDir, '128.png'), true);
    await render(iconPage(croppedSvg(), 128, 96), 128, 128, join(storeDir, 'icon-128x128.png'), true);
    // Edge Add-ons "store logo" (1:1, 300×300 recommended).
    await render(iconPage(croppedSvg(), 300, 260), 300, 300, join(storeDir, 'edge-logo-300x300.png'), true);
    // Store promo images must be opaque (24-bit PNG, no alpha), hence no transparent background.
    await render(promoHtml({ width: 440, height: 280, large: false }), 440, 280, join(storeDir, 'promo-small-440x280.png'), false);
    await render(promoHtml({ width: 1400, height: 560, large: true }), 1400, 560, join(storeDir, 'marquee-1400x560.png'), false);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
