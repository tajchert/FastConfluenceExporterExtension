/**
 * Vector PDF printing of a tab through the Chrome DevTools Protocol (`chrome.debugger`).
 *
 * The debugger is attached only for the duration of one print (Chrome shows the "… started
 * debugging this browser" infobar while attached) and is always detached in `finally`.
 * Runs in the service worker.
 */
import { effectiveMarginsMm, paperSizeMm } from '../assemble/geometry';
import type { ExportOptions } from '../types';
import { base64ToBytes } from '../util/base64';

export interface PrintParams {
  paperWidthIn: number;
  paperHeightIn: number;
  marginTopIn: number;
  marginBottomIn: number;
  marginLeftIn: number;
  marginRightIn: number;
  landscape: boolean;
  displayHeaderFooter: boolean;
  headerTemplate: string;
  footerTemplate: string;
  outline: boolean;
  tagged: boolean;
}

/** Thrown when Chrome refuses to attach the debugger (DevTools/another extension, policy). */
export class DebuggerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DebuggerUnavailableError';
  }
}

/** Optional hooks for callers that need extra CDP commands while the debugger is attached. */
export interface PrintHooks {
  /** Runs after attach, before `Page.printToPDF`. Use `send` for additional CDP commands. */
  beforePrint?: (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<void>;
}

const MM_PER_IN = 25.4;
const IO_READ_SIZE = 2 * 1024 * 1024;

const round = (n: number) => Math.round(n * 10000) / 10000;
const mmToIn = (mm: number) => round(Math.max(0, mm) / MM_PER_IN);

/**
 * Footer with "n / total". Chrome renders header/footer templates in a separate tiny document:
 * default font-size is ~0, there is a built-in padding, and colours are dropped unless
 * print-color-adjust is set — hence the explicit styles.
 */
export const PAGE_NUMBER_FOOTER =
  '<style>#header,#footer{padding:0!important;}</style>' +
  '<div style="width:100%;margin:0 12mm;font-size:8px;line-height:1;color:#666;text-align:center;' +
  "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
  '-webkit-print-color-adjust:exact;print-color-adjust:exact;">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

export function toPrintParams(options: ExportOptions): PrintParams {
  // Same geometry as the print document's @page rule (lib/assemble/document.ts buildPrintCss):
  // portrait sheet size (Chrome swaps it for `landscape`) and the effective margins, whose bottom
  // margin is raised so the page-number footer has room.
  const { width: w, height: h } = paperSizeMm(options.paperSize, 'portrait');
  const m = effectiveMarginsMm(options);
  return {
    // Chrome swaps width/height itself when `landscape` is set; with preferCSSPageSize the
    // @page rule of the print document wins anyway — these values are the fallback.
    paperWidthIn: mmToIn(w),
    paperHeightIn: mmToIn(h),
    marginTopIn: mmToIn(m.top),
    marginBottomIn: mmToIn(m.bottom),
    marginLeftIn: mmToIn(m.left),
    marginRightIn: mmToIn(m.right),
    landscape: options.orientation === 'landscape',
    displayHeaderFooter: options.pageNumbers,
    headerTemplate: '<div></div>',
    footerTemplate: PAGE_NUMBER_FOOTER,
    outline: true,
    tagged: true,
  };
}

/** Tabs this module currently has the debugger attached to. */
const attachedTabs = new Set<number>();
/** Why Chrome detached us (user clicked "Cancel" on the infobar, tab closed…). */
const detachReasons = new Map<number, string>();

if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    if (attachedTabs.delete(source.tabId)) detachReasons.set(source.tabId, reason);
  });
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

function abortError(): DOMException {
  return new DOMException('The export was cancelled.', 'AbortError');
}

async function detachQuietly(tabId: number): Promise<void> {
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // "Debugger is not attached to the tab" / tab already closed — nothing to clean up.
  }
}

async function attach(tabId: number): Promise<void> {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    const msg = errorMessage(e);
    if (/no tab with (given )?id/i.test(msg)) {
      throw new Error('The export tab was closed before printing finished.');
    }
    if (/already attached/i.test(msg)) {
      // Possibly a stale session of ours (e.g. after a service-worker restart). Detaching only
      // ever affects our own session; if someone else holds the tab this fails and we give up.
      let wasOurs = false;
      try {
        await chrome.debugger.detach(target);
        wasOurs = true;
      } catch {
        /* held by DevTools or another extension */
      }
      if (wasOurs) {
        try {
          await chrome.debugger.attach(target, '1.3');
          attachedTabs.add(tabId);
          detachReasons.delete(tabId);
          return;
        } catch (e2) {
          throw new DebuggerUnavailableError(
            `Chrome did not allow printing this tab: ${errorMessage(e2)}`,
          );
        }
      }
      throw new DebuggerUnavailableError(
        'Another debugger (DevTools or another extension) is attached to the export tab. ' +
          'Close it and try again.',
      );
    }
    throw new DebuggerUnavailableError(`Chrome did not allow printing this tab: ${msg}`);
  }
  attachedTabs.add(tabId);
  detachReasons.delete(tabId);
}

