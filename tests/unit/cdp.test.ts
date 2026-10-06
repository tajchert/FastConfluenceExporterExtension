import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPTIONS } from '../../lib/types';

type CdpModule = typeof import('../../lib/render/cdp');

const PDF = new TextEncoder().encode('%PDF-1.7\n% fake pdf body\n%%EOF');
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

interface Mock {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  getTargets: ReturnType<typeof vi.fn>;
  onDetachListeners: ((source: { tabId?: number }, reason: string) => void)[];
}

let mock: Mock;
let cdp: CdpModule;

/** Default CDP behaviour: stream PDF in two chunks. */
function streamingHandler(chunks: Uint8Array[] = [PDF.subarray(0, 10), PDF.subarray(10)]) {
  let i = 0;
  return async (_t: unknown, method: string) => {
    if (method === 'Page.printToPDF') return { data: '', stream: 'h1' };
    if (method === 'IO.read') {
      const c = chunks[i++];
      return { data: b64(c), base64Encoded: true, eof: i >= chunks.length };
    }
    if (method === 'IO.close') return {};
    return {};
  };
}

beforeEach(async () => {
  vi.resetModules();
  mock = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(streamingHandler()),
    getTargets: vi.fn(async () => []),
    onDetachListeners: [],
  };
  vi.stubGlobal('chrome', {
    debugger: {
      attach: mock.attach,
      detach: mock.detach,
      sendCommand: mock.sendCommand,
      getTargets: mock.getTargets,
      onDetach: { addListener: (fn: Mock['onDetachListeners'][number]) => mock.onDetachListeners.push(fn) },
    },
  });
  cdp = await import('../../lib/render/cdp');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const methods = () => mock.sendCommand.mock.calls.map((c) => c[1] as string);
const printArgs = (n = 0) =>
  mock.sendCommand.mock.calls.filter((c) => c[1] === 'Page.printToPDF')[n][2] as Record<string, unknown>;

describe('toPrintParams', () => {
  it('converts paper and margins to inches', () => {
    const p = cdp.toPrintParams(DEFAULT_OPTIONS);
    expect(p.paperWidthIn).toBeCloseTo(8.2677, 3);
    expect(p.paperHeightIn).toBeCloseTo(11.6929, 3);
    expect(p.marginTopIn).toBeCloseTo(18 / 25.4, 3);
    expect(p.marginLeftIn).toBeCloseTo(15 / 25.4, 3);
    expect(p.landscape).toBe(false);
    expect(p.displayHeaderFooter).toBe(true);
    expect(p.footerTemplate).toContain('pageNumber');
    expect(p.footerTemplate).toContain('totalPages');
    expect(p.headerTemplate).toBe('<div></div>');
  });

  it('honours letter/landscape and disabled page numbers', () => {
    const p = cdp.toPrintParams({ ...DEFAULT_OPTIONS, paperSize: 'Letter', orientation: 'landscape', pageNumbers: false });
    expect(p.paperWidthIn).toBeCloseTo(8.5, 3);
    expect(p.paperHeightIn).toBeCloseTo(11, 3);
    expect(p.landscape).toBe(true);
    expect(p.displayHeaderFooter).toBe(false);
  });
});

describe('printTabToPdf', () => {
  it('attaches, prints as stream, reads until eof, closes and detaches', async () => {
    const bytes = await cdp.printTabToPdf(7, cdp.toPrintParams(DEFAULT_OPTIONS));
    expect(bytes).toEqual(PDF);
    expect(mock.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    expect(methods()).toEqual(['Page.printToPDF', 'IO.read', 'IO.read', 'IO.close']);
    const args = printArgs();
    expect(args).toMatchObject({
      transferMode: 'ReturnAsStream',
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    expect(String(args.footerTemplate)).toContain('totalPages');
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('omits header/footer templates when page numbers are off', async () => {
    await cdp.printTabToPdf(1, cdp.toPrintParams({ ...DEFAULT_OPTIONS, pageNumbers: false }));
    expect(printArgs()).not.toHaveProperty('footerTemplate');
    expect(printArgs().displayHeaderFooter).toBe(false);
  });

  it('accepts inline data when Chrome ignores the stream transfer mode', async () => {
    mock.sendCommand.mockImplementation(async () => ({ data: b64(PDF) }));
    expect(await cdp.printTabToPdf(1, cdp.toPrintParams(DEFAULT_OPTIONS))).toEqual(PDF);
  });

  it('retries without experimental flags when Chrome rejects them', async () => {
    const stream = streamingHandler([PDF]);
    let first = true;
    mock.sendCommand.mockImplementation(async (t: unknown, method: string, params: unknown) => {
      if (method === 'Page.printToPDF' && first) {
        first = false;
        throw new Error('Invalid parameters: generateTaggedPDF');
      }
      return stream(t, method);
    });
    const bytes = await cdp.printTabToPdf(1, cdp.toPrintParams(DEFAULT_OPTIONS));
    expect(bytes).toEqual(PDF);
    expect(printArgs(0)).toHaveProperty('generateDocumentOutline', true);
    expect(printArgs(1)).not.toHaveProperty('generateDocumentOutline');
    expect(printArgs(1)).not.toHaveProperty('generateTaggedPDF');
  });

  it('does not retry unrelated print errors and still detaches', async () => {
    mock.sendCommand.mockImplementation(async () => {
      throw new Error('Printing failed');
    });
    await expect(cdp.printTabToPdf(1, cdp.toPrintParams(DEFAULT_OPTIONS))).rejects.toThrow(/Printing failed/);
    expect(methods()).toEqual(['Page.printToPDF']);
    expect(mock.detach).toHaveBeenCalledTimes(1);
  });

  it('rejects non-PDF output', async () => {
    mock.sendCommand.mockImplementation(streamingHandler([new TextEncoder().encode('<html>')]));
    await expect(cdp.printTabToPdf(1, cdp.toPrintParams(DEFAULT_OPTIONS))).rejects.toThrow(/not a PDF/);
    expect(mock.detach).toHaveBeenCalled();
  });

  it('throws DebuggerUnavailableError when another debugger holds the tab', async () => {
    mock.attach.mockRejectedValue(new Error('Another debugger is already attached to the tab with id: 1.'));
    mock.detach.mockRejectedValue(new Error('Debugger is not attached to the tab with id: 1.'));
    const p = cdp.printTabToPdf(1, cdp.toPrintParams(DEFAULT_OPTIONS));
    await expect(p).rejects.toBeInstanceOf(cdp.DebuggerUnavailableError);
    expect(mock.sendCommand).not.toHaveBeenCalled();
  });

  it('recovers a stale session of its own', async () => {
    mock.attach
      .mockRejectedValueOnce(new Error('Another debugger is already attached to the tab with id: 1.'))
      .mockResolvedValueOnce(undefined);
    expect(await cdp.printTabToPdf(1, cdp.toPrintParams(DEFAULT_OPTIONS))).toEqual(PDF);
    expect(mock.attach).toHaveBeenCalledTimes(2);
  });

  it('maps policy / other attach failures to DebuggerUnavailableError', async () => {
    mock.attach.mockRejectedValue(new Error('Cannot attach to this target.'));
    await expect(cdp.printTabToPdf(1, cdp.toPrintParams(DEFAULT_OPTIONS))).rejects.toBeInstanceOf(
      cdp.DebuggerUnavailableError,
    );
  });

  it('reports a closed tab as a regular error', async () => {
    mock.attach.mockRejectedValue(new Error('No tab with given id 5.'));
    const err = await cdp.printTabToPdf(5, cdp.toPrintParams(DEFAULT_OPTIONS)).catch((e) => e);
    expect(err).not.toBeInstanceOf(cdp.DebuggerUnavailableError);
    expect(String(err.message)).toMatch(/closed/);
  });

  it('detaches immediately on abort and rejects with AbortError', async () => {
    const ac = new AbortController();
    let rejectPending: (e: Error) => void = () => undefined;
    mock.sendCommand.mockImplementation(
      (_t: unknown, method: string) =>
        new Promise((_, reject) => {
          if (method === 'Page.printToPDF') rejectPending = reject;
        }),
    );
    mock.detach.mockImplementation(async () => {
      rejectPending(new Error('Debugger is not attached to the tab with id: 3.'));
    });
    const p = cdp.printTabToPdf(3, cdp.toPrintParams(DEFAULT_OPTIONS), ac.signal);
    await vi.waitFor(() => expect(mock.sendCommand).toHaveBeenCalled());
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it('rejects up front when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(cdp.printTabToPdf(3, cdp.toPrintParams(DEFAULT_OPTIONS), ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mock.attach).not.toHaveBeenCalled();
  });

  it('explains a user-cancelled debugging session', async () => {
    mock.sendCommand.mockImplementation(async (_t: unknown, method: string) => {
      if (method === 'Page.printToPDF') {
        for (const l of mock.onDetachListeners) l({ tabId: 4 }, 'canceled_by_user');
        throw new Error('Detached while handling command.');
      }
      return {};
    });
    await expect(cdp.printTabToPdf(4, cdp.toPrintParams(DEFAULT_OPTIONS))).rejects.toThrow(/Cancel/);
  });

  it('runs beforePrint hooks while attached', async () => {
    const order: string[] = [];
    mock.attach.mockImplementation(async () => void order.push('attach'));
    const base = streamingHandler([PDF]);
    mock.sendCommand.mockImplementation(async (t: unknown, method: string) => {
      order.push(method);
      return base(t, method);
    });
    await cdp.printTabToPdf(1, cdp.toPrintParams(DEFAULT_OPTIONS), undefined, {
      beforePrint: async (send) => {
        await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      },
    });
    expect(order.slice(0, 3)).toEqual(['attach', 'Emulation.setFocusEmulationEnabled', 'Page.printToPDF']);
  });
});

describe('detachAll', () => {
  it('detaches known and still-attached tab targets, ignoring errors', async () => {
    mock.getTargets.mockResolvedValue([
      { type: 'page', id: 'a', tabId: 11, attached: true, title: '', url: '' },
      { type: 'page', id: 'b', tabId: 12, attached: false, title: '', url: '' },
      { type: 'other', id: 'c', attached: true, title: '', url: '' },
    ]);
    mock.detach.mockRejectedValueOnce(new Error('not attached'));
    await cdp.detachAll();
    expect(mock.detach.mock.calls.map((c) => c[0])).toEqual([{ tabId: 11 }]);
  });
});
