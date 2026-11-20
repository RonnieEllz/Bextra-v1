import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionContext } from '@nestjs/common';
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { signTap } from '@bextra/shared';
import { generateTerminalKeyPair } from '@bextra/shared';

const cwdEnv = path.resolve(process.cwd(), '.env');
const workspaceEnv = path.resolve(process.cwd(), '../../.env');
dotenv.config({ path: fs.existsSync(cwdEnv) ? cwdEnv : workspaceEnv });
const databaseUrl = process.env.TEST_DATABASE_URL;

test('mobile contract seeds OTP/PIN authentication, card activity and agent summary', async (t) => {
  process.env.NODE_ENV = 'test';
  if (!databaseUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }
  const { AuthService } = await import('../src/modules/auth/auth.service.js');
  const { MobileController } = await import('../src/modules/mobile/mobile.controller.js');
  const auth = new AuthService();
  const mobile = new MobileController();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query(
    `UPDATE otp_challenges SET resend_allowed_at = now() - interval '1 second'
     WHERE phone = $1`,
    ['+265888100200'],
  );
  await pool.end();

  const otp = await auth.requestOtp('+265888100200');
  assert.ok(Number.isFinite(Date.parse(otp.expiresAt)));
  assert.ok(Number.isFinite(Date.parse(otp.resendAllowedAt)));
  const customer = await auth.verifyOtp('+265888100200', '123456');
  assert.equal(customer.auth.role, 'customer');
  assert.equal(customer.auth.cardToken, 'CARD-1001');
  const balance = await mobile.cardBalance('CARD-1001', { auth: customer.auth });
  assert.ok(Number.isSafeInteger(balance.balanceMinor));
  const activity = await mobile.cardActivity(
    'CARD-1001', undefined, undefined, 'all', undefined, undefined, { auth: customer.auth },
  );
  assert.equal(activity.total, 5);
  assert.equal(activity.items.length, 5);

  const agent = await auth.login('+265999111222', 'BeXtra123!');
  assert.equal(agent.auth.role, 'agent');
  assert.ok(agent.auth.agentId);
  const stepUp = await auth.verifyAgentPin(agent.auth, agent.auth.agentId!, '1234');
  const { verifyAgentStepUpToken } = await import('../src/modules/auth/auth.service.js');
  assert.equal(verifyAgentStepUpToken(stepUp.stepUpToken, agent.auth.userId, agent.auth.agentId!), true);
  const summary = await mobile.agentSummary(agent.auth.agentId!, { auth: agent.auth });
  assert.ok(Number.isSafeInteger(summary.float.remainingMinor));
  assert.equal(summary.float.openingMinor, 5_000_000);
  assert.ok(Number.isSafeInteger(summary.float.cashTopupsIssuedMinor));
  assert.ok(summary.float.cashTopupsIssuedMinor >= 200_000);
  assert.ok(summary.float.commissionAccruedTodayMinor >= 48_000);
  assert.ok(summary.today.cashTakenMinor >= 280_000);
  assert.ok(summary.today.topupCount >= 12);
  assert.ok(summary.today.commissionMinor >= 48_000);
  assert.ok(summary.recentLoads.length >= 2);
});

