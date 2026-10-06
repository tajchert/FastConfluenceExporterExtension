/**
 * PDF post-processing with pdf-lib (service worker): concatenating print batches, locating page
 * sections, inserting live-rendered pages, outline (bookmarks) and metadata.
 *
 * How Chrome encodes navigation (verified with Chrome's Page.printToPDF, see
 * scripts/experiments/make-pdf-fixtures.mjs and tests/unit/fixtures/chrome-*.pdf):
 *
 *  - Named destinations live in the catalog's PDF-1.1 style `/Dests` dictionary (not in a
 *    `/Names` name tree): `/p-101 [ 11 0 R /XYZ 6 827.67 0 ]`. Chrome only emits a destination
 *    for an element id that is the target of an `<a href="#id">` in the same document. Links
 *    inside a `display:none` container are enough (they create the destination but no link
 *    annotation), so the assembled document should contain a hidden link block pointing at every
 *    `#p-{id}` of the batch.
 *  - Internal links are `/Link` annotations with `/Dest /name` (named, never explicit page refs).
 *    Links to ids that do not exist in the printed document are dropped by Chrome.
 *  - `generateDocumentOutline` produces `/Outlines` whose first level are the `<h1>` elements
 *    (titles with collapsed whitespace, UTF-16BE hex strings for non-ASCII) with explicit
 *    `/Dest [pageRef /XYZ x y 0]`, nested by heading level.
 *  - Sections are located through named destinations, falling back to matching outline titles.
 *  - Pages are copied without the tagged-PDF structure tree: copied pages lose their
 *    /StructParents keys so they never point into another document's ParentTree (they would
 *    map their content to unrelated structure elements).
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
  StandardFonts,
  rgb,
  type PDFPage,
} from 'pdf-lib';
import type { PageRef } from '../types';

export interface OutlineItem {
  title: string;
  pageIndex: number;
  children: OutlineItem[];
}

export interface PdfMetadata {
  title: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator: string;
  producer?: string;
}

/** One export's final document, see finalizeExport(). */
export interface ExportFinalizeOptions {
  metadata: PdfMetadata;
  /**
   * Every page of the export in document order, including pages that are not in the PDF
   * (`excludeIds`): their children take their place in the bookmark hierarchy.
   */
  pages: PageRef[];
  excludeIds?: Iterable<string>;
  /** Live-rendered PDFs by page id, inserted right after that page's header sheet. */
  live?: Map<string, Uint8Array>;
  stampPageNumbers?: FinalizeOptions['stampPageNumbers'];
}

export interface ExportFinalizeResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Live pages whose header sheet could not be located (not inserted). */
  unplacedLive: string[];
}

export interface FinalizeOptions {
  metadata: PdfMetadata;
  /** Pages to insert after `afterPageIndex` (0-based, in the base document). -1 = at the start. */
  inserts?: { afterPageIndex: number; pdf: Uint8Array }[];
  /** Replaces any existing outline when given. Page indexes refer to the FINAL document. */
  outline?: OutlineItem[];
  /**
   * Stamps "n / total" centered at the bottom of every sheet. Use only when the base was printed
   * without Chrome's footer (e.g. because live pages are inserted and Chrome's totals would be
   * wrong). `bottomPt` is the baseline distance from the bottom edge (default 18).
   */
  stampPageNumbers?: { bottomPt?: number; fontSizePt?: number; skipFirst?: number };
}

const LOAD_OPTS = { ignoreEncryption: false, updateMetadata: false } as const;

// ───────────────────────────── low-level helpers ─────────────────────────────

const refKey = (r: PDFRef) => `${r.objectNumber} ${r.generationNumber}`;

function decodePdfText(o: PDFObject | undefined): string | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFName) return o.decodeText();
  return undefined;
}

function pageIndexByRef(doc: PDFDocument): Map<string, number> {
  const m = new Map<string, number>();
  doc.getPages().forEach((p, i) => m.set(refKey(p.ref), i));
  return m;
}

