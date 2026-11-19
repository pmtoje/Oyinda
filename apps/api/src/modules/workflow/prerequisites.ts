import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';

const LABEL: Record<string, string> = {
  BUREAU: 'Credit bureau checks completed for the business',
  EXPOSURE: 'Aggregate exposure computed',
  FINANCIAL_ANALYSIS: 'Financial analysis run',
  STATEMENT_ANALYSIS: 'Bank statement analysis run',
  COLLATERAL: 'Collateral recorded',
  RISK_RATING: 'Combined risk rating submitted',
  RARORAC: 'RARORAC computed (and any pricing exception justified)',
  CREDIT_MEMO: 'Credit memo generated',
  ES_ASSESSMENT: 'E&S assessment submitted',
  CONDITIONS_LEGAL: 'All mandatory Legal conditions satisfied or waived',
  CONDITIONS_SHARIAH: 'All mandatory Shariah conditions satisfied or waived',
  CONDITIONS_ALL_MANDATORY: 'All mandatory conditions precedent satisfied or waived',
  DOCUMENTS_VERIFIED: 'All mandatory documents reviewed (verified or rejected)',
};

async function check(db: Db, code: string, facilityId: string): Promise<boolean> {
  const exists = async (sql: string) => !!(await maybe(db, sql, [facilityId]));
  switch (code) {
    case 'BUREAU': return exists(`SELECT 1 FROM bureau_check WHERE facility_id=$1 AND subject_kind='BUSINESS' AND status IN ('COMPLETED','NO_HIT')`);
    case 'EXPOSURE': return exists('SELECT 1 FROM exposure_snapshot WHERE facility_id=$1');
    case 'FINANCIAL_ANALYSIS': return exists('SELECT 1 FROM financial_analysis WHERE facility_id=$1');
    case 'STATEMENT_ANALYSIS': return exists('SELECT 1 FROM statement_analysis WHERE facility_id=$1');
    case 'COLLATERAL': {
      const f = await one<any>(db, `SELECT ci.payload->>'category' AS category FROM facility_request f JOIN config_item ci ON ci.id=f.product_config_id WHERE f.id=$1`, [facilityId]);
      return f.category === 'INVESTMENT' || exists('SELECT 1 FROM collateral WHERE facility_id=$1 AND deleted_at IS NULL');
    }
    case 'RISK_RATING': return exists(`SELECT 1 FROM risk_assessment WHERE facility_id=$1 AND kind='COMBINED' AND status='SUBMITTED'`);
    case 'RARORAC': return exists(`SELECT 1 FROM rarorac_computation WHERE facility_id=$1 AND status='COMPLETED' AND (NOT exception_required OR justification IS NOT NULL)
       AND created_at = (SELECT max(created_at) FROM rarorac_computation WHERE facility_id=$1 AND status='COMPLETED')`);
    case 'CREDIT_MEMO': return exists(`SELECT 1 FROM generated_document WHERE facility_id=$1 AND kind='CREDIT_MEMO'`);
    case 'ES_ASSESSMENT': return exists(`SELECT 1 FROM es_assessment WHERE facility_id=$1 AND status='SUBMITTED'`);
    case 'CONDITIONS_LEGAL': return !(await exists(`SELECT 1 FROM condition_item WHERE facility_id=$1 AND owner_team='LEGAL' AND mandatory AND category='PRECEDENT' AND status='PENDING' AND terms_id=(SELECT id FROM approved_terms WHERE facility_id=$1 ORDER BY version_no DESC LIMIT 1)`));
    case 'CONDITIONS_SHARIAH': return !(await exists(`SELECT 1 FROM condition_item WHERE facility_id=$1 AND owner_team='SHARIAH' AND mandatory AND category='PRECEDENT' AND status='PENDING' AND terms_id=(SELECT id FROM approved_terms WHERE facility_id=$1 ORDER BY version_no DESC LIMIT 1)`));
    case 'CONDITIONS_ALL_MANDATORY': return !(await exists(`SELECT 1 FROM condition_item WHERE facility_id=$1 AND mandatory AND category='PRECEDENT' AND status='PENDING' AND terms_id=(SELECT id FROM approved_terms WHERE facility_id=$1 ORDER BY version_no DESC LIMIT 1)`));
    case 'DOCUMENTS_VERIFIED': return !(await exists(`SELECT 1 FROM document WHERE facility_id=$1 AND mandatory AND deleted_at IS NULL AND status IN ('UPLOADED','UNDER_REVIEW','REQUIRED')`));
    default: return false;
  }
}

export async function prerequisiteStatus(db: Db, codes: string[], facilityId: string) {
  const out: { code: string; label: string; met: boolean }[] = [];
  for (const c of codes) out.push({ code: c, label: LABEL[c] ?? c, met: await check(db, c, facilityId) });
  return out;
}

export async function unmetPrerequisites(db: Db, codes: string[], facilityId: string) {
  return (await prerequisiteStatus(db, codes, facilityId)).filter((p) => !p.met);
}
void q;
