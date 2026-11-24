import { beforeAll, describe, expect, it } from 'vitest';
import { abcClient, Client, completeKanoProfile, db, draftMurabaha, getApp, kanoClient, staffLogin, uploadAllRequired } from './helpers.js';
import { q } from '../src/db/pool.js';
import { compareNames, outcomeOf } from '../src/modules/identity/verification.js';

/**
 * Promoter BVN + NIN verification (Credit360 prompt §13), against the SANDBOX provider and the mock core-banking
 * person records. Covers every explicit state, comparisons, review maker-checker, the submission gate and the
 * information-security rules.
 */
let app: Awaited<ReturnType<typeof getApp>>;
let kano: Client; let customerId: string;
let kyc: Client, kyc2: Client, analyst: Client;


const overview = async () => (await kano.get(`/api/customers/${customerId}/identity`)).body.data;
const person = async (name: string) => (await overview()).people.find((p: any) => p.name === name);
async function addDirector(fullName: string) {
  const r = await kano.post(`/api/customers/${customerId}/parties`, { partyType: 'DIRECTOR', fullName: `${fullName}`, designation: 'Director' });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}
const verify = (partyId: string, body: Record<string, unknown>) => kano.post(`/api/customers/${customerId}/parties/${partyId}/identity/verify`, { consent: true, ...body });

beforeAll(async () => {
  app = await getApp();
  kano = await kanoClient(app);
  customerId = (await kano.get('/api/auth/me')).body.data.customer.id;
  await completeKanoProfile(kano, customerId); // verifies Hauwa Garba (director and 100% shareholder)
  kyc = await staffLogin(app, 'demo.kyc');
  kyc2 = await staffLogin(app, 'demo.kyc2');
  analyst = await staffLogin(app, 'demo.analyst');
});

describe('matching rules (pure)', () => {
  it('compares names regardless of order, titles and accents; a missing middle name is partial', () => {
    expect(compareNames('Hauwa Garba', 'GARBA, Hauwa')).toBe('MATCH');
    expect(compareNames('Hon. Tobiloba Ajayi', 'Tobiloba Ajayi')).toBe('MATCH');
    expect(compareNames('Tobiloba Femi Ajayi', 'Tobiloba Ajayi')).toBe('PARTIAL');
    expect(compareNames('Tobiloba Ajayi', 'Tobi Ajayi')).toBe('MISMATCH');
    expect(compareNames('Ifeómá Chukwu', 'Ifeoma Chukwu')).toBe('MATCH');
  });
  it('needs a matching date of birth to verify; otherwise review', () => {
    const p = { acceptPartialNameWhenDobMatches: true };
    expect(outcomeOf([{ attribute: 'fullName', against: 'PROVIDED', result: 'MATCH' }, { attribute: 'dateOfBirth', against: 'PROVIDED', result: 'MATCH' }], p)).toBe('VERIFIED');
    expect(outcomeOf([{ attribute: 'fullName', against: 'PROVIDED', result: 'MATCH' }, { attribute: 'dateOfBirth', against: 'PROVIDED', result: 'NOT_AVAILABLE' }], p)).toBe('REVIEW_REQUIRED');
    expect(outcomeOf([{ attribute: 'fullName', against: 'PROVIDED', result: 'PARTIAL' }, { attribute: 'dateOfBirth', against: 'PROVIDED', result: 'MATCH' }], { acceptPartialNameWhenDobMatches: false })).toBe('DISCREPANCY');
    expect(outcomeOf([{ attribute: 'fullName', against: 'PROVIDED', result: 'MATCH' }, { attribute: 'dateOfBirth', against: 'BANK_RECORD', result: 'MISMATCH' }], p)).toBe('DISCREPANCY');
  });
});