/** Normalizes a destination (array, or dict with /D) to its array form. */
function destArray(doc: PDFDocument, value: PDFObject | undefined): PDFArray | undefined {
  const v = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (v instanceof PDFArray) return v;
  if (v instanceof PDFDict) {
    const d = v.lookup(PDFName.of('D'));
    if (d instanceof PDFArray) return d;
  }
  return undefined;
}

/** All named destinations of a document: catalog /Dests dict + /Names → /Dests name tree. */
function readNamedDests(doc: PDFDocument): Map<string, PDFArray> {
  const out = new Map<string, PDFArray>();
  const catalog = doc.catalog;

  const dests = catalog.lookup(PDFName.of('Dests'));
  if (dests instanceof PDFDict) {
    for (const [key, value] of dests.entries()) {
      const arr = destArray(doc, value);
      if (arr && !out.has(key.decodeText())) out.set(key.decodeText(), arr);
    }
  }

  const names = catalog.lookup(PDFName.of('Names'));
  const tree = names instanceof PDFDict ? names.lookup(PDFName.of('Dests')) : undefined;
  const seen = new Set<PDFDict>();
  const walk = (node: PDFObject | undefined, depth: number) => {
    if (!(node instanceof PDFDict) || seen.has(node) || depth > 64) return;
    seen.add(node);
    const pairs = node.lookup(PDFName.of('Names'));
    if (pairs instanceof PDFArray) {
      for (let i = 0; i + 1 < pairs.size(); i += 2) {
        const name = decodePdfText(pairs.lookup(i));
        const arr = destArray(doc, pairs.get(i + 1));
        if (name !== undefined && arr && !out.has(name)) out.set(name, arr);
      }
    }
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i), depth + 1);
  };
  walk(tree, 0);
  return out;
}

function destPageIndex(arr: PDFArray | undefined, byRef: Map<string, number>): number | undefined {
  const first = arr?.get(0);
  if (first instanceof PDFRef) return byRef.get(refKey(first));
  // Remote-style destinations use a page number instead of a reference.
  if (first instanceof PDFNumber) return first.asNumber();
  return undefined;
}

/** Destination of an outline item or link annotation: /Dest (array or name) or /A GoTo /D. */
function itemDest(doc: PDFDocument, item: PDFDict, named: () => Map<string, PDFArray>): PDFArray | undefined {
  let d: PDFObject | undefined = item.get(PDFName.of('Dest'));
  if (!d) {
    const a = item.lookup(PDFName.of('A'));
    if (a instanceof PDFDict && a.lookup(PDFName.of('S'))?.toString() === '/GoTo') d = a.get(PDFName.of('D'));
  }
  if (d instanceof PDFRef) d = doc.context.lookup(d);
  const name = decodePdfText(d);
  if (name !== undefined) return named().get(name);
  return destArray(doc, d);
}

function lazy<T>(fn: () => T): () => T {
  let v: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      v = fn();
      done = true;
    }
    return v as T;
  };
}

// ───────────────────────────── outline read / write ─────────────────────────────

function readOutlineOf(doc: PDFDocument): OutlineItem[] {
  const root = doc.catalog.lookup(PDFName.of('Outlines'));
  if (!(root instanceof PDFDict)) return [];
  const byRef = pageIndexByRef(doc);
  const named = lazy(() => readNamedDests(doc));
  const visited = new Set<PDFDict>();

  const readLevel = (first: PDFObject | undefined, depth: number): OutlineItem[] => {
    const items: OutlineItem[] = [];
    let node = first instanceof PDFRef ? doc.context.lookup(first) : first;
    while (node instanceof PDFDict && !visited.has(node) && depth < 32) {
      visited.add(node);
      const title = (decodePdfText(node.lookup(PDFName.of('Title'))) ?? '').replace(/\s+/g, ' ').trim();
      const pageIndex = destPageIndex(itemDest(doc, node, named), byRef);
      const children = readLevel(node.get(PDFName.of('First')), depth + 1);
      if (pageIndex !== undefined) items.push({ title, pageIndex, children });
      else items.push(...children); // unresolvable item: keep its children
      const next = node.get(PDFName.of('Next'));
      node = next instanceof PDFRef ? doc.context.lookup(next) : next;
    }
    return items;
  };
  return readLevel(root.get(PDFName.of('First')), 0);
}

