/**
 * Minimal PDF inspection for the E2E assertions, written against pdf-lib's low-level object model
 * (independent from the extension's own lib/pdf code so the tests verify rather than mirror it).
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString, type PDFObject } from 'pdf-lib';

export interface Outline {
  title: string;
  children: Outline[];
}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head !== '%PDF-') throw new Error(`Not a PDF (starts with ${JSON.stringify(head)})`);
  return PDFDocument.load(bytes, { updateMetadata: false });
}

function text(obj: PDFObject | undefined): string {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return '';
}

function dictAt(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  const o = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return o instanceof PDFDict ? o : undefined;
}

export function readOutline(doc: PDFDocument): Outline[] {
  const root = dictAt(doc, doc.catalog.get(PDFName.of('Outlines')));
  const walk = (first: PDFObject | undefined, guard: Set<PDFDict>): Outline[] => {
    const out: Outline[] = [];
    let item = dictAt(doc, first);
    while (item && !guard.has(item)) {
      guard.add(item);
      out.push({ title: text(item.get(PDFName.of('Title'))), children: walk(item.get(PDFName.of('First')), guard) });
      item = dictAt(doc, item.get(PDFName.of('Next')));
    }
    return out;
  };
  return root ? walk(root.get(PDFName.of('First')), new Set()) : [];
}

/** Named destinations (catalog /Dests dictionary and the /Names → /Dests name tree). */
export function namedDestinations(doc: PDFDocument): string[] {
  const names = new Set<string>();
  const dests = dictAt(doc, doc.catalog.get(PDFName.of('Dests')));
  if (dests) for (const k of dests.keys()) names.add(k.decodeText());
  const tree = dictAt(doc, dictAt(doc, doc.catalog.get(PDFName.of('Names')))?.get(PDFName.of('Dests')));
  const walk = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 32) return;
    const arr = node.lookup(PDFName.of('Names'));
    if (arr instanceof PDFArray) {
      for (let i = 0; i < arr.size(); i += 2) names.add(text(arr.lookup(i)));
    }
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(dictAt(doc, kids.get(i)), depth + 1);
  };
  walk(tree, 0);
  return [...names];
}

/** Link annotations: internal (named destination) targets and external URIs. */
export function links(doc: PDFDocument): { dests: string[]; uris: string[] } {
  const dests: string[] = [];
  const uris: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = dictAt(doc, annots.get(i));
      if (!a || a.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue;
      const dest = a.get(PDFName.of('Dest'));
      if (dest instanceof PDFName) dests.push(dest.decodeText());
      else if (dest instanceof PDFString || dest instanceof PDFHexString) dests.push(dest.decodeText());
      const action = dictAt(doc, a.get(PDFName.of('A')));
      const uri = action?.get(PDFName.of('URI'));
      if (uri) uris.push(text(uri));
      const d2 = action?.get(PDFName.of('D'));
      if (d2 instanceof PDFName) dests.push(d2.decodeText());
      else if (d2 instanceof PDFString || d2 instanceof PDFHexString) dests.push(d2.decodeText());
    }
  }
  return { dests, uris };
}
