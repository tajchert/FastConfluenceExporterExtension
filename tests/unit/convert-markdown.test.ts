import { describe, expect, it } from 'vitest';
import { convertPages, relinkFailedAssets, type ConvertInput, type ConvertResult } from '../../lib/convert';
import { escapeMarkdown, tidyMarkdown } from '../../lib/convert/markdown';
import type { CoverInfo } from '../../lib/messages';
import { FULL_PAGE, HEADINGS, IFRAME, JIRA_TABLE, PAGE_ID } from './fixtures/exportView';
import {
  ANCHORS,
  CODE_CLASS,
  CODE_LINK,
  CODE_WITH_BACKTICKS,
  COMPLEX_TABLE,
  DC9_EXPAND,
  EMOTICONS,
  HEADERLESS_TABLE,
  IMAGES_DEDUPE,
  INLINE_PLACEHOLDER,
  NESTED_LISTS,
  PANELS,
  SPECIAL_CHARS,
  STRAY_BREAKS,
  body,
  convertInput,
  newDoc,
  ref,
} from './fixtures/convert';

const COVER: CoverInfo = {
  title: 'Checkout v3',
  sourceUrl: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/100',
  spaceKey: 'ENG',
  exportedAt: '2026-10-06T08:30:00.000Z',
  exportedBy: 'Jane Doe',
  pageCount: 3,
};

function convert(input: ConvertInput): ConvertResult {
  return convertPages(newDoc(), input);
}

/** Markdown of a single page with the given HTML (no meta, no TOC). */
function md(html: string, o: Parameters<typeof convertInput>[1] = {}): string {
  const r = convert(
    convertInput([{ ref: ref('200', 'Page', 0), body: body('200', 'Page', html) }], {
      ...o,
      options: { includePageMeta: false, ...o.options },
    }),
  );
  return r.files[0]!.text;
}

const ROOT = ref(PAGE_ID, 'Checkout v3 Tech Spec', 0);
const CHILD = ref('111', 'Architecture', 1, { parentId: PAGE_ID });
const FOLDER = ref('300', 'Runbooks', 1, { type: 'folder', parentId: PAGE_ID });
const IN_FOLDER = ref('301', 'On-call', 2, { parentId: '300' });
const WHITEBOARD = ref('113', 'Brainstorm', 1, { type: 'whiteboard', parentId: PAGE_ID });
const SKIPPED = ref('114', 'Secret page', 1, { parentId: PAGE_ID });
const UNDER_SKIPPED = ref('115', 'Child of secret', 2, { parentId: '114' });

function tree(o: Parameters<typeof convertInput>[1] = {}): ConvertInput {
  const pages = [
    { ref: ROOT, body: body(PAGE_ID, 'Checkout v3 Tech Spec', FULL_PAGE) },
    {
      ref: CHILD,
      body: body(
        '111',
        'Architecture',
        '<h1 id="Architecture-Top">Top</h1><p>Back to <a href="/wiki/spaces/ENG/pages/315494566/Checkout#CheckoutV3TechSpec-Details" data-linked-resource-id="315494566">details</a> or <a href="/wiki/spaces/ENG/pages/114/Secret">secret</a>.</p>',
      ),
    },
    { ref: FOLDER },
    { ref: IN_FOLDER, body: body('301', 'On-call', '<p>Pager duty.</p>') },
    { ref: WHITEBOARD },
    { ref: SKIPPED, body: body('114', 'Secret page', '<p>hidden</p>') },
    { ref: UNDER_SKIPPED, body: body('115', 'Child of secret', '<p>still here</p>') },
  ];
  return convertInput(pages, { allPages: pages.map((p) => p.ref), excludeIds: ['114'], ...o });
}