/** Reads the document outline (bookmarks) with 0-based page indexes. */
export async function readOutline(pdf: Uint8Array): Promise<OutlineItem[]> {
  return readOutlineOf(await PDFDocument.load(pdf, LOAD_OPTS));
}

function countItems(items: OutlineItem[]): number {
  return items.reduce((n, it) => n + 1 + countItems(it.children), 0);
}

/**
 * Writes `/Outlines` (replacing any existing one). Top-level items are open (their direct
 * children visible), deeper levels start collapsed — keeps huge exports navigable.
 */
function writeOutline(doc: PDFDocument, items: OutlineItem[]): void {
  const ctx = doc.context;
  const pages = doc.getPages();
  doc.catalog.delete(PDFName.of('Outlines'));
  const valid = (list: OutlineItem[]): OutlineItem[] =>
    list
      .filter((it) => Number.isInteger(it.pageIndex) && it.pageIndex >= 0 && it.pageIndex < pages.length)
      .map((it) => ({ ...it, children: valid(it.children ?? []) }));
  const clean = valid(items);
  if (clean.length === 0) return;

  const rootRef = ctx.nextRef();

  /** Returns the number of entries visible below `parent` when it is open. */
  const build = (list: OutlineItem[], parentRef: PDFRef, level: number): { first: PDFRef; last: PDFRef; visible: number } => {
    const refs = list.map(() => ctx.nextRef());
    let visible = 0;
    list.forEach((it, i) => {
      const page = pages[it.pageIndex];
      const box = page.getMediaBox();
      const top = box.y + box.height;
      const dict = ctx.obj({}) as PDFDict;
      dict.set(PDFName.of('Title'), PDFHexString.fromText(it.title || 'Untitled'));
      dict.set(PDFName.of('Parent'), parentRef);
      dict.set(PDFName.of('Dest'), ctx.obj([page.ref, PDFName.of('XYZ'), PDFNull, PDFNumber.of(top), PDFNull]));
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      visible += 1;
      if (it.children.length) {
        const sub = build(it.children, refs[i], level + 1);
        dict.set(PDFName.of('First'), sub.first);
        dict.set(PDFName.of('Last'), sub.last);
        const open = level === 0;
        // Positive = open (number of visible descendants); negative = closed.
        dict.set(PDFName.of('Count'), PDFNumber.of(open ? sub.visible : -countItems(it.children)));
        if (open) visible += sub.visible;
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], visible };
  };

  const top = build(clean, rootRef, 0);
  const root = ctx.obj({}) as PDFDict;
  root.set(PDFName.of('Type'), PDFName.of('Outlines'));
  root.set(PDFName.of('First'), top.first);
  root.set(PDFName.of('Last'), top.last);
  root.set(PDFName.of('Count'), PDFNumber.of(top.visible));
  ctx.assign(rootRef, root);
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
}

// ───────────────────────────── page copying ─────────────────────────────

interface PendingLink {
  pageIndex: number;
  /** Destination array without the page ref (e.g. [/XYZ x y z]). */
  view: PDFObject[];
}

/**
 * Prepares `src` pages for copying into another document: explicit page references inside link
 * annotations (and /P back-references) would make pdf-lib's copier duplicate whole pages, so
 * internal link destinations are resolved to (page index, view) and detached first. When
 * `resolveNamed` is set, named destinations are resolved too (used for inserted documents whose
 * names would otherwise collide with the base document's).
 */
function detachInternalLinks(src: PDFDocument, resolveNamed: boolean): Map<PDFDict, PendingLink> {
  const byRef = pageIndexByRef(src);
  const named = lazy(() => readNamedDests(src));
  const pending = new Map<PDFDict, PendingLink>();
  for (const page of src.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    const keep: PDFObject[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      annot.delete(PDFName.of('P'));
      if (annot.lookup(PDFName.of('Subtype'))?.toString() !== '/Link') {
        keep.push(raw);
        continue;
      }
      const destObj = annot.get(PDFName.of('Dest'));
      const action = annot.lookup(PDFName.of('A'));
      const isGoTo = action instanceof PDFDict && action.lookup(PDFName.of('S'))?.toString() === '/GoTo';
      if (!destObj && !isGoTo) {
        keep.push(raw); // URI and other actions
        continue;
      }
      const directDest = destObj ?? (isGoTo ? (action as PDFDict).get(PDFName.of('D')) : undefined);
      const resolvedDirect = directDest instanceof PDFRef ? src.context.lookup(directDest) : directDest;
      const isNamed = decodePdfText(resolvedDirect) !== undefined;
      if (isNamed && !resolveNamed) {
        keep.push(raw);
        continue;
      }
      const arr = itemDest(src, annot, named);
      const pageIndex = destPageIndex(arr, byRef);
      if (!arr || pageIndex === undefined) continue; // dangling internal link: drop it
      const view: PDFObject[] = [];
      for (let j = 1; j < arr.size(); j++) view.push(arr.get(j));
      annot.delete(PDFName.of('Dest'));
      annot.delete(PDFName.of('A'));
      pending.set(annot, { pageIndex, view });
      keep.push(raw);
    }
    page.node.set(PDFName.of('Annots'), src.context.obj(keep));
  }
  return pending;
}

/** Removes tagged-PDF back-references of copied pages (see the header comment). */
function stripStructParents(pages: PDFPage[]): void {
  for (const page of pages) {
    page.node.delete(PDFName.of('StructParents'));
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (annot instanceof PDFDict) annot.delete(PDFName.of('StructParent'));
    }
  }
}

