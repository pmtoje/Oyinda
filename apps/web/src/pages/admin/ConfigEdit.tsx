import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, dateTime } from '../../lib/format';
import { Alert, Button, Drawer, ErrorAlert, KV, Loading, PageHeader, Panel, Status, Tabs, TextArea, TextInput, useAction } from '../../components/ui';
import { describeCondition, JsonEditor, PayloadDiff } from './parts/common';

/** Kinds the platform reads under one fixed key. */
const SINGLE_KEY_KINDS: Record<string, string> = { facility_efficiency_ratio: 'STANDARD' };
import { STRUCTURED } from './parts/editors';
import type { ConfigRow } from './ConfigList';

const CONDITION_KEYS = ['appliesWhen', 'passWhen', 'triggerWhen', 'when'];

function ConditionSummary({ payload }: { payload: any }) {
  const found: [string, unknown][] = [];
  const walk = (o: any, p: string) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (CONDITION_KEYS.includes(k)) found.push([`${p}${k}`, v]);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}${k}[${i}].`));
      else if (v && typeof v === 'object') walk(v, `${p}${k}.`);
    }
  };
  walk(payload, '');
  if (!found.length) return null;
  return <KV items={found.map(([k, c]) => [<span className="mono small">{k}</span>, <span className="small">{describeCondition(c)}</span>])} />;
}

export default function ConfigEdit() {
  const { id = 'new' } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const isNew = id === 'new';
  const item = useQuery({ queryKey: ['admin', 'config-item', id], queryFn: () => api.get<ConfigRow>(`/api/admin/config/${id}`), enabled: !isNew });
  const kind = isNew ? sp.get('kind') ?? '' : item.data?.kind ?? '';
  const key = isNew ? sp.get('key') ?? '' : item.data?.key ?? '';
  const history = useQuery({ queryKey: ['admin', 'config-history', kind, key], queryFn: () => api.get<ConfigRow[]>(`/api/admin/config?kind=${kind}&key=${encodeURIComponent(key)}`), enabled: !!kind && !!key });
  const kinds = useQuery({ queryKey: ['admin', 'config-kinds'], queryFn: () => api.get<{ kind: string; label: string }[]>('/api/admin/config/kinds') });
  const active = history.data?.find((r) => r.status === 'ACTIVE' && !r.effectiveTo) ?? history.data?.find((r) => r.status === 'ACTIVE');

  const editable = isNew || (item.data?.status === 'DRAFT' && item.data.createdById === me?.user?.id);
  const [payload, setPayload] = useState<any>(undefined);
  const [valid, setValid] = useState(true);
  const [title, setTitle] = useState('');
  const [newKey, setNewKey] = useState(SINGLE_KEY_KINDS[sp.get('kind') ?? ''] ?? '');
  const [reason, setReason] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [dialog, setDialog] = useState<null | 'reject' | 'deactivate'>(null);
  const [dialogReason, setDialogReason] = useState('');

  useEffect(() => {
    if (payload !== undefined) return;
    if (!isNew && item.data) { setPayload(item.data.payload); setTitle(item.data.title); setReason(item.data.changeReason); }
    else if (isNew && history.data !== undefined) { if (active) { setPayload(active.payload); setTitle(active.title); } else setPayload({}); }
    else if (isNew && !key) setPayload({});
  }, [isNew, item.data, history.data, active, key, payload]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const save = useAction(async () => {
    const r = await api.post<ConfigRow>('/api/admin/config', { kind, key: key || newKey, title, payload, changeReason: reason, effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined });
    await refresh(); nav(`/admin/config/${r.id}`, { replace: true });
  });
  const act = useAction(async (path: string, body?: unknown) => { await api.post(`/api/admin/config/${id}/${path}`, body ?? {}); setDialog(null); setDialogReason(''); await refresh(); });
  const discard = useAction(async () => { await api.del(`/api/admin/config/${id}`); await refresh(); nav(`/admin/config?kind=${kind}`); });

  const Structured = STRUCTURED[kind];
  const kindLabel = kinds.data?.find((k) => k.kind === kind)?.label ?? kind;
  const r = item.data;
  const iAmMaker = !!r && r.createdById === me?.user?.id;

  if (!isNew && item.isLoading) return <Loading rows={8} />;
  if (item.error) return <ErrorAlert error={item.error} />;
  if (isNew && !kind) return <Alert tone="warn" title="Choose a configuration type first"><Link to="/admin/config">Back to configuration</Link></Alert>;

  return (
    <>
      <PageHeader crumbs={<><Link to="/admin/config">Configuration</Link> / <Link to={`/admin/config?kind=${kind}`}>{kindLabel}</Link></>}
        title={isNew ? (key ? `New version of ${title || key}` : `New ${kindLabel.toLowerCase()} item`) : r!.title}
        sub={!isNew && <span className="row" style={{ ['--gap' as any]: '8px' }}><span className="mono small">{r!.key}</span><span>· v{r!.version}</span><Status value={r!.status} /></span>} />

      {!isNew && r && (
        <div className="stack" style={{ marginBottom: 16 }}>
          {r.status === 'DRAFT' && iAmMaker && <Alert tone="info" title="Draft">Only you can see and edit this draft. Submit it for approval when ready; another administrator must approve it before it takes effect.</Alert>}
          {r.status === 'PENDING_APPROVAL' && iAmMaker && <Alert tone="warn" title="Awaiting a second approver">You created this change. Maker-checker control requires another administrator to approve or reject it.</Alert>}
          {r.status === 'PENDING_APPROVAL' && !iAmMaker && <Alert tone="info" title="Review requested">{r.createdBy} submitted this change. Review the differences from the active version before approving.</Alert>}
          {r.status === 'REJECTED' && <Alert tone="danger" title="Rejected">{r.rejectedReason}</Alert>}
          {r.status === 'RETIRED' && <Alert tone="info" title="Retired version">This version is no longer in force but is retained: decisions taken under it continue to reference it.</Alert>}
        </div>
      )}

      <div className="workspace">
        <div className="stack">
          {editable ? (
            <Panel title="Definition" actions={Structured && <Tabs value={mode} onChange={(m) => setMode(m as any)} tabs={[{ key: 'form', label: 'Form' }, { key: 'json', label: 'JSON' }]} />}>
              <div className="stack">
                <div className="grid cols-2">
                  {isNew && !key && <TextInput label="Key" required hint="Unique identifier, e.g. FIPG_MIN_TURNOVER" value={newKey} onChange={(e) => setNewKey(e.target.value)} />}
                  <TextInput label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} />
                </div>
                {payload === undefined ? <Loading /> : Structured && mode === 'form'
                  ? <Structured value={payload} onChange={(v) => { setPayload(v); setValid(true); }} />
                  : <JsonEditor key={mode} value={payload} onChange={(v, ok) => { setPayload(v); setValid(ok); }} />}
              </div>
            </Panel>
          ) : (
            <Panel title="Definition" actions={Structured && <Tabs value={mode} onChange={(m) => setMode(m as any)} tabs={[{ key: 'form', label: 'Readable' }, { key: 'json', label: 'JSON' }]} />}>
              {Structured && mode === 'form' && r?.payload ? (
                // Read-only rendering of the structured editor: approved configuration is never edited in place.
                <fieldset disabled className="readonly-config" style={{ border: 0, padding: 0, margin: 0 }}><Structured value={r.payload} onChange={() => undefined} /></fieldset>
              ) : (
                <>
                  <ConditionSummary payload={r?.payload} />
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', background: 'var(--canvas)', padding: 12, borderRadius: 'var(--radius)', maxHeight: 520, overflow: 'auto', marginTop: 12 }}>{JSON.stringify(r?.payload, null, 2)}</pre>
                </>
              )}
            </Panel>
          )}
          <Panel title="Difference from the version in force">
            {r && active && r.id === active.id ? <p className="small muted">This is the version currently in force.</p> : <PayloadDiff before={active?.payload} after={editable ? payload : r?.payload} />}
          </Panel>
        </div>

        <aside className="action-rail">
          {editable && can('config.edit') && (
            <Panel title={isNew ? 'Save as draft' : 'Update draft'}>
              <div className="stack">
                <TextArea label="Change reason" required rows={3} hint="Recorded in the audit trail and shown to the approver (min. 10 characters)." value={reason} onChange={(e) => setReason(e.target.value)} />
                <TextInput label="Effective from (optional)" type="datetime-local" hint="Leave blank to take effect on approval." value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
                <ErrorAlert error={save.error} />
                {!isNew && <p className="small muted">Saving creates a new draft version; discard this draft first if you are replacing it.</p>}
                <Button variant="primary" loading={save.loading} disabled={!valid || reason.trim().length < 10 || !title || (isNew && !key && !newKey)} onClick={() => save.run()}>{isNew ? 'Save draft' : 'Save as new draft'}</Button>
              </div>
            </Panel>
          )}
          {!isNew && r && (
            <Panel title="Actions">
              <div className="stack" style={{ ['--gap' as any]: '8px' }}>
                <ErrorAlert error={act.error ?? discard.error} />
                {r.status === 'DRAFT' && iAmMaker && <Button variant="primary" loading={act.loading} onClick={() => act.run('submit')}>Submit for approval</Button>}
                {r.status === 'DRAFT' && iAmMaker && <Button variant="danger" loading={discard.loading} onClick={() => discard.run()}>Discard draft</Button>}
                {r.status === 'PENDING_APPROVAL' && can('config.approve') && !iAmMaker && <><Button variant="primary" loading={act.loading} onClick={() => act.run('approve')}>Approve</Button><Button variant="danger" onClick={() => setDialog('reject')}>Reject</Button></>}
                {r.status === 'ACTIVE' && can('config.approve') && <Button variant="danger" onClick={() => setDialog('deactivate')}>Deactivate</Button>}
                {r.status === 'ACTIVE' && can('config.edit') && <Button onClick={() => nav(`/admin/config/new?kind=${r.kind}&key=${encodeURIComponent(r.key)}`)}>Create new version</Button>}
                {r.status === 'PENDING_APPROVAL' && iAmMaker && <p className="small muted">You cannot approve your own change.</p>}
              </div>
            </Panel>
          )}
          {!isNew && r && (
            <Panel title="Record">
              <KV items={[['Maker', r.createdBy ?? 'System baseline'], ['Created', dateTime(r.createdAt)], ['Checker', r.approvedBy ?? '—'], ['Approved', dateTime(r.approvedAt)], ['Effective from', dateTime(r.effectiveFrom)], ['Effective to', r.effectiveTo ? dateTime(r.effectiveTo) : r.status === 'ACTIVE' ? 'Open-ended' : '—'], ['Reason', r.changeReason]]} />
            </Panel>
          )}
          {!!history.data?.length && (
            <Panel title="Version history" flush>
              <ul className="flag-list" style={{ padding: '0 16px' }}>
                {history.data.map((h) => (
                  <li key={h.id}><div className="row between"><Link to={`/admin/config/${h.id}`} aria-current={h.id === id ? 'page' : undefined} style={{ fontWeight: h.id === id ? 600 : 400 }}>v{h.version}</Link><Status value={h.status} /></div>
                    <div className="xs muted">{h.effectiveFrom ? date(h.effectiveFrom) : 'not yet effective'} · {h.createdBy ?? 'System'}</div></li>
                ))}
              </ul>
            </Panel>
          )}
        </aside>
      </div>

      {dialog && (
        <Drawer center title={dialog === 'reject' ? 'Reject change' : 'Deactivate configuration'} onClose={() => setDialog(null)}
          footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" loading={act.loading} disabled={dialogReason.trim().length < 5} onClick={() => act.run(dialog, { reason: dialogReason })}>{dialog === 'reject' ? 'Reject' : 'Deactivate'}</Button></>}>
          <div className="stack">
            {dialog === 'deactivate' && <Alert tone="warn">Deactivating ends this version now. Workflows or rules that depend on it may stop with a "configuration missing" message until a replacement is approved.</Alert>}
            <TextArea label="Reason" required rows={3} value={dialogReason} onChange={(e) => setDialogReason(e.target.value)} />
            <ErrorAlert error={act.error} />
          </div>
        </Drawer>
      )}
    </>
  );
}
