import { useRef, useState } from 'react';
import { Button, ErrorAlert, Status } from '../../../components/ui';
import { api, openDocument } from '../../../lib/api';
import { bytes, date } from '../../../lib/format';

export interface Doc { id: string; title: string; docType: string; status: string; mandatory: boolean; requirementKey: string | null; expiryDate: string | null; rejectionReason: string | null; current: null | { id: string; version: number; filename: string; size: number; mime: string; scan: string; uploadedAt: string } }

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.csv,.xlsx,.docx';

function UploadButton({ doc, onDone, disabled, highlight }: { doc: Doc; onDone: () => void; disabled?: boolean; highlight?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const canUpload = !disabled && doc.status !== 'VERIFIED';
  return (
    <div className="stack" style={{ ['--gap' as any]: '6px', alignItems: 'flex-end' }}>
      <input ref={ref} type="file" accept={ACCEPT} hidden aria-label={`Upload ${doc.title}`} onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        setBusy(true); setErr(null); setWarn(null);
        try { const r = await api.upload<any>(`/api/documents/${doc.id}/upload`, f); if (r.duplicateWarning) setWarn(r.duplicateWarning); onDone(); }
        catch (x) { setErr(x); } finally { setBusy(false); }
      }} />
      {canUpload && <Button size="sm" variant={highlight || doc.status === 'REQUIRED' || doc.status === 'REJECTED' ? 'primary' : undefined} loading={busy} onClick={() => ref.current?.click()}>{doc.current ? 'Replace' : 'Upload'}</Button>}
      {warn && <span className="xs muted">{warn}</span>}
      {err ? <div style={{ maxWidth: 320 }}><ErrorAlert error={err} /></div> : null}
    </div>
  );
}

export function DocumentList({ docs, onChange, readOnly, attentionKeys = [] }: { docs: Doc[]; onChange: () => void; readOnly?: boolean; attentionKeys?: string[] }) {
  if (!docs.length) return <p className="muted small">No documents are required yet.</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Document</th><th>Status</th><th>File</th><th className="num"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {docs.map((d) => {
            const attention = d.status === 'REJECTED' || d.status === 'EXPIRED' || (d.requirementKey ? attentionKeys.includes(d.requirementKey) : false);
            return (
              <tr key={d.id} style={attention ? { background: 'var(--warn-bg)' } : undefined}>
                <td>
                  <div className="primary-cell">{d.title}{d.mandatory ? <span className="req" aria-label="required">*</span> : <span className="xs muted"> (optional)</span>}</div>
                  {d.rejectionReason && <div className="small" style={{ color: 'var(--danger-700)' }}>Returned: {d.rejectionReason}</div>}
                  {attention && !d.rejectionReason && <div className="small" style={{ color: 'var(--warn-700)' }}>The Bank has asked you to look at this document.</div>}
                  {d.expiryDate && <div className="xs muted">Valid until {date(d.expiryDate)}</div>}
                </td>
                <td><Status value={d.status} />{d.current?.scan === 'PENDING' && <div className="xs muted">Security scan in progress</div>}</td>
                <td className="small">{d.current ? <><button className="btn ghost sm" onClick={() => openDocument(d.id)} disabled={d.current.scan !== 'CLEAN'}>{d.current.filename}</button><div className="xs muted">v{d.current.version} · {bytes(d.current.size)}</div></> : <span className="muted">Not uploaded</span>}</td>
                <td className="num">{!readOnly && <UploadButton doc={d} onDone={onChange} highlight={attention} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!readOnly && <p className="xs muted" style={{ padding: '8px 12px', margin: 0 }}>PDF, PNG or JPEG up to 20 MB unless stated. Files are encrypted and security-scanned on upload.</p>}
    </div>
  );
}