/**
 * Copies all pages of `src` into `dest` (not yet added to its page tree) and re-links internal
 * links. Link annotations are tagged with an index before copying so each copy can be matched
 * to its resolved destination.
 */
async function copyPagesWithLinks(
  dest: PDFDocument,
  src: PDFDocument,
  resolveNamed: boolean,
): Promise<PDFPage[]> {
  const pending = detachInternalLinks(src, resolveNamed);
  const list = [...pending.entries()];
  list.forEach(([annot], i) => annot.set(PDFName.of('CfpLink'), PDFNumber.of(i)));
  const pages = await dest.copyPages(src, src.getPageIndices());
  stripStructParents(pages);
  if (list.length === 0) return pages;
  for (const page of pages) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      const marker = annot.get(PDFName.of('CfpLink'));
      if (!(marker instanceof PDFNumber)) continue;
      annot.delete(PDFName.of('CfpLink'));
      const info = list[marker.asNumber()]?.[1];
      const target = info && pages[info.pageIndex];
      if (target) annot.set(PDFName.of('Dest'), dest.context.obj([target.ref, ...info.view]));
    }
  }
  return pages;
}

// ───────────────────────────── public API ─────────────────────────────

/**
 * Concatenates print batches. Named destinations of every part are merged into the result's
 * catalog `/Dests`, and the parts' outlines are concatenated with page offsets, so links and
 * Chrome's heading bookmarks keep working. A single part is returned as is (keeps the tagged
 * structure).
 *
 * A name defined by several parts (a batch links to a page printed in another batch through a
 * zero-size placeholder target) resolves to the part `owner(name)` returns — the batch holding
 * the real section — or else to the first definition.
 */
