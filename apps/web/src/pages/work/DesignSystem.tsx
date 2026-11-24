import { useEffect, useState } from 'react';
import { Alert, Button, Check, Drawer, Empty, KV, Loading, MoneyInput, PageHeader, Panel, SelectInput, Status, Tabs, TextArea, TextInput } from '../../components/ui';
import { Bars } from '../admin/parts/filters';
import { SlaBadge } from './parts/common';
import { money } from '../../lib/format';
import { ThemeSwitch } from '../../lib/theme';

/**
 * Credit360 design system — a living catalogue rendered from the real components and tokens, in whichever theme is
 * active. Nothing here is a mock-up: change a component or token and this page changes with it. Used for design
 * review and by the visual test suite (both themes, every width, open drawer and dialog).
 */
const SEMANTIC = ['--bg', '--surface', '--surface-muted', '--surface-selected', '--text', '--text-2', '--text-3', '--text-4', '--border', '--border-strong', '--link', '--accent', '--action', '--chrome',
  '--ok', '--ok-bg', '--warn', '--warn-bg', '--danger', '--danger-bg', '--info', '--info-bg', '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];
const STATUSES = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'OFFER_ISSUED', 'ACTIVE', 'DECLINED', 'VERIFIED', 'WARNING', 'BREACHED'];
const LOGOS: [string, string, boolean][] = [
  ['credit360-primary.svg', 'Primary lockup', false], ['credit360-primary-on-dark.svg', 'Primary lockup — dark backgrounds', true],
  ['credit360-compact.svg', 'Compact lockup', false], ['credit360-compact-on-dark.svg', 'Compact lockup — dark backgrounds', true],
  ['credit360-symbol.svg', 'Symbol', false], ['credit360-symbol-on-dark.svg', 'Symbol — dark backgrounds', true],
];

function Swatches() {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const read = () => { const cs = getComputedStyle(document.documentElement); setValues(Object.fromEntries(SEMANTIC.map((t) => [t, cs.getPropertyValue(t).trim()]))); };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return (
    <div className="ds-swatches">
      {SEMANTIC.map((t) => (
        <div key={t} className="ds-swatch">
          <span className="ds-chip" style={{ background: `var(${t})` }} aria-hidden />
          <span className="mono xs">{t}</span>
          <span className="mono xs muted">{values[t] ?? ''}</span>
        </div>
      ))}
    </div>
  );
}