function buildPrintArgs(p: PrintParams, experimental: boolean): Record<string, unknown> {
  const args: Record<string, unknown> = {
    landscape: p.landscape,
    displayHeaderFooter: p.displayHeaderFooter,
    printBackground: true,
    paperWidth: p.paperWidthIn,
    paperHeight: p.paperHeightIn,
    marginTop: p.marginTopIn,
    marginBottom: p.marginBottomIn,
    marginLeft: p.marginLeftIn,
    marginRight: p.marginRightIn,
    preferCSSPageSize: true,
    transferMode: 'ReturnAsStream',
  };
  if (p.displayHeaderFooter) {
    args.headerTemplate = p.headerTemplate || '<div></div>';
    args.footerTemplate = p.footerTemplate || '<div></div>';
  }
  if (experimental) {
    if (p.outline) args.generateDocumentOutline = true;
    if (p.tagged) args.generateTaggedPDF = true;
  }
  return args;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Prints the tab's current document to a PDF. Attaches the debugger, prints, streams the
 * result and detaches (always). Aborting detaches immediately, which fails any pending command.
 */
export async function printTabToPdf(
  tabId: number,
  params: PrintParams,
  signal?: AbortSignal,
  hooks?: PrintHooks,
): Promise<Uint8Array> {
  if (signal?.aborted) throw abortError();
  await attach(tabId);
  const target = { tabId };
  const onAbort = () => void detachQuietly(tabId);
  signal?.addEventListener('abort', onAbort, { once: true });

  const send = async (method: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (signal?.aborted) throw abortError();
    try {
      return await chrome.debugger.sendCommand(target, method, args);
    } catch (e) {
      if (signal?.aborted) throw abortError();
      const reason = detachReasons.get(tabId);
      if (reason === 'canceled_by_user') {
        throw new Error('Printing was stopped because the debugging bar was closed ("Cancel").');
      }
      if (reason === 'target_closed') throw new Error('The export tab was closed before printing finished.');
      throw new Error(`${method} failed: ${errorMessage(e)}`);
    }
  };

  try {
    if (hooks?.beforePrint) await hooks.beforePrint(send);

    let res: { data?: string; stream?: string } | undefined;
    try {
      res = (await send('Page.printToPDF', buildPrintArgs(params, true))) as typeof res;
    } catch (e) {
      const msg = errorMessage(e);
      // Older Chrome builds reject the experimental outline/tagged flags as invalid parameters.
      if (!signal?.aborted && (params.outline || params.tagged) && /invalid param|unknown|unrecogni[sz]ed/i.test(msg)) {
        res = (await send('Page.printToPDF', buildPrintArgs(params, false))) as typeof res;
      } else {
        throw e;
      }
    }

    let bytes: Uint8Array;
    if (res?.stream) {
      const handle = res.stream;
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const r = (await send('IO.read', { handle, size: IO_READ_SIZE })) as
            | { data: string; eof: boolean; base64Encoded?: boolean }
            | undefined;
          if (!r) throw new Error('IO.read returned no data');
          if (r.data) {
            const chunk = r.base64Encoded ? base64ToBytes(r.data) : new TextEncoder().encode(r.data);
            chunks.push(chunk);
            total += chunk.length;
          }
          if (r.eof) break;
        }
      } finally {
        if (!signal?.aborted) await send('IO.close', { handle }).catch(() => undefined);
      }
      bytes = concatChunks(chunks, total);
    } else if (res?.data) {
      bytes = base64ToBytes(res.data);
    } else {
      throw new Error('Chrome returned an empty PDF.');
    }

    if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
      throw new Error('Chrome returned data that is not a PDF.');
    }
    return bytes;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await detachQuietly(tabId);
    detachReasons.delete(tabId);
  }
}

/**
 * Detaches every debugger session this extension holds — including sessions that survived a
 * service-worker restart (detach only affects our own sessions, so it is safe to try on every
 * attached tab).
 */
export async function detachAll(): Promise<void> {
  const tabIds = new Set(attachedTabs);
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) if (t.attached && typeof t.tabId === 'number') tabIds.add(t.tabId);
  } catch {
    /* getTargets unavailable — fall back to the ones we know */
  }
  await Promise.all([...tabIds].map((id) => detachQuietly(id)));
}