test('customer registration validates, rate-limits, verifies and provisions exactly once', async (t) => {
  process.env.NODE_ENV = 'test';
  if (!databaseUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }
  const { AuthService } = await import('../src/modules/auth/auth.service.js');
  const auth = new AuthService();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const operator = await pool.query(
    `SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' AND status = 'active' LIMIT 1`,
  );
  assert.equal(operator.rowCount, 1);
  const previousOperator = process.env.CUSTOMER_REGISTRATION_OPERATOR_ID;
  process.env.CUSTOMER_REGISTRATION_OPERATOR_ID = operator.rows[0].id;

  const phone = `+265${Date.now().toString().slice(-9)}`;
  const limitedPhone = `+265${(Date.now() + 1).toString().slice(-9)}`;
  const expiredPhone = `+265${(Date.now() + 2).toString().slice(-9)}`;
  const noOperatorPhone = `+265${(Date.now() + 3).toString().slice(-9)}`;
  const attemptLimitedPhone = `+265${(Date.now() + 4).toString().slice(-9)}`;
  const duplicatePhone = '+265888100200';
  let customerId: string | undefined;
  let userId: string | undefined;
  try {
    await assert.rejects(
      auth.requestCustomerRegistrationOtp({ phone, gender: 'woman' }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_FULL_NAME',
    );
    await assert.rejects(
      auth.requestCustomerRegistrationOtp({ fullName: 'New Customer', phone: '12345' }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_PHONE',
    );
    await assert.rejects(
      auth.requestCustomerRegistrationOtp({ fullName: 'New Customer', phone, email: 'not-an-email' }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_EMAIL',
    );
    await assert.rejects(
      auth.verifyCustomerRegistrationOtp(phone, '12345'),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_OTP',
    );
    const request = await auth.requestCustomerRegistrationOtp({
      fullName: '  New   Customer ',
      phone: phone.replace('+265', '+265 '),
      gender: ' woman ',
      email: ' NEW.CUSTOMER@EXAMPLE.COM ',
      location: ' Lilongwe   Area 18 ',
    });
    assert.ok(Number.isFinite(Date.parse(request.expiresAt)));
    assert.ok(Number.isFinite(Date.parse(request.resendAllowedAt)));
    const beforeVerify = await pool.query(
      `SELECT count(*)::int AS count FROM users WHERE external_id = $1`,
      [phone],
    );
    assert.equal(beforeVerify.rows[0].count, 0);
    await assert.rejects(
      auth.requestCustomerRegistrationOtp({ fullName: 'New Customer', phone }),
      (error: unknown) => (error as { code?: string }).code === 'OTP_RESEND_NOT_ALLOWED',
    );

    await auth.requestCustomerRegistrationOtp({
      fullName: 'Limited Customer',
      phone: limitedPhone,
    });
    await pool.query(
      `UPDATE customer_registration_rate_limits
       SET request_count = 3, resend_allowed_at = now() - interval '1 second'
       WHERE phone_hash = encode(digest($1, 'sha256'), 'hex')`,
      [limitedPhone],
    );
    await assert.rejects(
      auth.requestCustomerRegistrationOtp({ fullName: 'Limited Customer', phone: limitedPhone }),
      (error: unknown) => (error as { code?: string }).code === 'OTP_RATE_LIMITED',
    );

    const expiredRequest = await auth.requestCustomerRegistrationOtp({
      fullName: 'Expired Customer',
      phone: expiredPhone,
    });
    await pool.query(
      `UPDATE customer_registration_challenges SET expires_at = now() - interval '1 second'
       WHERE phone = $1`,
      [expiredPhone],
    );
    await assert.rejects(
      auth.verifyCustomerRegistrationOtp(expiredPhone, '123456'),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_OTP',
    );
    const expiredChallenge = await pool.query(
      `SELECT 1 FROM customer_registration_challenges WHERE phone = $1`,
      [expiredPhone],
    );
    assert.equal(expiredChallenge.rowCount, 0);
    assert.ok(Number.isFinite(Date.parse(expiredRequest.expiresAt)));

    await auth.requestCustomerRegistrationOtp({
      fullName: 'Attempt Limited Customer',
      phone: attemptLimitedPhone,
    });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await assert.rejects(
        auth.verifyCustomerRegistrationOtp(attemptLimitedPhone, '000000'),
        (error: unknown) => (error as { code?: string }).code === 'INVALID_OTP',
      );
    }
    await assert.rejects(
      auth.verifyCustomerRegistrationOtp(attemptLimitedPhone, '000000'),
      (error: unknown) => (error as { code?: string }).code === 'OTP_ATTEMPTS_EXCEEDED',
    );
    await assert.rejects(
      auth.verifyCustomerRegistrationOtp(attemptLimitedPhone, '123456'),
      (error: unknown) => (error as { code?: string }).code === 'OTP_ATTEMPTS_EXCEEDED',
    );

    await auth.requestCustomerRegistrationOtp({
      fullName: 'Unassigned Customer',
      phone: noOperatorPhone,
    });
    delete process.env.CUSTOMER_REGISTRATION_OPERATOR_ID;
    await assert.rejects(
      auth.verifyCustomerRegistrationOtp(noOperatorPhone, '123456'),
      (error: unknown) => (error as { code?: string }).code === 'CUSTOMER_REGISTRATION_UNAVAILABLE',
    );
    const unassignedCustomer = await pool.query(
      `SELECT 1 FROM customers WHERE phone = $1`,
      [noOperatorPhone],
    );
    assert.equal(unassignedCustomer.rowCount, 0);
    process.env.CUSTOMER_REGISTRATION_OPERATOR_ID = operator.rows[0].id;

    const challenge = await pool.query(
      `SELECT code_hash FROM customer_registration_challenges WHERE phone = $1`,
      [phone],
    );
    await pool.query(
      `UPDATE customer_registration_rate_limits
       SET resend_allowed_at = now() - interval '1 second'
       WHERE phone_hash = $1`,
      [createHash('sha256').update(phone).digest('hex')],
    );
    assert.ok(challenge.rowCount);
    assert.notEqual(challenge.rows[0].code_hash, '123456');
    await pool.query(
      `UPDATE customer_registration_challenges SET resend_allowed_at = now() - interval '1 second'
       WHERE phone = $1`,
      [phone],
    );
    const concurrentRequests = await Promise.allSettled([
      auth.requestCustomerRegistrationOtp({
        fullName: ' New Customer ',
        phone,
        gender: 'woman',
        email: 'new.customer@example.com',
        location: 'Lilongwe Area 18',
      }),
      auth.requestCustomerRegistrationOtp({
        fullName: 'New Customer',
        phone,
        gender: 'woman',
        email: 'new.customer@example.com',
        location: 'Lilongwe Area 18',
      }),
    ]);
    assert.equal(concurrentRequests.filter((result) => result.status === 'fulfilled').length, 1);

    const verifications = await Promise.allSettled([
      auth.verifyCustomerRegistrationOtp(phone, '123456'),
      auth.verifyCustomerRegistrationOtp(phone, '123456'),
    ]);
    const successful = verifications.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof auth.verifyCustomerRegistrationOtp>>> =>
        result.status === 'fulfilled',
    );
    assert.equal(successful.length, 1);
    assert.equal(successful[0].value.auth.role, 'customer');
    assert.equal(successful[0].value.auth.operatorId, operator.rows[0].id);
    assert.equal(successful[0].value.auth.externalId, phone);
    assert.equal(successful[0].value.auth.agentId, null);
    assert.equal(successful[0].value.auth.cardToken, null);
    assert.equal(
      (await pool.query('SELECT 1 FROM customer_registration_challenges WHERE phone = $1', [phone])).rowCount,
      0,
    );

    const created = await pool.query(
      `SELECT c.id AS customer_id, c.full_name, c.gender, c.email, c.location,
              u.id AS user_id, u.status, r.name AS role,
              a.id AS wallet_id, a.code AS wallet_code
       FROM customers c
       JOIN users u ON u.customer_id = c.id
       JOIN roles r ON r.id = u.role_id
       JOIN accounts a ON a.customer_id = c.id AND a.code = 'CUSTOMER_WALLET'
       WHERE c.phone = $1`,
      [phone],
    );
    assert.equal(created.rowCount, 1);
    customerId = created.rows[0].customer_id;
    userId = created.rows[0].user_id;
    assert.equal(created.rows[0].full_name, 'New Customer');
    assert.equal(created.rows[0].gender, 'woman');
    assert.equal(created.rows[0].email, 'new.customer@example.com');
    assert.equal(created.rows[0].location, 'Lilongwe Area 18');
    assert.equal(created.rows[0].status, 'active');
    assert.equal(created.rows[0].role, 'customer');
    assert.equal(created.rows[0].wallet_code, 'CUSTOMER_WALLET');

    const duplicateRequest = await auth.requestCustomerRegistrationOtp({
      fullName: 'Changed Existing Profile',
      phone: duplicatePhone,
      email: 'changed@example.com',
    });
    assert.ok(Number.isFinite(Date.parse(duplicateRequest.expiresAt)));
    await assert.rejects(
      auth.verifyCustomerRegistrationOtp(duplicatePhone, '123456'),
      (error: unknown) => (error as { code?: string }).code === 'PHONE_ALREADY_REGISTERED',
    );
    const existing = await pool.query(
      `SELECT c.full_name FROM customers c WHERE c.phone = $1`,
      [duplicatePhone],
    );
    assert.equal(existing.rows[0].full_name, null);
    const duplicateUserCount = await pool.query(
      `SELECT count(*)::int AS count FROM users WHERE external_id = $1`,
      [duplicatePhone],
    );
    assert.equal(duplicateUserCount.rows[0].count, 1);
  } finally {
    if (customerId) {
      await pool.query('DELETE FROM accounts WHERE customer_id = $1', [customerId]);
      await pool.query('DELETE FROM users WHERE customer_id = $1', [customerId]);
      await pool.query('DELETE FROM customers WHERE id = $1', [customerId]);
    }
    if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query(
      `DELETE FROM customer_registration_challenges WHERE phone = ANY($1::text[])`,
      [[phone, limitedPhone, expiredPhone, noOperatorPhone, attemptLimitedPhone, duplicatePhone]],
    );
    await pool.query(
      `DELETE FROM customer_registration_rate_limits
       WHERE phone_hash = ANY($1::text[])`,
      [[phone, limitedPhone, expiredPhone, noOperatorPhone, attemptLimitedPhone, duplicatePhone].map((value) =>
        createHash('sha256').update(value).digest('hex'))],
    );
    if (previousOperator === undefined) delete process.env.CUSTOMER_REGISTRATION_OPERATOR_ID;
    else process.env.CUSTOMER_REGISTRATION_OPERATOR_ID = previousOperator;
    await pool.end();
  }
});

test('customer registration does not expose duplicate phones at request time and respects production delivery configuration', async (t) => {
  const { AuthService } = await import('../src/modules/auth/auth.service.js');
  const auth = new AuthService();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOperator = process.env.CUSTOMER_REGISTRATION_OPERATOR_ID;
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(
      auth.requestCustomerRegistrationOtp({
        fullName: 'Valid Customer',
        phone: '+265888100200',
      }),
      (error: unknown) => (error as { code?: string; status?: number }).code === 'OTP_DELIVERY_UNAVAILABLE' &&
        (error as { status?: number }).status === 503,
    );
    await assert.rejects(
      auth.verifyCustomerRegistrationOtp('+265888100200', '123456'),
      (error: unknown) => (error as { code?: string }).code === 'OTP_DELIVERY_UNAVAILABLE',
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousOperator === undefined) delete process.env.CUSTOMER_REGISTRATION_OPERATOR_ID;
    else process.env.CUSTOMER_REGISTRATION_OPERATOR_ID = previousOperator;
  }
});

