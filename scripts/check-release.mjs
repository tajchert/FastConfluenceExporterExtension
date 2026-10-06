// Release gate: fails while the privacy policy, README or store listings still contain template
// placeholders (a hosted policy without a contact, or broken homepage/support URLs, gets a store
// submission rejected or taken down).
//
// Usage: node scripts/check-release.mjs   (runs in CI for release tags: npm run check:release)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDERS = ['<your-email>', '<owner>'];
const files = [
  'PRIVACY.md',
  'README.md',
  ...fs
    .readdirSync(path.join(root, 'store'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join('store', f)),
];

const problems = [];
for (const rel of files) {
  const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const p of PLACEHOLDERS) if (line.includes(p)) problems.push(`${rel}:${i + 1}: ${p}`);
  });
}

if (problems.length) {
  console.error('Fill in these placeholders before releasing:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`No placeholders left in ${files.length} files.`);
