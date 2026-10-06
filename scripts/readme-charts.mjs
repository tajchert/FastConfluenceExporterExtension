#!/usr/bin/env node
// Renders the README speed charts (light + dark SVG) from docs/benchmarks.json.
// Usage: node scripts/readme-charts.mjs
// Colors: reference categorical palette, validated for CVD/contrast in both modes
// (blue = this extension / PDF, orange = Confluence built-in, aqua = Markdown).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'docs/benchmarks.json'), 'utf8'));
const outDir = path.join(root, 'docs/images');
fs.mkdirSync(outDir, { recursive: true });

const THEMES = {
  light: {
    surface: '#fcfcfb', text: '#0b0b0b', text2: '#52514e', muted: '#8a8984', grid: '#e6e5e1',
    blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a',
  },
  dark: {
    surface: '#1a1a19', text: '#ffffff', text2: '#c3c2b7', muted: '#8f8e86', grid: '#33332f',
    blue: '#3987e5', orange: '#d95926', aqua: '#199e70',
  },
};
const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (s) => (s >= 10 ? `${Math.round(s)} s` : `${s.toFixed(1)} s`);

/** Horizontal grouped bar chart. groups: [{ label, bars: [{ series, value, note? }] }] */
function barChart({ title, subtitle, series, groups, max, width = 760, theme, footnote }) {
  const t = THEMES[theme];
  const left = 210, right = 70, barH = 18, barGap = 2, groupGap = 22;
  const top = 92;
  const plotW = width - left - right;
  const x = (v) => left + (v / max) * plotW;
  let y = top;
  const marks = [];
  for (const g of groups) {
    const gTop = y;
    for (const b of g.bars) {
      const s = series.find((s) => s.key === b.series);
      const w = Math.max(3, x(b.value) - left);
      // 4px rounded data end, square at the baseline
      marks.push(`<path d="M${left},${y} h${w - 4} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z" fill="${t[s.color]}"/>`);
      marks.push(`<text x="${left + w + 8}" y="${y + barH / 2 + 4.5}" font-size="13" font-weight="600" fill="${t.text}" ${FONT}>${esc(fmt(b.value))}${b.note ? `<tspan font-weight="400" fill="${t.text2}"> ${esc(b.note)}</tspan>` : ''}</text>`);
      y += barH + barGap;
    }
    const mid = (gTop + y - barGap) / 2;
    const lines = g.label.split('\n');
    lines.forEach((ln, i) => {
      marks.push(`<text x="${left - 12}" y="${mid + 4.5 + (i - (lines.length - 1) / 2) * 16}" text-anchor="end" font-size="13" fill="${i ? t.text2 : t.text}" ${FONT}>${esc(ln)}</text>`);
    });
    y += groupGap - barGap;
  }
  const plotBottom = y - groupGap + 6;
  // recessive vertical grid + axis labels
  const ticks = [];
  const step = max <= 10 ? 2 : max <= 40 ? 10 : max <= 100 ? 20 : 50;
  for (let v = 0; v <= max + 1e-9; v += step) {
    ticks.push(`<line x1="${x(v)}" x2="${x(v)}" y1="${top - 8}" y2="${plotBottom}" stroke="${t.grid}" stroke-width="1"/>`);
    ticks.push(`<text x="${x(v)}" y="${plotBottom + 18}" text-anchor="middle" font-size="11" fill="${t.muted}" ${FONT}>${v} s</text>`);
  }
  // legend (always present for >= 2 series)
  let lx = left;
  const legend = series.map((s) => {
    const el = `<rect x="${lx}" y="58" width="12" height="12" rx="3" fill="${t[s.color]}"/><text x="${lx + 18}" y="68.5" font-size="12.5" fill="${t.text2}" ${FONT}>${esc(s.label)}</text>`;
    lx += 18 + s.label.length * 7 + 26;
    return el;
  });
  const notes = footnote ? footnote.split('\n') : [];
  const height = plotBottom + 32 + notes.length * 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect width="${width}" height="${height}" rx="12" fill="${t.surface}"/>
<text x="24" y="32" font-size="17" font-weight="700" fill="${t.text}" ${FONT}>${esc(title)}</text>
<text x="24" y="50" font-size="12.5" fill="${t.text2}" ${FONT}>${esc(subtitle)}</text>
${legend.join('\n')}
${ticks.join('\n')}
${marks.join('\n')}
${notes.map((n, i) => `<text x="24" y="${height - 14 - (notes.length - 1 - i) * 16}" font-size="11" fill="${t.muted}" ${FONT}>${esc(n)}</text>`).join('\n')}
</svg>
`;
}

const vs = data.comparison;
const ext = data.extension;
for (const theme of ['light', 'dark']) {
  const cmp = barChart({
    theme,
    title: 'Time to a finished PDF (lower is better)',
    subtitle: 'Confluence Cloud built-in export vs. this extension (single pages: median of 3 runs)',
    series: [
      { key: 'builtin', label: 'Confluence built-in export', color: 'orange' },
      { key: 'ext', label: 'Fast Confluence Exporter', color: 'blue' },
    ],
    groups: vs.map((r) => ({
      label: r.label,
      bars: [
        { series: 'builtin', value: r.builtinSec, note: r.builtinNote },
        { series: 'ext', value: r.extensionSec, note: r.extensionNote },
      ],
    })),
    max: Math.ceil(Math.max(...vs.map((r) => r.builtinSec)) / 50) * 50,
    footnote: data.comparisonFootnote,
  });
  fs.writeFileSync(path.join(outDir, `speed-vs-builtin-${theme}.svg`), cmp);

  const fmtChart = barChart({
    theme,
    title: 'Export time on public Confluence sites',
    subtitle: 'This extension, from click to saved file, median of 3 runs',
    series: [
      { key: 'pdf', label: 'PDF', color: 'blue' },
      { key: 'md', label: 'Markdown', color: 'aqua' },
    ],
    groups: ext.map((r) => ({ label: r.label, bars: [{ series: 'pdf', value: r.pdfSec }, { series: 'md', value: r.markdownSec }] })),
    max: Math.ceil(Math.max(...ext.map((r) => r.pdfSec))),
    footnote: data.extensionFootnote,
  });
  fs.writeFileSync(path.join(outDir, `speed-public-${theme}.svg`), fmtChart);
}
console.log('Wrote docs/images/speed-*.svg');
