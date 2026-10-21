import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Browser API stubs ────────────────────────────────────────────────────────
const mockClick       = vi.fn();
const mockCreateURL   = vi.fn().mockReturnValue('blob:mock-url');
const mockRevokeURL   = vi.fn();
const mockRemove      = vi.fn();
const mockAppendChild = vi.fn();
const makeAnchor = () => ({ href: '', download: '', click: mockClick, remove: mockRemove });
const mockCreateElement = vi.fn().mockImplementation(makeAnchor);

// The CSV text is the Blob part after the UTF-8 BOM part.
const csvOf = (blob: any): string => (blob.parts as string[]).join('').replace(/^\uFEFF/, '');

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('URL', { createObjectURL: mockCreateURL, revokeObjectURL: mockRevokeURL });
  vi.stubGlobal('document', { createElement: mockCreateElement, body: { appendChild: mockAppendChild } });
  vi.stubGlobal('Blob', class {
    constructor(public parts: BlobPart[], public opts?: BlobPropertyBag) {}
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// This top-level import runs BEFORE any beforeEach stub. That is fine because export-csv only
// touches URL / document / Blob when downloadCsv() is called (inside a test), never at load time.
const { downloadCsv } = await import('../lib/export-csv');

describe('downloadCsv', () => {
  it('does nothing for empty rows', () => {
    downloadCsv('test.csv', []);
    expect(mockCreateURL).not.toHaveBeenCalled();
    expect(mockClick).not.toHaveBeenCalled();
  });

  it('generates correct CSV headers', () => {
    downloadCsv('test.csv', [{ name: 'Alice', score: 42 }]);
    const csv = csvOf(mockCreateURL.mock.calls[0][0]);
    expect(csv.split('\n')[0]).toBe('name,score');
  });

  it('generates correct CSV data row', () => {
    downloadCsv('test.csv', [{ name: 'Alice', score: 42 }]);
    const csv = csvOf(mockCreateURL.mock.calls[0][0]);
    expect(csv.split('\n')[1]).toBe('Alice,42');
  });

  it('wraps values containing commas in quotes', () => {
    downloadCsv('test.csv', [{ name: 'Smith, John', score: 10 }]);
    const csv = csvOf(mockCreateURL.mock.calls[0][0]);
    expect(csv).toContain('"Smith, John"');
  });

  it('escapes double-quotes inside values', () => {
    downloadCsv('test.csv', [{ note: 'He said "hello"' }]);
    const csv = csvOf(mockCreateURL.mock.calls[0][0]);
    expect(csv).toContain('"He said ""hello"""');
  });

  it('handles null and undefined values as empty string', () => {
    downloadCsv('test.csv', [{ a: null, b: undefined, c: 'ok' }]);
    const csv = csvOf(mockCreateURL.mock.calls[0][0]);
    const row = csv.split('\n')[1];
    expect(row).toBe(',,ok');
  });

  it('sets the correct filename on the anchor', () => {
    const anchor = makeAnchor();
    mockCreateElement.mockReturnValueOnce(anchor);
    downloadCsv('my-export.csv', [{ x: 1 }]);
    expect(anchor.download).toBe('my-export.csv');
  });

  it('triggers a click to start download', () => {
    downloadCsv('test.csv', [{ x: 1 }]);
    expect(mockClick).toHaveBeenCalledOnce();
  });

  it('revokes the object URL after clicking (on the next tick)', () => {
    downloadCsv('test.csv', [{ x: 1 }]);
    expect(mockRevokeURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(mockRevokeURL).toHaveBeenCalledWith('blob:mock-url');
    expect(mockRemove).toHaveBeenCalled();
  });

  it('attaches the anchor to the document before clicking', () => {
    downloadCsv('test.csv', [{ x: 1 }]);
    expect(mockAppendChild).toHaveBeenCalledOnce();
  });

  it('prepends a UTF-8 BOM', () => {
    downloadCsv('test.csv', [{ x: 1 }]);
    const blob = mockCreateURL.mock.calls[0][0] as any;
    expect((blob.parts as string[]).join('').startsWith('\uFEFF')).toBe(true);
  });

  it('guards formula-like strings but not negative numbers', () => {
    downloadCsv('test.csv', [{ a: '=SUM(A1)', b: -5, c: '-12.5', d: '-foo' }]);
    const row = csvOf(mockCreateURL.mock.calls[0][0]).split('\n')[1];
    expect(row).toBe("'=SUM(A1),-5,-12.5,'-foo");
  });
});
