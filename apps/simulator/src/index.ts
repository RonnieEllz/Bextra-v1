import { generateTerminalKeyPair, signTap } from '@bextra/shared';

const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const scenario = process.argv[2] ?? 'normal';
const { publicKey, privateKey } = generateTerminalKeyPair();

interface Tap {
  tapId: string;
  cardToken: string;
  terminalId: string;
  routeId: string;
  tappedAt: string;
  counter: number;
  claimedFareMinor: number;
  offlineFlag: boolean;
  signature: string;
}

function makeTap(index: number, tamper = false): Tap {
  const payload = {
    tapId: crypto.randomUUID(),
    cardToken: 'BE-TEST-CARD-001',
    terminalId: '00000000-0000-0000-0000-000000000001',
    routeId: '00000000-0000-0000-0000-000000000001',
    tappedAt: new Date().toISOString(),
    counter: index,
    claimedFareMinor: 500,
  };
  return {
    ...payload,
    offlineFlag: scenario === 'offline',
    signature: tamper ? 'AA==' : signTap(privateKey, payload),
  };
}

async function main() {
  const count = scenario === 'burst' ? 50 : 20;
  const taps = Array.from({ length: count }, (_, index) =>
    makeTap(index + 1, scenario === 'tampered' && index === 7),
  );
  const batchId = crypto.randomUUID();
  const response = await fetch(`${apiUrl}/v1/terminals/taps/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': crypto.randomUUID(),
      'x-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      terminalId: taps[0].terminalId,
      batchId,
      declaredCount: taps.length,
      blockedListVersion: 0,
      taps,
    }),
  });
  console.log(JSON.stringify({
    scenario,
    publicKeyGenerated: publicKey.length > 0,
    status: response.status,
    body: await response.text(),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