describe('verification states through the API', () => {
  it('VERIFIED: sandbox BVN and NIN match; recorded as SANDBOX, never as a live check; the same person in a second role reuses the result', async () => {
    const h = await person('Hauwa Garba');
    expect(h.state).toBe('VERIFIED');
    expect(h.checks.map((c: any) => c.source)).toEqual(['SANDBOX', 'SANDBOX']);
    const rows = await q<any>(db(), `SELECT kind, method, provider_mode, status FROM identity_verification WHERE customer_id=$1 ORDER BY created_at`, [customerId]);
    expect(rows.every((r) => r.provider_mode === 'SANDBOX')).toBe(true);
    expect(rows.map((r) => r.method)).toEqual(expect.arrayContaining(['PROVIDER', 'REUSED']));
  });

  it('responses, audit entries and stored rows never contain the full identifiers', async () => {
    const raw = JSON.stringify(await overview());
    for (const id of ['22287654321', '10087654321']) expect(raw).not.toContain(id);
    expect(raw).toContain('4321');
    const audits = await q<any>(db(), `SELECT action, COALESCE(metadata::text,'') AS m, COALESCE(after_data::text,'') || COALESCE(before_data::text,'') AS a FROM audit_log WHERE customer_id=$1 AND action LIKE 'IDENTITY%'`, [customerId]);
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) for (const id of ['22287654321', '10087654321']) expect(`${a.m}${a.a}`).not.toContain(id);
    const party = (await q<any>(db(), `SELECT bvn_enc, nin_hash FROM business_party WHERE customer_id=$1 AND full_name='Hauwa Garba' LIMIT 1`, [customerId]))[0];
    expect(party.bvn_enc).toMatch(/^v1\./);
    expect(party.nin_hash).not.toContain('10087654321');
    // Format errors do not echo the value
    const bad = await verify((await person('Hauwa Garba')).partyId, { bvn: '12345', nin: '10087654321', dateOfBirth: '1981-11-02' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('12345');
  });

  it('consent is required before any check', async () => {
    const id = (await person('Hauwa Garba')).partyId;
    const r = await kano.post(`/api/customers/${customerId}/parties/${id}/identity/verify`, { bvn: '22287654321', nin: '10087654321', dateOfBirth: '1981-11-02' });
    expect(r.status).toBe(400);
  });

  it('UNSUCCESSFUL when the provider does not know the identifier; PROVIDER_UNAVAILABLE on an outage, then recoverable', async () => {
    const id = await addDirector('Tobiloba Femi Ajayi');
    const nf = await verify(id, { bvn: '22200011122', nin: '10000011122', dateOfBirth: '1972-07-14' });
    expect(nf.body.data.state).toBe('UNSUCCESSFUL');
    const out = await verify(id, { bvn: '22299999999', nin: '10066677788', dateOfBirth: '1972-07-14' });
    expect(out.body.data.state).toBe('PROVIDER_UNAVAILABLE');
    // Partial name (middle name absent from the record) with matching date of birth is accepted by policy
    const okr = await verify(id, { bvn: '22266677788', nin: '10066677788', dateOfBirth: '1972-07-14' });
    expect(okr.body.data.state).toBe('VERIFIED');
    expect(okr.body.data.checks[0].results).toEqual(expect.arrayContaining([{ attribute: 'fullName', against: 'PROVIDED', result: 'PARTIAL' }]));
  });

  it('DISCREPANCY when the Bank’s own record disagrees with the BVN record', async () => {
    const id = await addDirector('Bello Musa');
    const r = await verify(id, { bvn: '22255566677', nin: '10055566677', dateOfBirth: '1968-01-30' });
    expect(r.body.data.state).toBe('DISCREPANCY');
    const p = await person('Bello Musa');
    expect(p.checks.find((c: any) => c.kind === 'BVN').bankRecord).toBe('MISMATCH');
    expect(p.canRequestReview).toBe(true);
    await kano.del(`/api/customers/${customerId}/parties/${id}`);
  });

  it('the same identifier cannot be verified for a different person in the business', async () => {
    const id = await addDirector('Musa Danladi');
    const r = await verify(id, { bvn: '22287654321', nin: '10087654321', dateOfBirth: '1981-11-02' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IDENTIFIER_IN_USE');
    await kano.del(`/api/customers/${customerId}/parties/${id}`);
  });

  it('checks per person per day are limited', async () => {
    const id = await addDirector('Limit Tester');
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await verify(id, { bvn: '22200011133', nin: '10000011133', dateOfBirth: '1980-01-01' })).status);
    expect(codes).toContain(429);
    await kano.del(`/api/customers/${customerId}/parties/${id}`);
  });
});

describe('discrepancy review (maker-checker) and the submission gate', () => {
  let ifeoma: string; let facilityId: string;

  it('a promoter whose BVN and NIN records disagree blocks submission', async () => {
    ifeoma = await addDirector('Ifeoma Chukwu');
    const r = await verify(ifeoma, { bvn: '22244455566', nin: '10044455566', dateOfBirth: '1990-04-04' });
    expect(r.body.data.state).toBe('DISCREPANCY');
    const nin = r.body.data.checks.find((c: any) => c.kind === 'NIN');
    expect(nin.results).toEqual(expect.arrayContaining([{ attribute: 'dateOfBirth', against: 'BVN_RECORD', result: 'MISMATCH' }]));
    const f = await draftMurabaha(kano);
    facilityId = f.id;
    await uploadAllRequired(kano, f.id);
    const cur = (await kano.get(`/api/facilities/${f.id}`)).body.data.facility;
    const sub = await kano.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true });
    expect(sub.body.error.code).toBe('INCOMPLETE');
    expect(sub.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'IDENTITY', message: 'Verify the identity of Ifeoma Chukwu.' })]));
  });

  it('the customer asks for a review; only KYC officers see it; the proposer cannot also approve', async () => {
    const rq = await kano.post(`/api/customers/${customerId}/parties/${ifeoma}/identity/review`, { note: 'Her NIN enrolment recorded the wrong birth year; correction in progress.' });
    expect(rq.status).toBe(201);
    expect((await person('Ifeoma Chukwu')).state).toBe('REVIEW_REQUIRED');
    expect((await analyst.get('/api/identity-reviews')).status).toBe(403);
    const list = (await kyc.get('/api/identity-reviews')).body.data;
    const item = list.find((x: any) => x.person === 'Ifeoma Chukwu');
    expect(item.status).toBe('OPEN');
    const detail = (await kyc.get(`/api/identity-reviews/${item.id}`)).body.data;
    expect(detail.person.bvn).toBe('•••••••5566');
    expect(JSON.stringify(detail)).not.toContain('22244455566');
    // Revealing the provider record is audited
    const rev = (await kyc.post(`/api/identity-reviews/${item.id}/reveal`)).body.data;
    expect(rev.find((x: any) => x.kind === 'NIN').record.dateOfBirth).toBe('1991-04-04');
    expect((await q(db(), `SELECT 1 FROM audit_log WHERE action='IDENTITY_RECORD_VIEWED' AND entity_id=$1`, [item.id])).length).toBe(1);
    expect((await kyc.post(`/api/identity-reviews/${item.id}/propose`, { proposal: 'CLEAR', reason: 'short' })).status).toBe(400);
    expect((await kyc.post(`/api/identity-reviews/${item.id}/propose`, { proposal: 'CLEAR', reason: 'NIMC correction slip seen; BVN date of birth agrees with passport.' })).status).toBe(200);
    const same = await kyc.post(`/api/identity-reviews/${item.id}/decide`, { decision: 'APPROVE', reason: 'Approving my own proposal' });
    expect(same.body.error.code).toBe('SAME_PERSON');
    expect((await kyc2.post(`/api/identity-reviews/${item.id}/decide`, { decision: 'APPROVE', reason: 'Evidence reviewed; agree to clear the discrepancy.' })).status).toBe(200);
    expect((await person('Ifeoma Chukwu')).state).toBe('VERIFIED');
  });

  it('once every required promoter is verified, the request can be submitted', async () => {
    const cur = (await kano.get(`/api/facilities/${facilityId}`)).body.data.facility;
    expect((await kano.post(`/api/facilities/${facilityId}/submit`, { rowVersion: cur.rowVersion, declaration: true })).status).toBe(200);
  });

  it('changing a verified person’s name makes the result stale until checked again', async () => {
    const h = await person('Hauwa Garba');
    await kano.put(`/api/customers/${customerId}/parties/${h.partyId}`, { partyType: 'DIRECTOR', fullName: 'Hauwa Amina Garba', designation: 'Managing Director' });
    expect((await person('Hauwa Amina Garba')).state).toBe('NOT_STARTED');
    const r = await verify(h.partyId, { nin: '10087654321', dateOfBirth: '1981-11-02' });
    expect(r.body.data.state).toBe('VERIFIED'); // partial name (record has no middle name) with matching date of birth
  });

  it('another business cannot read or act on these promoters', async () => {
    const abc = await abcClient(app);
    expect((await abc.get(`/api/customers/${customerId}/identity`)).status).toBe(404);
    const h = await person('Hauwa Amina Garba');
    expect((await abc.post(`/api/customers/${customerId}/parties/${h.partyId}/identity/verify`, { bvn: '22287654321', nin: '10087654321', dateOfBirth: '1981-11-02', consent: true })).status).toBe(404);
  });
});
