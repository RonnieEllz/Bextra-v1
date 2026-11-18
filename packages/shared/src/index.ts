import { z } from 'zod';
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';

export const moneySchema = z.coerce.bigint();

export const tapBatchSchema = z.object({
  terminalId: z.string().uuid(),
  batchId: z.string().uuid(),
  declaredCount: z.number().int().nonnegative(),
  blockedListVersion: z.number().int().nonnegative(),
  taps: z.array(z.object({
    tapId: z.string().uuid(),
    cardToken: z.string().min(1),
    terminalId: z.string().uuid(),
    routeId: z.string().uuid(),
    tappedAt: z.string().datetime(),
    counter: z.number().int().positive(),
    claimedFareMinor: z.number().int().nonnegative(),
    offlineFlag: z.boolean(),
    signature: z.string().min(1),
  })).max(500),
});

export type TapBatch = z.infer<typeof tapBatchSchema>;

export const topUpSchema = z.object({
  agentId: z.string().uuid(),
  cardId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
});

export type TopUp = z.infer<typeof topUpSchema>;

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance: string;
  requestId: string;
}

export function generateTerminalKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

export function signTap(privateKeyPem: string, payload: object): string {
  const signer = createSign('RSA-SHA256');
  signer.update(JSON.stringify(payload));
  signer.end();
  return signer.sign(privateKeyPem).toString('base64');
}

export function verifyTap(publicKeyPem: string, signature: string, payload: object): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(JSON.stringify(payload));
  verifier.end();
  return verifier.verify(publicKeyPem, Buffer.from(signature, 'base64'));
}
