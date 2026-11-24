import { Socket } from 'node:net';
import type { AntivirusAdapter, CoreBankingAdapter, DirectoryAdapter, BureauAdapter, RaroracAdapter, MessagingAdapter, IdentityAdapter } from './types.js';
import { IntegrationError } from './types.js';

/** ClamAV clamd INSTREAM protocol over TCP (production malware scanning). */
export class ClamdAntivirus implements AntivirusAdapter {
  mode = 'LIVE' as const;
  constructor(private host: string, private port: number, private timeoutMs = 15_000) {}
  scan(data: Buffer) {
    return new Promise<Awaited<ReturnType<AntivirusAdapter['scan']>>>((resolve) => {
      const sock = new Socket();
      let out = '';
      const done = (r: Awaited<ReturnType<AntivirusAdapter['scan']>>) => { sock.destroy(); resolve(r); };
      sock.setTimeout(this.timeoutMs, () => done({ status: 'ERROR', engine: 'clamd', signature: 'timeout' }));
      sock.on('error', () => done({ status: 'ERROR', engine: 'clamd', signature: 'connection error' }));
      sock.on('data', (d) => (out += d.toString()));
      sock.on('end', () => {
        if (/OK\s*$/.test(out.replace(/\0/g, ''))) done({ status: 'CLEAN', engine: 'clamd' });
        else if (/FOUND/.test(out)) done({ status: 'INFECTED', engine: 'clamd', signature: out.replace(/^stream:\s*/, '').replace(/ FOUND.*/s, '') });
        else done({ status: 'ERROR', engine: 'clamd', signature: out.slice(0, 120) });
      });
      sock.connect(this.port, this.host, () => {
        sock.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          sock.write(len);
          sock.write(chunk);
        }
        sock.write(Buffer.alloc(4));
      });
    });
  }
}

/**
 * Live adapters require Bank API Gateway endpoints and credentials that are not available in this
 * repository. They fail closed with a clear error rather than pretending to work.
 */
const notProvisioned = (system: string) => () => {
  throw new IntegrationError(system, 'live integration is not provisioned in this environment (gateway endpoint and credentials required)', false);
};
export const unprovisionedCba: CoreBankingAdapter = { mode: 'LIVE', findByAccountNumber: notProvisioned('CBA'), getExposure: notProvisioned('CBA'), bookFacility: notProvisioned('CBA'), postDisbursement: notProvisioned('CBA'), getStatement: notProvisioned('CBA'), findPersonByBvn: notProvisioned('CBA') };
export const unprovisionedDirectory: DirectoryAdapter = { mode: 'LIVE', authenticate: notProvisioned('ActiveDirectory') };
export const unprovisionedBureau: BureauAdapter = { mode: 'LIVE', provider: 'UNPROVISIONED', businessReport: notProvisioned('CreditBureau'), individualReport: notProvisioned('CreditBureau') };
export const unprovisionedRarorac: RaroracAdapter = { mode: 'LIVE', provider: 'RAPP', compute: notProvisioned('RARORAC') };
export const unprovisionedMessaging: MessagingAdapter = { mode: 'LIVE', sendSms: notProvisioned('SMS'), sendEmail: notProvisioned('Email') };
export const unprovisionedIdentity: IdentityAdapter = { mode: 'LIVE', provider: 'Not provisioned', lookupBvn: notProvisioned('Identity'), lookupNin: notProvisioned('Identity') };