export async function concatPdfs(
  parts: Uint8Array[],
  owner?: (name: string) => number | undefined,
): Promise<{ bytes: Uint8Array; offsets: number[] }> {
  if (parts.length === 0) throw new Error('Nothing to merge: no PDF parts.');
  if (parts.length === 1) return { bytes: parts[0], offsets: [0] };

  const out = await PDFDocument.create({ updateMetadata: false });
  const offsets: number[] = [];
  const dests = new Map<string, { part: number; dest: PDFObject[] }>();
  const outline: OutlineItem[] = [];

  for (let part = 0; part < parts.length; part++) {
    const src = await PDFDocument.load(parts[part], LOAD_OPTS);
    const offset = out.getPageCount();
    offsets.push(offset);
    if (part === 0) {
      const lang = src.catalog.get(PDFName.of('Lang'));
      if (lang) out.catalog.set(PDFName.of('Lang'), lang instanceof PDFRef ? src.context.lookup(lang)! : lang);
    }

    const srcByRef = pageIndexByRef(src);
    const srcDests: { name: string; pageIndex: number; view: PDFObject[] }[] = [];
    for (const [name, arr] of readNamedDests(src)) {
      const idx = destPageIndex(arr, srcByRef);
      if (idx === undefined) continue;
      const known = dests.get(name);
      // Keep the first definition unless this part owns the name.
      if (known && (owner?.(name) !== part || known.part === part)) continue;
      const view: PDFObject[] = [];
      for (let j = 1; j < arr.size(); j++) view.push(arr.get(j));
      srcDests.push({ name, pageIndex: idx, view });
    }
    const shift = (items: OutlineItem[]): OutlineItem[] =>
      items.map((it) => ({ title: it.title, pageIndex: it.pageIndex + offset, children: shift(it.children) }));
    outline.push(...shift(readOutlineOf(src)));

    const pages = await copyPagesWithLinks(out, src, false);
    for (const p of pages) out.addPage(p);
    for (const d of srcDests) dests.set(d.name, { part, dest: [pages[d.pageIndex].ref, ...d.view] });
  }

  if (dests.size) {
    const dict = out.context.obj({}) as PDFDict;
    for (const [name, d] of dests) dict.set(PDFName.of(name), out.context.obj(d.dest));
    out.catalog.set(PDFName.of('Dests'), out.context.register(dict));
  }
  if (outline.length) writeOutline(out, outline);
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, offsets };
}

/** Named destination → 0-based page index, for the requested names that exist. */
export async function findDestinationPages(pdf: Uint8Array, names: string[]): Promise<Map<string, number>> {
  const doc = await PDFDocument.load(pdf, LOAD_OPTS);
  const byRef = pageIndexByRef(doc);
  const all = readNamedDests(doc);
  const out = new Map<string, number>();
  for (const n of names) {
    const idx = destPageIndex(all.get(n), byRef);
    if (idx !== undefined) out.set(n, idx);
  }
  return out;
}

const normTitle = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * First sheet of every exported page section (`article#p-{id}`): named destination `p-{id}`
 * first; for pages without one, the first-level outline entries (Chrome's h1 bookmarks = page
 * titles) are matched by title in document order.
 */
export async function findSectionStartPages(
  pdf: Uint8Array,
  pages: { id: string; title: string }[],
): Promise<Map<string, number>> {
  return sectionStartsOf(await PDFDocument.load(pdf, LOAD_OPTS), pages);
}

function sectionStartsOf(doc: PDFDocument, pages: { id: string; title: string }[]): Map<string, number> {
  const byRef = pageIndexByRef(doc);
  const named = readNamedDests(doc);
  const result = new Map<string, number>();
  for (const p of pages) {
    const idx = destPageIndex(named.get(`p-${p.id}`), byRef);
    if (idx !== undefined) result.set(p.id, idx);
  }
  if (result.size === pages.length) return result;

  const top = readOutlineOf(doc);
  let cursor = 0;
  let lastPage = -1;
  for (const p of pages) {
    const known = result.get(p.id);
    if (known !== undefined) {
      // Keep the outline cursor in sync with sections located through destinations.
      while (cursor < top.length && top[cursor].pageIndex < known) cursor++;
      if (cursor < top.length && top[cursor].pageIndex === known && normTitle(top[cursor].title) === normTitle(p.title)) cursor++;
      lastPage = known;
      continue;
    }
    const want = normTitle(p.title);
    for (let i = cursor; i < top.length; i++) {
      if (top[i].pageIndex >= lastPage && normTitle(top[i].title) === want) {
        result.set(p.id, top[i].pageIndex);
        lastPage = top[i].pageIndex;
        cursor = i + 1;
        break;
      }
    }
  }
  return result;
}