test('admins provision agents with one-time setup invitations and can suspend or reissue them', async (t) => {
  process.env.NODE_ENV = 'test';
  if (!databaseUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }
  const { AdminController } = await import('../src/modules/admin/admin.controller.js');
  const { AuthGuard } = await import('../src/modules/auth/auth.guard.js');
  const { AuthService } = await import('../src/modules/auth/auth.service.js');
  const adminController = new AdminController();
  const authGuard = new AuthGuard();
  const authService = new AuthService();
  const requestContext = (accessToken: string) => ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: `Bearer ${accessToken}` } }),
    }),
  }) as unknown as ExecutionContext;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const operator = await pool.query(
    `SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1`,
  );
  const admin = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.external_id = 'platform-admin' AND r.name = 'platform_admin'`,
  );
  assert.equal(admin.rowCount, 1);
  const context = {
    auth: {
      userId: admin.rows[0].id,
      externalId: 'platform-admin',
      role: 'platform_admin' as const,
      operatorId: null,
    },
  };
  const phone = `+265${Date.now().toString().slice(-9)}`;
  let agentId: string | undefined;
  try {
    const invitation = await adminController.createAgent(
      { operatorId: operator.rows[0].id, name: 'Test Agent', phone, location: 'Test location' },
      context,
    );
    const createdAgentId = invitation.agent.id;
    agentId = createdAgentId;
    assert.equal(invitation.agent.status, 'inactive');
    assert.equal(invitation.agent.invitationPending, true);
    assert.equal(typeof invitation.setupToken, 'string');
    const stored = await pool.query(
      `SELECT a.invitation_token_hash, u.id AS user_id, u.status
       FROM agents a JOIN users u ON u.agent_id = a.id WHERE a.id = $1`,
      [createdAgentId],
    );
    assert.notEqual(stored.rows[0].invitation_token_hash, invitation.setupToken);
    assert.equal(stored.rows[0].status, 'inactive');
    await assert.rejects(authService.login(phone, 'FirstPass12345'));

    await authService.completeAgentSetup(invitation.setupToken, 'FirstPass12345', '2468');
    const login = await authService.login(phone, 'FirstPass12345');
    assert.equal(login.auth.agentId, createdAgentId);
    assert.equal(await authGuard.canActivate(requestContext(login.accessToken)), true);
    await assert.rejects(authService.completeAgentSetup(invitation.setupToken, 'AnotherPass123', '1234'));

    await adminController.setAgentStatus(
      createdAgentId,
      operator.rows[0].id,
      { status: 'blocked', reason: 'Testing suspension' },
      context,
    );
    await assert.rejects(authService.login(phone, 'FirstPass12345'));
    await assert.rejects(authGuard.canActivate(requestContext(login.accessToken)));

    const renewedInvitation = await adminController.reissueAgentInvitation(
      createdAgentId,
      operator.rows[0].id,
      context,
    );
    await assert.rejects(authService.login(phone, 'FirstPass12345'));
    await authService.completeAgentSetup(renewedInvitation.setupToken, 'SecondPass12345', '1357');
    const refreshedLogin = await authService.login(phone, 'SecondPass12345');
    assert.equal(refreshedLogin.auth.agentId, createdAgentId);
    await assert.rejects(authGuard.canActivate(requestContext(login.accessToken)));
    assert.equal(await authGuard.canActivate(requestContext(refreshedLogin.accessToken)), true);
  } finally {
    if (agentId) {
      const users = await pool.query('SELECT id FROM users WHERE agent_id = $1', [agentId]);
      for (const user of users.rows) {
        await pool.query('DELETE FROM audit_log WHERE actor_id = $1', [user.id]);
      }
      await pool.query('DELETE FROM users WHERE agent_id = $1', [agentId]);
      await pool.query('DELETE FROM accounts WHERE agent_id = $1', [agentId]);
      await pool.query('DELETE FROM agents WHERE id = $1', [agentId]);
    }
    await pool.end();
  }
});

test('terminal public key registration validates keys and tenant scope', async (t) => {
  process.env.NODE_ENV = 'test';
  if (!databaseUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const operator = await pool.query(
    `SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1`,
  );
  const terminal = await pool.query(
    `SELECT id FROM terminals WHERE operator_id = $1 LIMIT 1`,
    [operator.rows[0].id],
  );
  const { DevicesController } = await import('../src/modules/devices/devices.controller.js');
  const controller = new DevicesController();
  const keys = generateTerminalKeyPair();
  const result = await controller.registerKey(
    terminal.rows[0].id,
    { publicKey: keys.publicKey, keyReference: 'integration-test-key' },
    { auth: {
      userId: crypto.randomUUID(),
      externalId: 'test-admin',
      role: 'operator_admin',
      operatorId: operator.rows[0].id,
    } },
  );
  assert.equal(result.status, 'key_registered');
  await assert.rejects(
    controller.registerKey(
      terminal.rows[0].id,
      { publicKey: keys.publicKey },
      { auth: {
        userId: crypto.randomUUID(),
        externalId: 'other-operator',
        role: 'operator_admin',
        operatorId: crypto.randomUUID(),
      } },
    ),
    (error: unknown) => (error as { code?: string }).code === 'TERMINAL_NOT_FOUND',
  );
  await assert.rejects(
    controller.registerKey(
      terminal.rows[0].id,
      { publicKey: 'not a public key' },
      { auth: {
        userId: crypto.randomUUID(),
        externalId: 'test-admin',
        role: 'platform_admin',
        operatorId: null,
      } },
    ),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_PUBLIC_KEY',
  );
  await pool.end();
});

test('concurrent tap upload charges once and a mixed batch rejects only invalid taps', async (t) => {
  process.env.NODE_ENV = 'test';
  if (!databaseUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const keyPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const operator = await pool.query(
    `SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1`,
  );
  assert.equal(operator.rowCount, 1);
  const operatorId = operator.rows[0].id;

  const terminal = await pool.query(
    `SELECT id FROM terminals WHERE operator_id = $1 LIMIT 1`,
    [operatorId],
  );
  assert.equal(terminal.rowCount, 1);
  const terminalId = terminal.rows[0].id;
  await pool.query(
    `UPDATE terminals SET public_key = $1, blocked_list_version = 0 WHERE id = $2`,
    [keyPair.publicKey, terminalId],
  );
  await pool.query(
    `DELETE FROM risk_events
     WHERE tap_id IN (
       SELECT t.id FROM taps t
       JOIN cards c ON c.id = t.card_id
       WHERE t.terminal_id = $1 AND c.card_token = 'BE-TEST-CARD-001'
     )`,
    [terminalId],
  );
  await pool.query(
    `DELETE FROM taps
     WHERE terminal_id = $1
       AND card_id = (SELECT id FROM cards WHERE card_token = 'BE-TEST-CARD-001')`,
    [terminalId],
  );

  const route = await pool.query(
    `SELECT id FROM routes WHERE operator_id = $1 LIMIT 1`,
    [operatorId],
  );
  const card = await pool.query(
    `SELECT id, card_token, customer_id FROM cards
     WHERE operator_id = $1 AND card_token = 'BE-TEST-CARD-001'`,
    [operatorId],
  );
  await pool.query(
    `UPDATE cards SET status = 'active', counter = 0 WHERE id = $1`,
    [card.rows[0].id],
  );

  const { GatewayService } = await import('../src/modules/gateway/gateway.service.js');
  const gateway = new GatewayService();
  const concurrentTapId = crypto.randomUUID();
  const payload = {
    tapId: concurrentTapId,
    cardToken: card.rows[0].card_token,
    terminalId,
    routeId: route.rows[0].id,
    tappedAt: new Date().toISOString(),
    counter: 1,
    claimedFareMinor: 500,
  };
  const tap = {
    ...payload,
    offlineFlag: false,
    signature: signTap(keyPair.privateKey, payload),
  };
  const batch = {
    terminalId,
    batchId: crypto.randomUUID(),
    declaredCount: 1,
    blockedListVersion: 0,
    taps: [tap],
  };

  const uploads = await Promise.all([
    gateway.uploadBatch(batch, crypto.randomUUID()),
    gateway.uploadBatch(batch, crypto.randomUUID()),
    gateway.uploadBatch(batch, crypto.randomUUID()),
  ]);
  assert.equal(uploads.filter((item) => item.outcomes[0]?.status === 'posted').length, 1);
  assert.equal(uploads.filter((item) => item.outcomes[0]?.status === 'duplicate').length, 2);

  const posted = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM taps WHERE tap_id = $1 AND status = 'posted'`,
    [concurrentTapId],
  );
  assert.equal(posted.rows[0].count, 1);

  const mixedTaps = Array.from({ length: 20 }, (_, index) => {
    const tapPayload = {
      tapId: crypto.randomUUID(),
      cardToken: card.rows[0].card_token,
      terminalId,
      routeId: route.rows[0].id,
      tappedAt: new Date().toISOString(),
      counter: index + 2,
      claimedFareMinor: 500,
    };
    return {
      ...tapPayload,
      offlineFlag: false,
      signature: index === 7 ? 'invalid-signature' : signTap(keyPair.privateKey, tapPayload),
    };
  });
  const mixedResult = await gateway.uploadBatch({
    terminalId,
    batchId: crypto.randomUUID(),
    declaredCount: 20,
    blockedListVersion: 0,
    taps: mixedTaps,
  }, crypto.randomUUID());

  assert.equal(mixedResult.outcomes.filter((item) => item.status === 'posted').length, 19);
  assert.equal(mixedResult.outcomes.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(
    mixedResult.outcomes.filter((item) => item.rejectReason === 'INVALID_SIGNATURE').length,
    1,
  );

  const edgeTap = (counter: number, tappedAt = new Date().toISOString()) => {
    const edgePayload = {
      tapId: crypto.randomUUID(),
      cardToken: card.rows[0].card_token,
      terminalId,
      routeId: route.rows[0].id,
      tappedAt,
      counter,
      claimedFareMinor: 500,
    };
    return {
      ...edgePayload,
      offlineFlag: false,
      signature: signTap(keyPair.privateKey, edgePayload),
    };
  };
  const uploadOne = (tap: ReturnType<typeof edgeTap>) => gateway.uploadBatch({
    terminalId,
    batchId: crypto.randomUUID(),
    declaredCount: 1,
    blockedListVersion: 0,
    taps: [tap],
  }, crypto.randomUUID());

  await pool.query(`UPDATE cards SET status = 'blocked' WHERE id = $1`, [card.rows[0].id]);
  const blocked = await uploadOne(edgeTap(22));
  assert.equal(blocked.outcomes[0]?.rejectReason, 'CARD_BLOCKED');
  await pool.query(`UPDATE cards SET status = 'active' WHERE id = $1`, [card.rows[0].id]);

  const stale = await uploadOne(edgeTap(22, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()));
  assert.equal(stale.outcomes[0]?.rejectReason, 'STALE_OR_FUTURE_TIMESTAMP');

  const replay = await uploadOne(edgeTap(21));
  assert.equal(replay.outcomes[0]?.rejectReason, 'COUNTER_REPLAY');

  await pool.end();
});

