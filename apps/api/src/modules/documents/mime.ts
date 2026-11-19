/** Content-based type detection. The declared MIME type and extension are never trusted on their own. */
export const MIME = {
  PDF: 'application/pdf',
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  CSV: 'text/csv',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

const EXT: Record<string, string[]> = {
  [MIME.PDF]: ['pdf'], [MIME.PNG]: ['png'], [MIME.JPEG]: ['jpg', 'jpeg'], [MIME.CSV]: ['csv'], [MIME.XLSX]: ['xlsx'], [MIME.DOCX]: ['docx'],
};

export function detectMime(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return MIME.PDF;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return MIME.PNG;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return MIME.JPEG;
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const head = buf.toString('latin1');
    if (head.includes('xl/')) return MIME.XLSX;
    if (head.includes('word/')) return MIME.DOCX;
    return null; // other zip archives are refused
  }
  if (isPlainText(buf)) return MIME.CSV;
  return null;
}

function isPlainText(buf: Buffer) {
  const sample = buf.subarray(0, 64 * 1024);
  if (sample.includes(0)) return false;
  const s = sample.toString('utf8');
  if (s.includes('�')) return false;
  return /[,;\t]/.test(s) && /\n/.test(s);
}

export interface FileCheck { ok: boolean; mime?: string; reason?: string }

export function checkFile(buf: Buffer, filename: string, accepted: readonly string[], maxBytes: number): FileCheck {
  if (buf.length === 0) return { ok: false, reason: 'The file is empty.' };
  if (buf.length > maxBytes) return { ok: false, reason: `The file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.` };
  if (!/^[^\\/:*?"<>|\x00-\x1f]{1,200}$/.test(filename) || filename.startsWith('.')) return { ok: false, reason: 'The file name is not valid.' };
  const parts = filename.toLowerCase().split('.');
  if (parts.length > 2 && parts.slice(1, -1).some((p) => ['exe', 'js', 'bat', 'cmd', 'sh', 'php', 'html', 'svg', 'scr'].includes(p))) return { ok: false, reason: 'Files with multiple extensions are not accepted.' };
  const ext = parts.length > 1 ? parts.pop()! : '';
  const mime = detectMime(buf);
  if (!mime) return { ok: false, reason: 'This file type is not supported.' };
  if (!EXT[mime]!.includes(ext)) return { ok: false, reason: 'The file extension does not match its content.' };
  if (!accepted.includes(mime)) return { ok: false, reason: `This document must be one of: ${accepted.map((m) => EXT[m]?.[0]?.toUpperCase()).join(', ')}.` };
  if (mime === MIME.PDF) {
    const s = buf.toString('latin1');
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction\s*<<[^>]*\/S\s*\/JavaScript)\b/.test(s)) return { ok: false, reason: 'PDF files containing scripts or embedded files are not accepted.' };
  }
  if (mime === MIME.CSV && hasFormulaCell(buf.toString('utf8'))) {
    // Formula-injection guard: staff may later open exports in spreadsheet software.
    return { ok: false, reason: 'CSV cells must not start with formula characters (=, +, @).' };
  }
  return { ok: true, mime };
}

/** True when any cell begins like a spreadsheet formula. Negative numbers ("-1,200.00") are allowed. */
export function hasFormulaCell(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    for (const raw of line.split(',')) {
      const cell = raw.trim().replace(/^"/, '');
      if (/^[=+@\t\r]/.test(cell) || /^-[^\d.\s]/.test(cell)) return true;
    }
  }
  return false;
}