/**
 * One bookmark per exported page, nested by `depth`, pointing at the page's first sheet. Pass the
 * full page list: children of a page without a start sheet (failed / skipped / not exported)
 * take its place in the hierarchy. `headingsOf` adds a page's own bookmarks (its headings) before
 * its sub-pages.
 */
export function buildOutline(
  pages: PageRef[],
  startPage: Map<string, number>,
  headingsOf?: (id: string) => OutlineItem[],
): OutlineItem[] {
  const roots: OutlineItem[] = [];
  /** `children` = where items one level deeper than `depth` go. */
  const stack: { depth: number; children: OutlineItem[] }[] = [];
  for (const p of pages) {
    const depth = Number.isFinite(p.depth) ? p.depth : 0;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const siblings = stack.length ? stack[stack.length - 1].children : roots;
    const pageIndex = startPage.get(p.id);
    if (pageIndex === undefined) {
      stack.push({ depth, children: siblings });
      continue;
    }
    const item: OutlineItem = { title: p.title || 'Untitled', pageIndex, children: headingsOf?.(p.id) ?? [] };
    siblings.push(item);
    stack.push({ depth, children: item.children });
  }
  return roots;
}

/** Sheet index after `inserts` (each adds `count` sheets after `afterPageIndex`). */
export function shiftPageIndex(index: number, inserts: { afterPageIndex: number; count: number }[]): number {
  let shifted = index;
  for (const ins of inserts) if (ins.afterPageIndex < index) shifted += ins.count;
  return shifted;
}

function stampNumbers(doc: PDFDocument, font: Awaited<ReturnType<PDFDocument['embedFont']>>, o: NonNullable<FinalizeOptions['stampPageNumbers']>): void {
  const pages = doc.getPages();
  const skip = Math.max(0, o.skipFirst ?? 0);
  const total = pages.length - skip;
  const size = o.fontSizePt ?? 8;
  pages.forEach((page, i) => {
    if (i < skip) return;
    const text = `${i - skip + 1} / ${total}`;
    const w = font.widthOfTextAtSize(text, size);
    const box = page.getMediaBox();
    page.drawText(text, {
      x: box.x + (box.width - w) / 2,
      y: box.y + (o.bottomPt ?? 18),
      size,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
  });
}

/**
 * Final document: inserts live-rendered pages (last to first so indexes stay valid), replaces
 * the outline when given, sets metadata and saves. Existing pages keep their objects, so the
 * base document's link annotations, named destinations and outline stay valid after inserts.
 */
export async function finalizePdf(base: Uint8Array, o: FinalizeOptions): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const doc = await PDFDocument.load(base, LOAD_OPTS);
  const baseCount = doc.getPageCount();

  const inserts = (o.inserts ?? [])
    .map((ins, order) => ({ ...ins, order }))
    .sort((a, b) => b.afterPageIndex - a.afterPageIndex || b.order - a.order);
  for (const ins of inserts) {
    const after = Math.min(Math.max(-1, Math.trunc(ins.afterPageIndex)), baseCount - 1);
    const src = await PDFDocument.load(ins.pdf, LOAD_OPTS);
    const pages = await copyPagesWithLinks(doc, src, true);
    pages.forEach((p, i) => doc.insertPage(after + 1 + i, p));
  }

  if (o.outline) writeOutline(doc, o.outline);
  if (doc.catalog.get(PDFName.of('Outlines'))) doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  else doc.catalog.delete(PDFName.of('PageMode'));

  if (o.stampPageNumbers) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    stampNumbers(doc, font, o.stampPageNumbers);
  }

  setMetadata(doc, o.metadata);
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, pageCount: doc.getPageCount() };
}

