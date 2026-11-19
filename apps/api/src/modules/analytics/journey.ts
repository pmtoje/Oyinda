import type { Db } from '../../db/pool.js';
import { q } from '../../db/pool.js';

/** Journey step events power drop-off analytics. Only step names are recorded, never form content. */
export async function recordStep(db: Db, journey: 'ONBOARDING' | 'FACILITY_APPLICATION', journeyId: string, customerId: string | null, step: string, event: 'ENTERED' | 'COMPLETED' | 'ERROR') {
  await q(db, 'INSERT INTO journey_step_event(journey, journey_id, customer_id, step, event) VALUES ($1,$2,$3,$4,$5)', [journey, journeyId, customerId, step, event]);
}