describe('convertPages (markdown) — combined file', () => {
  it('writes one file named after baseName with page anchors and titles', () => {
    const r = convert(tree());
    expect(r.files.map((f) => f.path)).toEqual(['ENG_Checkout v3_2026-10-06.md']);
    const text = r.files[0]!.text;
    expect(text).toContain(`<a id="p-${PAGE_ID}"></a>\n# Checkout v3 Tech Spec`);
    expect(text).toContain('<a id="p-111"></a>\n# Architecture');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toMatch(/[ \t]+$/m);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('demotes content headings and anchors only the headings that are linked', () => {
    const text = convert(tree()).files[0]!.text;
    // Overview is linked from the page itself, Details from the Architecture page.
    expect(text).toContain(`## <a id="p${PAGE_ID}-CheckoutV3TechSpec-Overview"></a>Overview`);
    expect(text).toContain(`### <a id="p${PAGE_ID}-CheckoutV3TechSpec-Details"></a>Details`);
    expect(text).toContain('###### Fine print');
    expect(text).toContain('## Top');
    expect(text).toContain(`[overview](#p${PAGE_ID}-CheckoutV3TechSpec-Overview)`);
    expect(text).toContain(`Back to [details](#p${PAGE_ID}-CheckoutV3TechSpec-Details)`);
  });

  it('links exported pages in-document and keeps others (and excluded ones) absolute', () => {
    const text = convert(tree()).files[0]!.text;
    expect(text).toContain('[Architecture](#p-111)');
    expect(text).toContain('[legacy link](#p-111)');
    expect(text).toContain(`[tiny self link](#p-${PAGE_ID})`);
    expect(text).toContain('[Runbook](https://acme.atlassian.net/wiki/spaces/OPS/pages/999/Runbook)');
    expect(text).toContain('[secret](https://acme.atlassian.net/wiki/spaces/ENG/pages/114/Secret)');
    expect(text).toContain('[external](https://example.com/docs)');
    // javascript: links lose their target, mentions become plain names.
    expect(text).toContain(', bad,');
    expect(text).toMatch(/, Jane Doe\n/);
    expect(text).not.toContain('javascript:');
  });

  it('leaves excluded pages out and lists folders and link-only items', () => {
    const text = convert(tree()).files[0]!.text;
    expect(text).not.toContain('# Secret page');
    expect(text).toContain('# Child of secret');
    expect(text).toContain('<a id="p-300"></a>\n# Runbooks');
    expect(text).toContain('This folder contains:\n\n- [On-call](#p-301)');
    expect(text).toContain(
      "# Brainstorm\n\n*Whiteboard · [Open in Confluence](https://acme.atlassian.net/wiki/spaces/ENG/pages/113)*\n\nThis whiteboard can't be exported as content. [Open it in Confluence](https://acme.atlassian.net/wiki/spaces/ENG/pages/113)",
    );
  });

  it('writes cover front matter and a nested TOC', () => {
    const text = convert(tree({ cover: COVER, toc: true })).files[0]!.text;
    expect(text.startsWith('---\ntitle: "Checkout v3"\n')).toBe(true);
    expect(text).toContain('source: "https://acme.atlassian.net/wiki/spaces/ENG/pages/100"\nspace: "ENG"');
    expect(text).toContain('exported: "2026-10-06T08:30:00.000Z"\nexported_by: "Jane Doe"\npages: 3\n');
    expect(text).toContain('generator: "Fast Confluence Exporter v1.0.0"\n---');
    expect(text).toContain(
      [
        '**Contents**',
        '',
        `- [Checkout v3 Tech Spec](#p-${PAGE_ID})`,
        '  - [Architecture](#p-111)',
        '  - [Runbooks](#p-300) *(Folder)*',
        '    - [On-call](#p-301)',
        '  - [Brainstorm](#p-113) *(Whiteboard)*',
        '  - [Child of secret](#p-115)',
      ].join('\n'),
    );
    expect(text).not.toContain('Secret page');
  });

  it('omits cover and TOC when off', () => {
    const text = convert(tree({ cover: null, toc: false })).files[0]!.text;
    expect(text.startsWith(`<a id="p-${PAGE_ID}"></a>`)).toBe(true);
    expect(text).not.toContain('**Contents**');
  });

  it('adds an italic meta line under each title when page meta is on', () => {
    const on = convert(tree()).files[0]!.text;
    expect(on).toContain(
      '# Architecture\n\n*Engineering › Payments · Last updated 2026-09-30 by Jane Doe · [Open in Confluence](https://acme.atlassian.net/wiki/spaces/ENG/pages/111)*',
    );
    expect(on).toContain('# Runbooks\n\n*Folder · [Open in Confluence]');
    const off = convert(tree({ options: { includePageMeta: false } })).files[0]!.text;
    expect(off).not.toContain('Open in Confluence');
    expect(off).toContain('# Architecture\n\n## Top');
  });

  it('reports a page without body as unavailable', () => {
    const text = md('', {}).toString();
    expect(text).toContain('# Page');
    const r = convert(convertInput([{ ref: ref('9', 'Gone', 0) }]));
    expect(r.files[0]!.text).toContain(
      'The content of this page is not available. [Open it in Confluence](https://acme.atlassian.net/wiki/spaces/ENG/pages/9)',
    );
  });
});

describe('convertPages (markdown) — separate files', () => {
  it('writes one numbered file per page plus a contents index', () => {
    const r = convert(tree({ separate: true, toc: true, cover: COVER }));
    expect(r.files.map((f) => f.path)).toEqual([
      '00-Contents.md',
      '01-Checkout v3 Tech Spec.md',
      '02-Architecture.md',
      '03-Runbooks.md',
      '04-On-call.md',
      '05-Brainstorm.md',
      '06-Child of secret.md',
    ]);
    const index = r.files[0]!.text;
    expect(index.startsWith('---\ntitle: "Checkout v3"')).toBe(true);
    expect(index).toContain('# Checkout v3');
    expect(index).toContain('- [Checkout v3 Tech Spec](01-Checkout%20v3%20Tech%20Spec.md)\n  - [Architecture](02-Architecture.md)');
  });

  it('writes the cover alone into the index file when the TOC is off', () => {
    const r = convert(tree({ separate: true, toc: false, cover: COVER }));
    expect(r.files[0]!.path).toBe('00-Contents.md');
    expect(r.files[0]!.text.startsWith(`---\ntitle: "${COVER.title}"\n`)).toBe(true);
    expect(r.files[0]!.text).not.toContain('**Contents**');
    expect(r.files[1]!.path).toBe('01-Checkout v3 Tech Spec.md');
  });

  it('has no index without TOC and cover, and per-page front matter only with page meta', () => {
    const noToc = convert(tree({ separate: true, toc: false }));
    expect(noToc.files[0]!.path).toBe('01-Checkout v3 Tech Spec.md');
    const arch = noToc.files.find((f) => f.path === '02-Architecture.md')!.text;
    expect(arch).toBe(
      [
        '---',
        'title: "Architecture"',
        'id: "111"',
        'space: "ENG"',
        'url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/111"',
        'breadcrumb: ["Engineering", "Payments"]',
        'last_updated: "2026-09-30T10:00:00.000Z"',
        'author: "Jane Doe"',
        'version: 7',
        '---',
        '',
        '# Architecture',
        '',
        '## Top',
        '',
        `Back to [details](01-Checkout%20v3%20Tech%20Spec.md#p${PAGE_ID}-CheckoutV3TechSpec-Details) or [secret](https://acme.atlassian.net/wiki/spaces/ENG/pages/114/Secret).`,
        '',
      ].join('\n'),
    );
    const noMeta = convert(tree({ separate: true, options: { includePageMeta: false } }));
    expect(noMeta.files.find((f) => f.path === '02-Architecture.md')!.text.startsWith('# Architecture\n')).toBe(true);
  });

  it('links between files and keeps same-page anchors local', () => {
    const r = convert(tree({ separate: true }));
    const root = r.files.find((f) => f.path.startsWith('01-'))!.text;
    expect(root).toContain('[Architecture](02-Architecture.md)');
    expect(root).toContain(`[overview](#p${PAGE_ID}-CheckoutV3TechSpec-Overview)`);
    // A link to the page itself has no target in its own file.
    expect(root).toContain('tiny self link,');
    const folder = r.files.find((f) => f.path === '03-Runbooks.md')!.text;
    expect(folder).toContain('- [On-call](04-On-call.md)');
  });

  it('pads file numbers to the export size', () => {
    const pages = Array.from({ length: 101 }, (_, i) => ({ ref: ref(String(1000 + i), `P${i}`, 0) }));
    const r = convert(convertInput(pages, { separate: true }));
    expect(r.files[0]!.path).toBe('001-P0.md');
    expect(r.files[100]!.path).toBe('101-P100.md');
  });
});

describe('convertPages (markdown) — content', () => {
  it('fences code with the Confluence language and a fence longer than any backtick run', () => {
    const text = md(CODE_WITH_BACKTICKS);
    expect(text).toContain('**README.md**\n\n`````bash\nRun it:\n```\nnpm test\n```\nthen ````done````\n`````');
    expect(md(FULL_PAGE)).toContain('```java\npublic class Checkout {\n  void pay()');
    const cls = md(CODE_CLASS);
    expect(cls).toContain('```typescript\nconst a: number = 1;\n```');
    expect(cls).toContain('```\nplain   text\n  indented\n```');
  });

  it('turns panels into labelled blockquotes', () => {
    const full = md(FULL_PAGE);
    expect(full).toContain('> **Info:** Payments go through the **new** gateway.');
    expect(full).toContain('> **Warning:** Careful\n>\n> Do not deploy on Fridays.');
    const text = md(PANELS);
    expect(text).toContain('> **Note:** Mind the gap.\n>\n> - one');
    expect(text).toContain('> **Tip:** Use the cache.');
    expect(text).toContain('> **Release notes**\n>\n> Version 2 is out.');
    expect(text).toContain('> Plain callout.');
  });

  it('renders expand as <details>, status as code and task lists as GFM tasks', () => {
    const text = md(FULL_PAGE);
    expect(text).toContain('<details>\n<summary>Show the rollout plan</summary>\n\nWeek 1: internal users.\n\n</details>');
    expect(text).toContain('State: `IN PROGRESS`');
    expect(text).toContain('- [x] Write spec\n- [ ] Review spec');
  });

  it('keeps the DC 9 expand title (wrapped in a button)', () => {
    expect(md(DC9_EXPAND)).toContain('<details>\n<summary>Introduction</summary>\n\nThe project publishes releases.\n\n</details>');
  });

  it('drops line breaks at the edge of a line, keeps real ones', () => {
    const text = md(STRAY_BREAKS);
    expect(text).toContain('Motivation text.\n\n- Before (multiple `--property` options):\n\n  ```bash\n  run \\\n    --x\n  ```');
    expect(text).toContain('keep\\\nthis break');
  });

  it('links code-formatted links', () => {
    expect(md(CODE_LINK)).toContain('Publish to [`dist.apache.org`](http://dist.apache.org/) and [`release`](https://example.com/r).');
  });

  it('writes simple tables as GFM and keeps the Jira static table', () => {
    const text = md(FULL_PAGE);
    expect(text).toContain('| Field | Description |\n| --- | --- |\n| id | Primary key |\n| amount | Minor units |');
    expect(md(JIRA_TABLE)).toContain(
      '| Key | Summary | Status |\n| --- | --- | --- |\n| [PAY-1](https://acme.atlassian.net/browse/PAY-1) | Add card vault | `DONE` |',
    );
    expect(md(HEADERLESS_TABLE)).toContain('| a\\|b | line 1<br>line 2 |\n| --- | --- |\n| para 1<br>para 2 | **bold** |');
  });

  it('keeps complex tables as clean HTML', () => {
    const text = md(COMPLEX_TABLE);
    expect(text).toContain(
      [
        '<table>',
        '<thead>',
        '<tr><th colspan="2">Plan</th></tr></thead>',
        '<tbody>',
        '<tr><td>Steps</td><td><ul><li>first</li><li>second</li></ul></td></tr>',
        '<tr><td>Code</td><td><pre>SELECT 1;<br><br>SELECT 2;</pre></td></tr></tbody>',
        '</table>',
      ].join('\n'),
    );
    expect(text).not.toMatch(/style=|class=/);
  });

  it('replaces iframes with a visible placeholder that links to the source', () => {
    const r = convert(convertInput([{ ref: ref('200', 'Page', 0), body: body('200', 'Page', IFRAME) }]));
    expect(r.placeholders).toBe(1);
    expect(r.files[0]!.text).toContain(
      "> **Embedded content: Demo video** — This content can't be included in this export. <https://www.youtube.com/embed/abc123> · [View it in Confluence](https://acme.atlassian.net/wiki/spaces/ENG/pages/200)",
    );
    expect(md(INLINE_PLACEHOLDER)).toContain('Watch *[Embedded media (vimeo.com)](https://vimeo.com/123)* now.');
  });

  it('keeps emoji and maps DC emoticons to unicode', () => {
    expect(md(FULL_PAGE)).toContain('🙂 😀');
    expect(md(EMOTICONS)).toContain('Good ✅ bad ❌ idea 💡 party :partyparrot:');
  });

  it('nests lists with correct indentation', () => {
    expect(md(NESTED_LISTS)).toContain(
      // Two lists in a row would merge into one in CommonMark: an empty comment keeps them apart.
      ['1. First', '   - Nested a', '   - Nested b', '     1. Deep', '2. Second', '', '<!-- -->', '', '4. Four', '5. Five'].join('\n'),
    );
  });

  it('keeps a list that follows another list (also through wrapper divs) separate', () => {
    const text = md('<ul><li>a</li></ul><div class="toc-macro"><ul><li>b</li></ul></div><p>x</p><ul><li>c</li></ul>');
    expect(text).toContain('- a\n\n<!-- -->\n\n- b\n\nx\n\n- c\n');
    expect(text.match(/<!-- -->/g)).toHaveLength(1);
  });

  it('escapes Markdown syntax in text but not in code', () => {
    const text = md(SPECIAL_CHARS);
    expect(text).toContain(
      'Use `List<String>` not List\\<String> and 2 \\* 3 = 6, snake_case_name, \\_emph\\_, \\[brackets\\], a \\\\ backslash \\&amp; and \\~\\~strike\\~\\~.',
    );
    expect(text).toContain('1\\. not a list');
    expect(text).toContain('\\# not a heading');
    expect(text).toContain('\\- not a bullet');
    expect(text).toContain('~~gone~~ <sup>2</sup>');
  });

  it('emits anchors for linked targets and falls back to the page for missing ones', () => {
    const text = md(ANCHORS);
    expect(text).toContain('<a id="p200-Page-target"></a>Anchored paragraph.');
    expect(text).toContain('[jump](#p200-Page-target) and [missing](#p-200).');
  });

  it('emits no <a id> for headings nobody links to', () => {
    expect(md(HEADINGS)).not.toContain('<a id="p200');
  });
});

describe('convertPages (markdown) — images', () => {
  it('bundles images as de-duplicated assets with relative paths', () => {
    const r = convert(convertInput([{ ref: ref('200', 'Page', 0), body: body('200', 'Page', IMAGES_DEDUPE) }]));
    expect(r.assets).toEqual([
      { url: 'https://acme.atlassian.net/wiki/download/attachments/200/diagram%20v2.png?version=1&api=v2', path: 'assets/200/diagram v2.png' },
      { url: 'https://acme.atlassian.net/wiki/download/attachments/200/diagram%20v2.png?version=2&api=v2', path: 'assets/200/diagram v2-2.png' },
      { url: 'https://acme.atlassian.net/wiki/download/attachments/200/cell.png', path: 'assets/200/cell.png' },
    ]);
    const text = r.files[0]!.text;
    expect(text).toContain('![first](assets/200/diagram%20v2.png)\n\n![again](assets/200/diagram%20v2.png)');
    // No alt text: the file name.
    expect(text).toContain('![diagram v2.png](assets/200/diagram%20v2-2.png)');
    // Images on other hosts are never downloaded (the export tab only requests the Confluence site).
    expect(text).toContain('![Logo](https://images.example.com/logo.svg)');
    expect(text).toContain('<img src="assets/200/cell.png">');
  });

  it('uses the same relative root for separate files', () => {
    const r = convert(convertInput([{ ref: ref('200', 'Page', 0), body: body('200', 'Page', IMAGES_DEDUPE) }], { separate: true }));
    expect(r.files[0]!.path).toBe('01-Page.md');
    expect(r.files[0]!.text).toContain('![first](assets/200/diagram%20v2.png)');
  });

  it('keeps absolute URLs when images are not downloaded', () => {
    const r = convert(
      convertInput([{ ref: ref('200', 'Page', 0), body: body('200', 'Page', IMAGES_DEDUPE) }], { options: { downloadImages: false } }),
    );
    expect(r.assets).toEqual([]);
    expect(r.files[0]!.text).toContain('![first](https://acme.atlassian.net/wiki/download/attachments/200/diagram%20v2.png?version=1&api=v2)');
    // FULL_PAGE prefers the original over the thumbnail.
    const full = convert(convertInput([{ ref: ROOT, body: body(PAGE_ID, 'x', FULL_PAGE) }], { options: { downloadImages: false } }));
    expect(full.files[0]!.text).toContain(
      '![flow.png](https://acme.atlassian.net/wiki/download/attachments/315494566/flow.png?version=1&api=v2)',
    );
  });

  it('relinks assets that could not be downloaded', () => {
    const r = convert(convertInput([{ ref: ref('200', 'Page', 0), body: body('200', 'Page', IMAGES_DEDUPE) }]));
    const failed = r.assets.filter((a) => a.path.endsWith('diagram v2.png') || a.path.endsWith('cell.png'));
    const files = relinkFailedAssets(r.files, failed);
    const text = files[0]!.text;
    expect(text).toContain('![first](https://acme.atlassian.net/wiki/download/attachments/200/diagram%20v2.png?version=1&api=v2)');
    expect(text).toContain('![again](https://acme.atlassian.net/wiki/download/attachments/200/diagram%20v2.png?version=1&api=v2)');
    expect(text).toContain('![diagram v2.png](assets/200/diagram%20v2-2.png)');
    expect(text).toContain('<img src="https://acme.atlassian.net/wiki/download/attachments/200/cell.png">');
    expect(relinkFailedAssets(r.files, [])).toBe(r.files);
  });
});

describe('convertPages (markdown) — inline edge cases', () => {
  it('merges adjacent emphasis and code spans', () => {
    expect(md('<p>apache-<em>&lt;version&gt;</em><em>[-b#]</em>-incubating</p>')).toContain('apache-*\\<version>\\[-b#\\]*-incubating');
    expect(md('<p>Use <code>x</code><code>y</code> here</p>')).toContain('Use `xy` here');
    expect(md('<p><strong>This is important</strong><strong>: really.</strong> Go</p>')).toContain('**This is important: really.** Go');
  });

  it('falls back to HTML when * delimiters would not open or close', () => {
    // `tests**.** We`: the closing ** is not right-flanking.
    expect(md('<p>tests<strong>.</strong> We</p>')).toContain('tests<strong>.</strong> We');
    expect(md('<p><strong>run(<em>args, \\</em>*kw)</strong></p>')).toContain('**run(<em>args, \\\\</em>\\*kw)**');
    // Whitespace inside the element is written outside the delimiters.
    expect(md('<p>The <em>rc&lt;#&gt; </em>is next and <em>/usr/bin/tar. </em>So</p>')).toContain('The *rc<#>* is next and */usr/bin/tar.* So');
    // Plain cases keep Markdown delimiters.
    expect(md('<p>a <strong>bold</strong> and <em>it</em>, (<strong>x</strong>) <strong><em>both</em> ok</strong></p>')).toContain(
      'a **bold** and *it*, (**x**) ***both* ok**',
    );
  });

  it('does not escape list / heading syntax in the middle of a line', () => {
    const text = md('<p><code>interval.ms</code> - push interval</p><p>- real start</p>');
    expect(text).toContain('`interval.ms` - push interval');
    expect(text).toContain('\\- real start');
  });

  it('keeps a trailing # in a heading', () => {
    expect(md('<h2>Use C #</h2>')).toContain('### Use C \\#');
  });

  it('turns line-through spans into strikethrough', () => {
    expect(md('<p>was <span style="text-decoration: line-through;">old</span> new</p>')).toContain('was ~~old~~ new');
  });

  it('keeps blank lines in a code block that starts a list item', () => {
    const text = md('<ol><li><pre>a</pre></li><li><pre>x\n\n\ny   </pre></li></ol><p>after   </p>');
    expect(text).toContain('1. ```\n   a\n   ```\n');
    expect(text).toContain('   x\n\n\n   y\n');
    expect(text).not.toMatch(/^[ \t]+$/m);
  });
});

describe('markdown helpers', () => {
  it('escapes only what GFM needs', () => {
    expect(escapeMarkdown('a_b_c')).toBe('a_b_c');
    expect(escapeMarkdown('_a_')).toBe('\\_a\\_');
    expect(escapeMarkdown('<b>x</b> 1 < 2')).toBe('\\<b>x\\</b> 1 < 2');
    expect(escapeMarkdown('1) one')).toBe('1\\) one');
    expect(escapeMarkdown('+ plus')).toBe('\\+ plus');
    expect(escapeMarkdown('~5 min')).toBe('~5 min');
  });

  it('tidies blank lines and trailing whitespace but leaves code alone', () => {
    expect(tidyMarkdown('a  \n\n\n\nb \n```\nx  \n\n\n\ny\n```\n\n')).toBe('a\n\nb\n```\nx  \n\n\n\ny\n```\n');
  });

  it('is deterministic', () => {
    expect(convert(tree({ cover: COVER, toc: true }))).toEqual(convert(tree({ cover: COVER, toc: true })));
  });
});
