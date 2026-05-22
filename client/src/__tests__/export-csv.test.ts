import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Browser API stubs ────────────────────────────────────────────────────────
const mockClick       = vi.fn();
const mockCreateURL   = vi.fn().mockReturnValue('blob:mock-url');
const mockRevokeURL   = vi.fn();
const mockCreateElement = vi.fn().mockReturnValue({
  href: '',
  download: '',
  click: mockClick,
});

beforeEach(() => {
  vi.stubGlobal('URL', { createObjectURL: mockCreateURL, revokeObjectURL: mockRevokeURL });
  vi.stubGlobal('document', { createElement: mockCreateElement });
  vi.stubGlobal('Blob', class {
    constructor(public parts: BlobPart[], public opts?: BlobPropertyBag) {}
  });
  vi.clearAllMocks();
});

// Import after stubs are set up
const { downloadCsv } = await import('../lib/export-csv');

describe('downloadCsv', () => {
  it('does nothing for empty rows', () => {
    downloadCsv('test.csv', []);
    expect(mockCreateURL).not.toHaveBeenCalled();
    expect(mockClick).not.toHaveBeenCalled();
  });

  it('generates correct CSV headers', () => {
    downloadCsv('test.csv', [{ name: 'Alice', score: 42 }]);
    const blob = mockCreateURL.mock.calls[0][0] as any;
    const csv = blob.parts[0] as string;
    expect(csv.split('\n')[0]).toBe('name,score');
  });

  it('generates correct CSV data row', () => {
    downloadCsv('test.csv', [{ name: 'Alice', score: 42 }]);
    const blob = mockCreateURL.mock.calls[0][0] as any;
    const csv = blob.parts[0] as string;
    expect(csv.split('\n')[1]).toBe('Alice,42');
  });

  it('wraps values containing commas in quotes', () => {
    downloadCsv('test.csv', [{ name: 'Smith, John', score: 10 }]);
    const blob = mockCreateURL.mock.calls[0][0] as any;
    const csv = blob.parts[0] as string;
    expect(csv).toContain('"Smith, John"');
  });

  it('escapes double-quotes inside values', () => {
    downloadCsv('test.csv', [{ note: 'He said "hello"' }]);
    const blob = mockCreateURL.mock.calls[0][0] as any;
    const csv = blob.parts[0] as string;
    expect(csv).toContain('"He said ""hello"""');
  });

  it('handles null and undefined values as empty string', () => {
    downloadCsv('test.csv', [{ a: null, b: undefined, c: 'ok' }]);
    const blob = mockCreateURL.mock.calls[0][0] as any;
    const csv = blob.parts[0] as string;
    const row = csv.split('\n')[1];
    expect(row).toBe(',,ok');
  });

  it('sets the correct filename on the anchor', () => {
    const anchor = { href: '', download: '', click: mockClick };
    mockCreateElement.mockReturnValueOnce(anchor);
    downloadCsv('my-export.csv', [{ x: 1 }]);
    expect(anchor.download).toBe('my-export.csv');
  });

  it('triggers a click to start download', () => {
    downloadCsv('test.csv', [{ x: 1 }]);
    expect(mockClick).toHaveBeenCalledOnce();
  });

  it('revokes the object URL after clicking', () => {
    downloadCsv('test.csv', [{ x: 1 }]);
    expect(mockRevokeURL).toHaveBeenCalledWith('blob:mock-url');
  });
});