export default function DesignSystem() {
  const [tab, setTab] = useState('overview');
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <PageHeader eyebrow="Credit360 by AltBank" title="Design system" sub="Every component and token, rendered live in the current theme. Switch themes to review both." actions={<ThemeSwitch />} />
      <div className="stack">
        <Panel title="Logo system">
          <div className="ds-logos">
            {LOGOS.map(([f, name, dark]) => (
              <figure key={f} className={`ds-logo ${dark ? 'on-dark' : 'on-light'}`}>
                <img src={`/brand/${f}`} alt={name} />
                <figcaption className="xs">{name}</figcaption>
              </figure>
            ))}
            <figure className="ds-logo on-light">
              <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>{[64, 48, 32, 16].map((s) => <img key={s} src="/brand/credit360-app-icon.svg" alt={`App icon at ${s} pixels`} style={{ width: s, height: s }} />)}</div>
              <figcaption className="xs">App icon — 64, 48, 32, 16 px</figcaption>
            </figure>
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>Clear space: at least the sparkle’s height on every side. Rules and provenance: docs/brand/README.md.</p>
        </Panel>

        <Panel title="Colour tokens (current theme)"><Swatches /></Panel>

        <Panel title="Typography">
          <div className="stack ds-type">
            <div className="ds-display">Corporate financing, structured the non-interest way.</div>
            <h1>Page title — Your financing journey</h1>
            <h2>Section title — Credit analysis</h2>
            <h3>Panel title — Your business on the Bank’s records</h3>
            <h4>Group label — Shariah structure</h4>
            <p>Body text explains what to do next in plain language. Financial values use tabular figures: {['₦950,000.00', '₦15,750,000.00', '₦1,500,000,000.00', '₦25,000,000,000.50'].map((v, i) => <span key={v}>{i ? ' · ' : ''}<span className="num">{v}</span></span>)}</p>
            <p className="small muted">Supporting text and hints. <a href="#top">Links are gold-brown for contrast</a>.</p>
            <p className="xs muted">Legal and disclosure text: The Alternative Bank Limited is licensed by the Central Bank of Nigeria as a non-interest bank.</p>
          </div>
        </Panel>

        <Panel title="Buttons">
          <div className="ds-row">
            <Button variant="primary">Primary action</Button><Button>Secondary</Button><Button variant="ghost">Ghost</Button><Button variant="danger">Destructive</Button>
            <Button variant="primary" loading>Saving</Button><Button variant="primary" disabled>Disabled</Button><Button size="sm">Small</Button><Button variant="primary" size="lg">Large</Button>
          </div>
          <p className="xs muted" style={{ marginTop: 8 }}>Hover and keyboard focus are live: tab through this page to see the focus ring.</p>
        </Panel>

        <Panel title="Form fields">
          <div className="grid cols-2">
            <TextArea label="Business name" rows={1} className="textarea autosize" defaultValue="ABC Manufacturing, Packaging, Plastics & Allied Industrial Products Holdings Nigeria Limited" hint="Long values wrap instead of being cut off. As registered with the CAC." />
            <TextInput label="Account number" required error="Enter the 10-digit account number." defaultValue="01000" />
            <MoneyInput label="Facility amount" defaultValue="25,000,000,000.50" />
            <SelectInput label="Payment frequency" options={[{ value: 'MONTHLY', label: 'Monthly' }, { value: 'QUARTERLY', label: 'Quarterly' }, { value: 'BULLET', label: 'Bullet (at maturity)' }]} defaultValue="MONTHLY" />
            <TextInput label="Disabled field" disabled defaultValue="Taken from core banking" />
            <TextArea label="Purpose of the facility" defaultValue="Purchase of PET resin for bottle production across the Lagos, Ogun, Kano and Abuja plants." />
          </div>
          <div style={{ marginTop: 12 }}><Check label="I confirm that the information in this request is true and complete." defaultChecked /></div>
        </Panel>

        <Panel title="Status and feedback">
          <div className="ds-row">{STATUSES.map((s) => <Status key={s} value={s} />)}<span className="tag mock">SANDBOX</span><span className="tag mock">MOCK</span></div>
          <div className="ds-row" style={{ marginTop: 12 }}>
            <SlaBadge sla={{ state: 'ON_TRACK', remainingMs: 26 * 3600e3 }} /><SlaBadge sla={{ state: 'WARNING', remainingMs: 40 * 60e3 }} /><SlaBadge sla={{ state: 'BREACHED', remainingMs: -3 * 3600e3, escalationLevel: 1 }} />
          </div>
          <div className="stack" style={{ marginTop: 12 }}>
            <Alert tone="info" title="What happens next">Your relationship manager reviews the request within 12 working hours.</Alert>
            <Alert tone="ok" title="All sections are complete." />
            <Alert tone="warn" title="Before you submit"><ul><li>Documents: Board Resolution is required.</li></ul></Alert>
            <Alert tone="danger" title="Upload failed">board-resolution.pdf is 24.6 MB; the limit is 20 MB. Try scanning at a lower resolution.</Alert>
          </div>
        </Panel>

        <Panel title="Data display">
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <div className="metric"><div className="label">Approved value</div><div className="value">{money(2500000000050, 'NGN')}</div><div className="sub">Largest single request</div></div>
            <div className="metric"><div className="label">SLA compliance</div><div className="value">96.4%</div><div className="sub">3 breaches across 84 tasks</div></div>
            <div className="metric metric-alert"><div className="label">SLA breached</div><div className="value">3</div><div className="sub">Needs attention</div></div>
          </div>
          <div className="grid cols-2">
            <KV items={[['Facility', 'Murabaha'], ['Amount', money(15_750_000_00, 'NGN')], ['Tenor', '24 months'], ['Reference', <span key="r" className="mono">GZ-FAC-2026-000004</span>]]} />
            <Bars rows={[{ l: 'Manufacturing', n: 12, a: 4_250_000_000_00 }, { l: 'Agriculture & Agro-allied', n: 7, a: 950_000_000_00 }, { l: 'Renewable Energy', n: 3, a: 1_500_000_000_00 }]} label={(r) => r.l} value={(r) => r.n} format={(v, r) => `${v} · ${money(r.a, 'NGN', { compact: true })}`} />
          </div>
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="data"><thead><tr><th>Reference</th><th>Customer</th><th>Stage</th><th className="num">Amount</th></tr></thead>
              <tbody>
                <tr><td className="mono">GZ-FAC-2026-000001</td><td>ABC Manufacturing Ltd</td><td>Credit analysis</td><td className="num">{money(25_000_000_000_50, 'NGN')}</td></tr>
                <tr><td className="mono">GZ-FAC-2026-000003</td><td>Kano Agro-Allied Processing Ltd</td><td>Documentation &amp; conditions</td><td className="num">{money(950_000_00, 'NGN')}</td></tr>
              </tbody></table>
          </div>
        </Panel>

        <Panel title="Navigation and progress">
          <Tabs tabs={[{ key: 'overview', label: 'Overview' }, { key: 'documents', label: 'Documents', flag: true }, { key: 'messages', label: 'Messages' }]} value={tab} onChange={setTab} />
          <ol className="stepper" style={{ marginTop: 16 }}>
            <li className="done"><button>Verify identity</button></li><li className="done"><button>Facility details</button></li><li className="current" aria-current="step"><button>Documents</button></li><li><button>Review &amp; submit</button></li>
          </ol>
        </Panel>

        <div className="grid cols-2">
          <Panel title="Empty state"><Empty title="The queue is clear">New tasks appear here when they are assigned to you.</Empty></Panel>
          <Panel title="Loading state"><Loading rows={3} /></Panel>
        </div>

        <Panel title="Overlays">
          <div className="ds-row"><Button onClick={() => setDrawer(true)}>Open drawer</Button><Button onClick={() => setDialog(true)}>Open dialog</Button></div>
        </Panel>
      </div>

      {drawer && (
        <Drawer title="Invite a colleague" onClose={() => setDrawer(false)} footer={<><Button onClick={() => setDrawer(false)}>Cancel</Button><Button variant="primary">Send invitation</Button></>}>
          <div className="stack">
            <TextInput label="Full name" defaultValue="Musa Danladi" />
            <TextInput label="Work e-mail" defaultValue="musa@abc-manufacturing.demo" hint="Their sign-in username." />
            <Alert tone="info">Your colleague verifies their own mobile number and sets a password.</Alert>
          </div>
        </Drawer>
      )}
      {dialog && (
        <Drawer center title="Confirm acceptance" onClose={() => setDialog(false)} footer={<><Button variant="ghost" onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary">Confirm acceptance</Button></>}>
          <p>You are accepting the Advance Payment Guarantee of {money(1_500_000_000_00, 'NGN')} on the terms in the offer letter. The Bank’s Legal, Shariah and Credit Operations teams then complete documentation.</p>
        </Drawer>
      )}
    </>
  );
}