function setMetadata(doc: PDFDocument, m: PdfMetadata): void {
  const now = new Date();
  doc.setTitle(m.title, { showInWindowTitleBar: true });
  if (m.author) doc.setAuthor(m.author);
  if (m.subject) doc.setSubject(m.subject);
  if (m.keywords?.length) doc.setKeywords(m.keywords);
  doc.setCreator(m.creator);
  doc.setProducer(m.producer ?? m.creator);
  doc.setCreationDate(now);
  doc.setModificationDate(now);
}

/**
 * Builds the final combined export from the printed (and concatenated) base document, parsing
 * it only once:
 *  1. locates every page section (`p-{id}` destinations, outline titles as fallback);
 *  2. inserts each live-rendered PDF right after its page's header sheet;
 *  3. writes the bookmarks as the page tree (nested by depth, FR-8.4), each page carrying its
 *     own heading bookmarks taken from Chrome's outline (indexes shifted past the inserts);
 *  4. stamps page numbers when asked, sets metadata and saves.
 */
export async function finalizeExport(base: Uint8Array, o: ExportFinalizeOptions): Promise<ExportFinalizeResult> {
  const doc = await PDFDocument.load(base, LOAD_OPTS);
  const excluded = new Set(o.excludeIds ?? []);
  const sections = o.pages.filter((p) => !excluded.has(p.id));
  const starts = sectionStartsOf(doc, sections);
  const chromeTop = readOutlineOf(doc);

  // ── live inserts (applied last to first so base indexes stay valid) ──
  const unplacedLive: string[] = [];
  const planned: { after: number; src: PDFDocument; order: number }[] = [];
  for (const p of sections) {
    const pdf = o.live?.get(p.id);
    if (!pdf) continue;
    const at = starts.get(p.id);
    if (at === undefined) {
      unplacedLive.push(p.id);
      continue;
    }
    const src = await PDFDocument.load(pdf, LOAD_OPTS);
    if (src.getPageCount() > 0) planned.push({ after: at, src, order: planned.length });
  }
  const inserts: { afterPageIndex: number; count: number }[] = [];
  planned.sort((a, b) => b.after - a.after || b.order - a.order);
  for (const ins of planned) {
    const pages = await copyPagesWithLinks(doc, ins.src, true);
    pages.forEach((page, i) => doc.insertPage(ins.after + 1 + i, page));
    inserts.push({ afterPageIndex: ins.after, count: pages.length });
  }
  const shift = (i: number) => shiftPageIndex(i, inserts);
  const shiftItems = (items: OutlineItem[]): OutlineItem[] =>
    items.map((it) => ({ title: it.title, pageIndex: shift(it.pageIndex), children: shiftItems(it.children) }));

  // ── bookmarks: page tree + each page's headings from Chrome's outline ──
  const byId = new Map(sections.map((p) => [p.id, p]));
  const used = new Set<number>();
  const headingsOf = (id: string): OutlineItem[] => {
    const at = starts.get(id);
    const title = normTitle(byId.get(id)?.title ?? '');
    let k = chromeTop.findIndex((it, i) => !used.has(i) && it.pageIndex === at && normTitle(it.title) === title);
    if (k < 0) k = chromeTop.findIndex((it, i) => !used.has(i) && it.pageIndex === at);
    if (k < 0) return [];
    used.add(k);
    return shiftItems(chromeTop[k].children);
  };
  const startPage = new Map<string, number>();
  for (const [id, at] of starts) startPage.set(id, shift(at));
  const outline = buildOutline(o.pages, startPage, headingsOf);
  // Chrome bookmarks that belong to no page (should not happen) are kept, in document order.
  const extra = shiftItems(chromeTop.filter((_, i) => !used.has(i)));
  if (extra.length) {
    outline.push(...extra);
    outline.sort((a, b) => a.pageIndex - b.pageIndex); // stable: page order is already sorted
  }
  writeOutline(doc, outline);
  if (doc.catalog.get(PDFName.of('Outlines'))) doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  else doc.catalog.delete(PDFName.of('PageMode'));

  if (o.stampPageNumbers) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    stampNumbers(doc, font, o.stampPageNumbers);
  }
  setMetadata(doc, o.metadata);
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, pageCount: doc.getPageCount(), unplacedLive };
}
