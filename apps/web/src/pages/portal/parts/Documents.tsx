import { useEffect, useRef, useState } from 'react';
import { Button, Drawer, ErrorAlert, Status } from '../../../components/ui';
import { openDocument, uploadWithProgress } from '../../../lib/api';
import { bytes, date } from '../../../lib/format';

export interface Doc { id: string; title: string; docType: string; status: string; mandatory: boolean; requirementKey: string | null; expiryDate: string | null; rejectionReason: string | null; current: null | { id: string; version: number; filename: string; size: number; mime: string; scan: string; uploadedAt: string } }

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.csv,.xlsx,.docx';
const ALLOWED = /\.(pdf|png|jpe?g|csv|xlsx|docx)$/i;
const MAX_MB = 20;

/** Checks the Bank also enforces on the server, done first here so the customer gets an answer instantly. */
function checkFile(f: File): string | null {
  if (!ALLOWED.test(f.name)) return `${f.name} is not an accepted file type. Use PDF, PNG, JPEG, CSV, Excel (.xlsx) or Word (.docx).`;
  if (f.size === 0) return `${f.name} is empty.`;
  if (f.size > MAX_MB * 1024 * 1024) return `${f.name} is ${bytes(f.size)}; the limit is ${MAX_MB} MB. Try scanning at a lower resolution or splitting the file.`;
  return null;
}

/** Preview of the chosen file before it leaves the device; confirm to upload, with real progress. */
function UploadDialog({ doc, file, onClose, onDone }: { doc: Doc; file: File; onClose: () => void; onDone: (warning?: string) => void }) {
  const [url] = useState(() => URL.createObjectURL(file));
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const isImage = /^image\//.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const upload = async () => {
    setErr(null); setProgress(0);
    try { const r = await uploadWithProgress<any>(`/api/documents/${doc.id}/upload`, file, setProgress); onDone(r?.duplicateWarning); }
    catch (x) { setErr(x); setProgress(null); }
  };
  const busy = progress !== null;
  return (
    <Drawer center title={`Upload ${doc.title}`} onClose={busy ? () => undefined : onClose} footer={
      <div className="row between" style={{ width: '100%' }}>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Choose another file</Button>
        <Button variant="primary" onClick={() => void upload()} loading={busy}>Upload</Button>
      </div>}>
      <div className="stack">
        <div className="upload-file"><strong className="upload-name">{file.name}</strong><span className="small muted">{bytes(file.size)}</span></div>
        <div className="upload-preview">
          {isImage ? <img src={url} alt={`Preview of ${file.name}`} /> : isPdf ? <iframe src={url} title={`Preview of ${file.name}`} /> : <p className="small muted">No preview for this file type. Check the name before uploading.</p>}
        </div>
        {busy && (
          <div className="upload-progress" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
            <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          </div>
        )}
        {busy && <p className="small muted" role="status">{(progress ?? 0) < 1 ? `Uploading… ${Math.round((progress ?? 0) * 100)}%` : 'Securing and scanning…'}</p>}
        <ErrorAlert error={err} />
        <p className="xs muted">The file is encrypted and checked for malware before anyone at the Bank can open it.</p>
      </div>
    </Drawer>
  );
}

function useUploadFlow(doc: Doc, onChange: () => void) {
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const pick = (f: File | undefined | null) => {
    if (!f) return;
    const p = checkFile(f); setProblem(p); setWarn(null);
    if (!p) setFile(f);
  };
  const dialog = file && <UploadDialog doc={doc} file={file} onClose={() => setFile(null)} onDone={(w) => { setFile(null); setWarn(w ?? null); onChange(); }} />;
  return { pick, problem, warn, dialog };
}