test('concurrent identical agent top-ups credit once and insufficient float is refused', async (t) => {
  process.env.NODE_ENV = 'test';
  if (!databaseUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const operator = await pool.query(
    `SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1`,
  );
  const agent = await pool.query(
    `SELECT id FROM agents WHERE operator_id = $1 AND external_id = '+265999111222' LIMIT 1`,
    [operator.rows[0].id],
  );
  const card = await pool.query(
    `SELECT id FROM cards
     WHERE operator_id = $1 AND card_token = 'BE-TEST-CARD-001'`,
    [operator.rows[0].id],
  );
  const floatAccount = await pool.query(
    `SELECT float_account_id FROM agents WHERE id = $1`,
    [agent.rows[0].id],
  );
  const clearing = await pool.query(
    `SELECT id FROM accounts
     WHERE operator_id = $1 AND code = 'PLATFORM_CLEARING'`,
    [operator.rows[0].id],
  );
  const floatBalance = await pool.query(
    `SELECT COALESCE(SUM(credit_minor - debit_minor), 0)::bigint AS balance
     FROM ledger_entries WHERE account_id = $1`,
    [floatAccount.rows[0].float_account_id],
  );
  if (BigInt(floatBalance.rows[0].balance) < 100000n) {
    const resetKey = `test:float-reset:${crypto.randomUUID()}`;
    await pool.query('BEGIN');
    const resetHeader = await pool.query(
      `INSERT INTO transactions(operator_id, idempotency_key, event_type)
       VALUES ($1, $2, 'test_float_topup') RETURNING id`,
      [operator.rows[0].id, resetKey],
    );
    await pool.query(
      `INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
       VALUES ($1, $2, 1000000, 0), ($1, $3, 0, 1000000)`,
      [resetHeader.rows[0].id, clearing.rows[0].id, floatAccount.rows[0].float_account_id],
    );
    await pool.query('COMMIT');
  }
  const { FundingService } = await import('../src/modules/funding/funding.service.js');
  const funding = new FundingService();
  const key = `test-topup-${crypto.randomUUID()}`;
  const body = { agentId: agent.rows[0].id, cardId: card.rows[0].id, amountMinor: 1000 };
  const dailyBefore = await pool.query(
    `SELECT cash_taken_minor, topup_count, commission_minor FROM agent_daily_stats
     WHERE agent_id = $1 AND business_day = (now() AT TIME ZONE 'Africa/Blantyre')::date`,
    [agent.rows[0].id],
  );
  assert.equal(dailyBefore.rowCount, 1);

  const results = await Promise.all([
    funding.topUp(body, key),
    funding.topUp(body, key),
    funding.topUp(body, key),
  ]);
  assert.equal(results.filter((item) => item.status === 'confirmed').length, 3);
  assert.equal(results.filter((item) => 'duplicate' in item && item.duplicate === true).length, 2);
  assert.equal(new Set(results.map((item) => item.fundingRequestId)).size, 1);
  const dailyAfter = await pool.query(
    `SELECT cash_taken_minor, topup_count, commission_minor FROM agent_daily_stats
     WHERE agent_id = $1 AND business_day = (now() AT TIME ZONE 'Africa/Blantyre')::date`,
    [agent.rows[0].id],
  );
  assert.equal(Number(dailyAfter.rows[0].cash_taken_minor), Number(dailyBefore.rows[0].cash_taken_minor) + body.amountMinor);
  assert.equal(Number(dailyAfter.rows[0].topup_count), Number(dailyBefore.rows[0].topup_count) + 1);
  assert.equal(
    Number(dailyAfter.rows[0].commission_minor),
    Number(dailyBefore.rows[0].commission_minor) + Number(results[0].commissionMinor),
  );
  await assert.rejects(
    funding.topUp({ ...body, amountMinor: 2000 }, key),
    (error: unknown) => (error as { code?: string }).code === 'IDEMPOTENCY_CONFLICT',
  );

  const requestCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM funding_requests WHERE idempotency_key = $1`,
    [key],
  );
  assert.equal(requestCount.rows[0].count, 1);

  await pool.query(`UPDATE cards SET status = 'blocked' WHERE id = $1`, [card.rows[0].id]);
  try {
    await assert.rejects(
      funding.topUp(body, `test-blocked-${crypto.randomUUID()}`),
      (error: unknown) => (error as { code?: string }).code === 'CARD_BLOCKED',
    );
  } finally {
    await pool.query(`UPDATE cards SET status = 'active' WHERE id = $1`, [card.rows[0].id]);
  }

  await assert.rejects(
    funding.topUp(
      { agentId: agent.rows[0].id, cardId: card.rows[0].id, amountMinor: 99_999_999_999 },
      `test-insufficient-${crypto.randomUUID()}`,
    ),
    (error: unknown) => (error as { code?: string }).code === 'INSUFFICIENT_FLOAT',
  );

  await pool.end();
});

test('settlement locks on tap-count discrepancy and records a finance override', async (t) => {
  process.env.NODE_ENV = 'test';
  if (!databaseUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const operator = await pool.query(
    `SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1`,
  );
  const terminal = await pool.query(
    `SELECT id FROM terminals WHERE operator_id = $1 LIMIT 1`,
    [operator.rows[0].id],
  );
  const financeUser = await pool.query(
    `SELECT id FROM users WHERE external_id = 'operator-finance'`,
  );
  const batchId = crypto.randomUUID();
  const businessDay = '2040-01-02';
  let settlementId: string | undefined;

  try {
    await pool.query(
      `INSERT INTO batches(operator_id, terminal_id, batch_id, declared_count, processed_count, created_at)
       VALUES ($1, $2, $3, 2, 1, '2040-01-02T12:00:00Z')`,
      [operator.rows[0].id, terminal.rows[0].id, batchId],
    );
    const { SettlementService } = await import('../src/modules/settlement/settlement.service.js');
    const settlementService = new SettlementService();
    const settlement = await settlementService.run(operator.rows[0].id, businessDay, crypto.randomUUID());
    assert.ok(settlement.id);
    const currentSettlementId = String(settlement.id);
    settlementId = currentSettlementId;
    assert.equal(settlement.status, 'locked');
    assert.equal(Number(settlement.expected_tap_count), 2);
    assert.equal(Number(settlement.processed_tap_count), 1);

    await assert.rejects(
      settlementService.override(currentSettlementId, {
        operatorId: operator.rows[0].id,
        actorId: financeUser.rows[0].id,
        reason: '   ',
      }, crypto.randomUUID()),
      (error: unknown) => (error as { code?: string }).code === 'REASON_REQUIRED',
    );
    const approved = await settlementService.override(currentSettlementId, {
      operatorId: operator.rows[0].id,
      actorId: financeUser.rows[0].id,
      reason: 'Pilot terminal batch variance reviewed',
    }, crypto.randomUUID());
    assert.equal(approved.status, 'approved');
    assert.equal(approved.override_reason, 'Pilot terminal batch variance reviewed');
  } finally {
    if (settlementId) await pool.query('DELETE FROM settlements WHERE id = $1', [settlementId]);
    await pool.query('DELETE FROM batches WHERE batch_id = $1', [batchId]);
    await pool.end();
  }
});