function UploadButton({ doc, flow, disabled, highlight }: { doc: Doc; flow: ReturnType<typeof useUploadFlow>; disabled?: boolean; highlight?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const canUpload = !disabled && doc.status !== 'VERIFIED';
  return (
    <div className="stack" style={{ ['--gap' as any]: '6px', alignItems: 'flex-end' }}>
      <input ref={ref} type="file" accept={ACCEPT} hidden aria-label={`Upload ${doc.title}`} onChange={(e) => { flow.pick(e.target.files?.[0]); e.target.value = ''; }} />
      {canUpload && <Button size="sm" variant={highlight || doc.status === 'REQUIRED' || doc.status === 'REJECTED' ? 'primary' : undefined} onClick={() => ref.current?.click()}>{doc.current ? 'Replace' : 'Upload'}</Button>}
      {canUpload && <span className="xs muted drop-hint">or drop a file on this row</span>}
      {flow.warn && <span className="xs muted">{flow.warn}</span>}
      {flow.problem && <span className="xs" role="alert" style={{ color: 'var(--danger-text)', maxWidth: 260, textAlign: 'right' }}>{flow.problem}</span>}
      {flow.dialog}
    </div>
  );
}

/** One document row: the whole row accepts a dropped file (mouse and trackpad); the button covers keyboard and mobile. */
function DocRow({ d, onChange, readOnly, attention }: { d: Doc; onChange: () => void; readOnly?: boolean; attention: boolean }) {
  const flow = useUploadFlow(d, onChange);
  const [over, setOver] = useState(false);
  const droppable = !readOnly && d.status !== 'VERIFIED';
  return (
    <tr className={`${over ? 'drop-active' : ''}`} style={attention && !over ? { background: 'var(--warn-bg)' } : undefined}
      onDragOver={droppable ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); } : undefined}
      onDragLeave={droppable ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); } : undefined}
      onDrop={droppable ? (e) => { e.preventDefault(); setOver(false); flow.pick(e.dataTransfer.files?.[0]); } : undefined}>
      <td>
        <div className="primary-cell">{d.title}{d.mandatory ? <span className="req" aria-label="required">*</span> : <span className="xs muted"> (optional)</span>}</div>
        {over && <div className="small drop-label">Drop to upload {d.title}</div>}
        {d.rejectionReason && <div className="small" style={{ color: 'var(--danger-700)' }}>Returned: {d.rejectionReason}</div>}
        {attention && !d.rejectionReason && <div className="small" style={{ color: 'var(--warn-700)' }}>The Bank has asked you to look at this document.</div>}
        {d.expiryDate && <div className="xs muted">Valid until {date(d.expiryDate)}</div>}
      </td>
      <td><Status value={d.status} />{d.current?.scan === 'PENDING' && <div className="xs muted">Security scan in progress</div>}</td>
      <td className="small">{d.current ? <><button className="btn ghost sm" onClick={() => openDocument(d.id)} disabled={d.current.scan !== 'CLEAN'}>{d.current.filename}</button><div className="xs muted">v{d.current.version} · {bytes(d.current.size)}</div></> : <span className="muted">Not uploaded</span>}</td>
      <td className="num">{!readOnly && <UploadButton doc={d} flow={flow} highlight={attention} />}</td>
    </tr>
  );
}

export function DocumentList({ docs, onChange, readOnly, attentionKeys = [] }: { docs: Doc[]; onChange: () => void; readOnly?: boolean; attentionKeys?: string[] }) {
  if (!docs.length) return <p className="muted small">No documents are required yet.</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Document</th><th>Status</th><th>File</th><th className="num"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {docs.map((d) => <DocRow key={d.id} d={d} onChange={onChange} readOnly={readOnly} attention={d.status === 'REJECTED' || d.status === 'EXPIRED' || (d.requirementKey ? attentionKeys.includes(d.requirementKey) : false)} />)}
        </tbody>
      </table>
      {!readOnly && <p className="xs muted" style={{ padding: '8px 12px', margin: 0 }}>Drop a file on a row or use Upload. PDF, PNG or JPEG up to 20 MB unless stated; you’ll see a preview before anything is sent. Files are encrypted and security-scanned.</p>}
    </div>
  );
}
