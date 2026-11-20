import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { database } from '../../database.js';
import { AuthContext, BextraRole } from './auth.types.js';

@Injectable()
export class AuthService {
  async login(externalId: string, password: string) {
    if (!externalId?.trim() || !password) {
      throw Object.assign(new Error('External ID and password are required'), { status: 400, code: 'INVALID_CREDENTIALS' });
    }
    const user = await this.findUser(externalId.trim());
    if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      throw Object.assign(new Error('Invalid credentials'), { status: 401, code: 'INVALID_CREDENTIALS' });
    }
    return this.issueAccessToken(user, 'password');
  }

  async requestOtp(phone: string) {
    if (!/^\+[1-9]\d{7,14}$/.test(phone ?? '')) {
      throw Object.assign(new Error('A valid phone number in international format is required'), { status: 400, code: 'INVALID_PHONE' });
    }
    const user = await this.findUser(phone);
    if (!user || !['customer', 'agent'].includes(user.role)) {
      throw Object.assign(new Error('No mobile account is registered for this phone'), { status: 404, code: 'INVALID_CREDENTIALS' });
    }
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('OTP delivery is not configured for this deployment'), { status: 503, code: 'OTP_DELIVERY_UNAVAILABLE' });
    }
    const existing = await database.query(
      'SELECT resend_allowed_at FROM otp_challenges WHERE phone = $1',
      [phone],
    );
    if (existing.rowCount && new Date(existing.rows[0].resend_allowed_at).getTime() > Date.now()) {
      throw Object.assign(new Error('OTP resend is not allowed yet'), { status: 429, code: 'OTP_RESEND_NOT_ALLOWED' });
    }
    const code = '123456';
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const resendAllowedAt = new Date(Date.now() + 60_000);
    await database.query(
      `INSERT INTO otp_challenges(phone, code_hash, expires_at, resend_allowed_at, verified_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT(phone) DO UPDATE SET code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at, resend_allowed_at = EXCLUDED.resend_allowed_at,
         verified_at = NULL, created_at = now()`,
      [phone, await bcrypt.hash(code, 10), expiresAt, resendAllowedAt],
    );
    return { expiresAt: expiresAt.toISOString(), resendAllowedAt: resendAllowedAt.toISOString() };
  }

  async verifyOtp(phone: string, otp: string) {
    const challenge = await database.query(
      `SELECT code_hash, expires_at FROM otp_challenges WHERE phone = $1`,
      [phone],
    );
    if (!challenge.rowCount ||
        new Date(challenge.rows[0].expires_at).getTime() <= Date.now() ||
        !(await bcrypt.compare(otp ?? '', challenge.rows[0].code_hash))) {
      throw Object.assign(new Error('Invalid or expired OTP'), { status: 401, code: 'INVALID_OTP' });
    }
    const user = await this.findUser(phone);
    if (!user || !['customer', 'agent'].includes(user.role)) {
      throw Object.assign(new Error('No mobile account is registered for this phone'), { status: 401, code: 'INVALID_OTP' });
    }
    await database.query('UPDATE otp_challenges SET verified_at = now() WHERE phone = $1', [phone]);
    return this.issueAccessToken(user, 'otp');
  }

  async requestCustomerRegistrationOtp(input: {
    fullName?: unknown;
    phone?: unknown;
    gender?: unknown;
    email?: unknown;
    location?: unknown;
  } | undefined) {
    const profile = this.validateCustomerRegistration(input);
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('OTP delivery is not configured for this deployment'), { status: 503, code: 'OTP_DELIVERY_UNAVAILABLE' });
    }

    await this.cleanupExpiredCustomerRegistrations();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    const resendAllowedAt = new Date(now.getTime() + 60_000);
    const codeHash = await bcrypt.hash('123456', 10);
    const phoneHash = createHash('sha256').update(profile.phone).digest('hex');
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`customer-registration:${phoneHash}`]);
      const rate = await client.query(
        `SELECT window_started_at, request_count, resend_allowed_at
         FROM customer_registration_rate_limits WHERE phone_hash = $1 FOR UPDATE`,
        [phoneHash],
      );
      if (rate.rowCount) {
        const withinWindow = new Date(rate.rows[0].window_started_at).getTime() > now.getTime() - 15 * 60_000;
        if (withinWindow && new Date(rate.rows[0].resend_allowed_at).getTime() > now.getTime()) {
          throw Object.assign(new Error('OTP resend is not allowed yet'), { status: 429, code: 'OTP_RESEND_NOT_ALLOWED' });
        }
        if (withinWindow && Number(rate.rows[0].request_count) >= 3) {
          throw Object.assign(new Error('OTP request limit reached'), { status: 429, code: 'OTP_RATE_LIMITED' });
        }
        await client.query(
          `UPDATE customer_registration_rate_limits
           SET window_started_at = CASE WHEN $2 THEN $3 ELSE window_started_at END,
               request_count = CASE WHEN $2 THEN 1 ELSE request_count + 1 END,
               resend_allowed_at = $4
           WHERE phone_hash = $1`,
          [phoneHash, !withinWindow, now, resendAllowedAt],
        );
      } else {
        await client.query(
          `INSERT INTO customer_registration_rate_limits(phone_hash, window_started_at, request_count, resend_allowed_at)
           VALUES ($1, $2, 1, $3)`,
          [phoneHash, now, resendAllowedAt],
        );
      }

      await client.query(
        `INSERT INTO customer_registration_challenges
           (phone, full_name, gender, email, location, code_hash, expires_at, resend_allowed_at, attempt_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
         ON CONFLICT(phone) DO UPDATE SET
           full_name = EXCLUDED.full_name,
           gender = EXCLUDED.gender,
           email = EXCLUDED.email,
           location = EXCLUDED.location,
           code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           resend_allowed_at = EXCLUDED.resend_allowed_at,
           attempt_count = 0,
           created_at = now()`,
        [profile.phone, profile.fullName, profile.gender, profile.email, profile.location,
          codeHash, expiresAt, resendAllowedAt],
      );
      await client.query('COMMIT');
      return { expiresAt: expiresAt.toISOString(), resendAllowedAt: resendAllowedAt.toISOString() };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyCustomerRegistrationOtp(phoneInput: unknown, otpInput: unknown) {
    const phone = this.normalizePhone(phoneInput);
    if (typeof otpInput !== 'string' || !/^\d{6}$/.test(otpInput)) {
      throw Object.assign(new Error('A six-digit OTP is required'), { status: 400, code: 'INVALID_OTP' });
    }
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('OTP delivery is not configured for this deployment'), { status: 503, code: 'OTP_DELIVERY_UNAVAILABLE' });
    }

    await this.cleanupExpiredCustomerRegistrations();
    const client = await database.connect();
    let response: { accessToken: string; auth: AuthContext } | undefined;
    let failure: Error & { status?: number; code?: string } | undefined;
    try {
      await client.query('BEGIN');
      const challenge = await client.query(
        `SELECT full_name, gender, email, location, code_hash, expires_at, attempt_count
         FROM customer_registration_challenges WHERE phone = $1 FOR UPDATE`,
        [phone],
      );
      if (!challenge.rowCount || new Date(challenge.rows[0].expires_at).getTime() <= Date.now()) {
        if (challenge.rowCount) {
          await client.query('DELETE FROM customer_registration_challenges WHERE phone = $1', [phone]);
        }
        failure = Object.assign(new Error('Invalid or expired OTP'), { status: 401, code: 'INVALID_OTP' });
      } else if (Number(challenge.rows[0].attempt_count) >= 5) {
        failure = Object.assign(new Error('OTP verification limit reached'), { status: 429, code: 'OTP_ATTEMPTS_EXCEEDED' });
      } else if (!(await bcrypt.compare(otpInput, challenge.rows[0].code_hash))) {
        const attempts = Number(challenge.rows[0].attempt_count) + 1;
        await client.query(
          'UPDATE customer_registration_challenges SET attempt_count = $2 WHERE phone = $1',
          [phone, attempts],
        );
        failure = Object.assign(
          new Error(attempts >= 5 ? 'OTP verification limit reached' : 'Invalid or expired OTP'),
          { status: attempts >= 5 ? 429 : 401, code: attempts >= 5 ? 'OTP_ATTEMPTS_EXCEEDED' : 'INVALID_OTP' },
        );
      } else {
        const operatorId = process.env.CUSTOMER_REGISTRATION_OPERATOR_ID;
        if (!operatorId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operatorId)) {
          failure = Object.assign(new Error('Customer registration operator is not configured'), {
            status: 503,
            code: 'CUSTOMER_REGISTRATION_UNAVAILABLE',
          });
        } else {
          const operator = await client.query(
            `SELECT id FROM operators WHERE id = $1 AND status = 'active'`,
            [operatorId],
          );
          if (!operator.rowCount) {
            failure = Object.assign(new Error('Customer registration operator is not configured'), {
              status: 503,
              code: 'CUSTOMER_REGISTRATION_UNAVAILABLE',
            });
          } else {
            const duplicate = await client.query(
              `SELECT 1 FROM users WHERE external_id = $1
               UNION ALL SELECT 1 FROM customers WHERE phone = $1 LIMIT 1`,
              [phone],
            );
            if (duplicate.rowCount) {
              await client.query('DELETE FROM customer_registration_challenges WHERE phone = $1', [phone]);
              failure = Object.assign(new Error('A customer account already exists for this phone'), {
                status: 409,
                code: 'PHONE_ALREADY_REGISTERED',
              });
            } else {
              const customer = await client.query(
                `INSERT INTO customers(operator_id, external_ref, pseudonym, phone, full_name, gender, email, location)
                 VALUES ($1, $2, $3, $2, $4, $5, $6, $7)
                 RETURNING id`,
                [operatorId, phone, `customer-${randomUUID()}`, challenge.rows[0].full_name,
                  challenge.rows[0].gender, challenge.rows[0].email, challenge.rows[0].location],
              );
              await client.query(
                `INSERT INTO accounts(operator_id, code, name, account_type, customer_id)
                 VALUES ($1, 'CUSTOMER_WALLET', 'Customer Wallet', 'customer_wallet', $2)`,
                [operatorId, customer.rows[0].id],
              );
              const user = await client.query(
                `INSERT INTO users(operator_id, role_id, external_id, status, customer_id)
                 SELECT $1, id, $2, 'active', $3 FROM roles WHERE name = 'customer'
                 RETURNING id, external_id, operator_id, customer_id`,
                [operatorId, phone, customer.rows[0].id],
              );
              if (!user.rowCount) throw new Error('Customer role is not configured');
              await client.query('DELETE FROM customer_registration_challenges WHERE phone = $1', [phone]);
              response = this.issueAccessToken({
                id: user.rows[0].id,
                external_id: user.rows[0].external_id,
                operator_id: user.rows[0].operator_id,
                password_hash: null,
                auth_version: 0,
                role: 'customer',
                agent_id: null,
                card_token: null,
              }, 'otp');
            }
          }
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        throw Object.assign(new Error('A customer account already exists for this phone'), {
          status: 409,
          code: 'PHONE_ALREADY_REGISTERED',
        });
      }
      throw error;
    } finally {
      client.release();
    }
    if (failure) throw failure;
    if (!response) throw new Error('Customer registration completed without an authentication response');
    return response;
  }

  private validateCustomerRegistration(input: {
    fullName?: unknown;
    phone?: unknown;
    gender?: unknown;
    email?: unknown;
    location?: unknown;
  } | undefined) {
    const fullName = typeof input?.fullName === 'string'
      ? input.fullName.trim().replace(/\s+/g, ' ')
      : '';
    const phone = this.normalizePhone(input?.phone);
    const genderInput = input?.gender;
    const emailInput = input?.email;
    const locationInput = input?.location;
    if (!fullName || fullName.length > 120 || /[\u0000-\u001f\u007f]/.test(fullName)) {
      throw Object.assign(new Error('Full name is required and must be at most 120 characters'), { status: 400, code: 'INVALID_FULL_NAME' });
    }
    if (genderInput !== undefined && genderInput !== null && typeof genderInput !== 'string') {
      throw Object.assign(new Error('Gender must be a string'), { status: 400, code: 'INVALID_GENDER' });
    }
    const gender = typeof genderInput === 'string' ? genderInput.trim().replace(/\s+/g, ' ') || null : null;
    if (gender && (gender.length > 40 || /[\u0000-\u001f\u007f]/.test(gender))) {
      throw Object.assign(new Error('Gender must be at most 40 characters'), { status: 400, code: 'INVALID_GENDER' });
    }
    if (emailInput !== undefined && emailInput !== null && typeof emailInput !== 'string') {
      throw Object.assign(new Error('Email must be a string'), { status: 400, code: 'INVALID_EMAIL' });
    }
    const email = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() || null : null;
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      throw Object.assign(new Error('A valid email address is required'), { status: 400, code: 'INVALID_EMAIL' });
    }
    if (locationInput !== undefined && locationInput !== null && typeof locationInput !== 'string') {
      throw Object.assign(new Error('Location must be a string'), { status: 400, code: 'INVALID_LOCATION' });
    }
    const location = typeof locationInput === 'string' ? locationInput.trim().replace(/\s+/g, ' ') || null : null;
    if (location && (location.length > 120 || /[\u0000-\u001f\u007f]/.test(location))) {
      throw Object.assign(new Error('Location must be at most 120 characters'), { status: 400, code: 'INVALID_LOCATION' });
    }
    return { fullName, phone, gender, email, location };
  }

  private normalizePhone(value: unknown) {
    if (typeof value !== 'string') {
      throw Object.assign(new Error('A valid phone number in international format is required'), { status: 400, code: 'INVALID_PHONE' });
    }
    const phone = value.trim().replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      throw Object.assign(new Error('A valid phone number in international format is required'), { status: 400, code: 'INVALID_PHONE' });
    }
    return phone;
  }

  async cleanupExpiredCustomerRegistrations() {
    await database.query(
      `DELETE FROM customer_registration_challenges WHERE expires_at <= now()`,
    );
    await database.query(
      `DELETE FROM customer_registration_rate_limits
       WHERE window_started_at < now() - interval '1 day'`,
    );
  }

  async completeAgentSetup(setupToken: string, password: string, pin: string) {
    if (typeof setupToken !== 'string' || setupToken.length < 32 || setupToken.length > 128) {
      throw Object.assign(new Error('Invalid or expired agent invitation'), { status: 401, code: 'INVALID_AGENT_INVITATION' });
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 128 ||
        !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      throw Object.assign(new Error('Password must be 12-128 characters and include a letter and a number'), { status: 400, code: 'INVALID_PASSWORD' });
    }
    if (!/^\d{4}$/.test(pin ?? '')) {
      throw Object.assign(new Error('Agent PIN must contain exactly 4 digits'), { status: 400, code: 'INVALID_AGENT_PIN' });
    }

    const tokenHash = createHash('sha256').update(setupToken).digest('hex');
    const [passwordHash, pinHash] = await Promise.all([
      bcrypt.hash(password, 12),
      bcrypt.hash(pin, 10),
    ]);
    const client = await database.connect();
    let phone: string | undefined;
    try {
      await client.query('BEGIN');
      const invite = await client.query(
        `SELECT id, external_id FROM agents
         WHERE invitation_token_hash = $1 AND invitation_expires_at > now()
         FOR UPDATE`,
        [tokenHash],
      );
      if (!invite.rowCount) {
        throw Object.assign(new Error('Invalid or expired agent invitation'), { status: 401, code: 'INVALID_AGENT_INVITATION' });
      }
      phone = invite.rows[0].external_id;
      const user = await client.query(
        `UPDATE users SET password_hash = $1, status = 'active'
         WHERE agent_id = $2 AND external_id = $3
         RETURNING id`,
        [passwordHash, invite.rows[0].id, phone],
      );
      if (!user.rowCount) {
        throw Object.assign(new Error('Agent account is not configured'), { status: 409, code: 'AGENT_ACCOUNT_NOT_CONFIGURED' });
      }
      await client.query(
        `UPDATE agents SET pin_hash = $1, status = 'active',
           invitation_token_hash = NULL, invitation_expires_at = NULL
         WHERE id = $2`,
        [pinHash, invite.rows[0].id],
      );
      await client.query(
        `INSERT INTO audit_log(actor_id, actor_role, operator_id, action, details)
         SELECT u.id, 'agent', a.operator_id, 'agent_setup_completed',
                jsonb_build_object('agentId', a.id)
         FROM agents a JOIN users u ON u.agent_id = a.id
         WHERE a.id = $1`,
        [invite.rows[0].id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (!phone) {
      throw Object.assign(new Error('Agent account could not be loaded'), { status: 500, code: 'AUTH_CONFIGURATION_ERROR' });
    }
    const user = await this.findUser(phone);
    if (!user) {
      throw Object.assign(new Error('Agent account could not be loaded'), { status: 500, code: 'AUTH_CONFIGURATION_ERROR' });
    }
    return this.issueAccessToken(user, 'password');
  }

  async verifyAgentPin(auth: AuthContext, agentId: string, pin: string) {
    if (!auth.agentId || auth.agentId !== agentId) {
      throw Object.assign(new Error('Agent access denied'), { status: 403, code: 'FORBIDDEN' });
    }
    const result = await database.query(
      'SELECT pin_hash FROM agents WHERE id = $1 AND status = $2',
      [agentId, 'active'],
    );
    if (!result.rowCount || !result.rows[0].pin_hash ||
        !(await bcrypt.compare(pin ?? '', result.rows[0].pin_hash))) {
      throw Object.assign(new Error('Invalid agent PIN'), { status: 401, code: 'INVALID_AGENT_PIN' });
    }
    const secret = this.secret();
    const stepUpToken = jwt.sign(
      {
        userId: auth.userId,
        externalId: auth.externalId,
        role: auth.role,
        operatorId: auth.operatorId,
        agentId: auth.agentId,
        cardToken: auth.cardToken,
        purpose: 'agent_topup',
        stepUp: true,
      },
      secret,
      { issuer: 'bextra-api', audience: 'bextra-clients', expiresIn: '10m', subject: auth.userId },
    );
    const decoded = jwt.decode(stepUpToken) as { exp: number };
    return { stepUpToken, expiresAt: new Date(decoded.exp * 1000).toISOString() };
  }

  private async findUser(externalId: string) {
    const result = await database.query(
      `SELECT u.id, u.external_id, u.operator_id, u.password_hash, u.auth_version, r.name AS role,
              COALESCE(u.agent_id, a.id) AS agent_id,
              COALESCE(u.customer_id, c.id) AS customer_id,
              card.card_token
       FROM users u JOIN roles r ON r.id = u.role_id
       LEFT JOIN agents a ON a.external_id = u.external_id
       LEFT JOIN customers c ON c.id = u.customer_id
       LEFT JOIN LATERAL (
         SELECT ca.card_token FROM cards ca
         WHERE ca.customer_id = COALESCE(u.customer_id, c.id)
         ORDER BY (ca.card_token = 'CARD-1001') DESC, ca.created_at, ca.card_token LIMIT 1
       ) card ON true
       WHERE u.external_id = $1 AND u.status = 'active'`,
      [externalId],
    );
    return result.rows[0] as {
      id: string;
      external_id: string;
      operator_id: string | null;
      password_hash: string | null;
      auth_version: number;
      role: BextraRole;
      agent_id: string | null;
      card_token: string | null;
    } | undefined;
  }

  private issueAccessToken(user: NonNullable<Awaited<ReturnType<AuthService['findUser']>>>, authMethod: 'password' | 'otp') {
    const auth: AuthContext = {
      userId: user.id,
      externalId: user.external_id,
      role: user.role,
      operatorId: user.operator_id,
      agentId: user.agent_id,
      cardToken: user.card_token,
    };
    const accessToken = jwt.sign(
      { ...auth, authMethod, authVersion: user.auth_version },
      this.secret(),
      { issuer: 'bextra-api', audience: 'bextra-clients', expiresIn: '8h', subject: user.id },
    );
    return { accessToken, auth };
  }

  private secret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw Object.assign(new Error('JWT secret is not configured'), { status: 500, code: 'AUTH_CONFIGURATION_ERROR' });
    return secret;
  }
}

export function verifyRecentCustomerStepUp(token: string, userId: string) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw Object.assign(new Error('JWT secret is not configured'), { status: 500, code: 'AUTH_CONFIGURATION_ERROR' });
  try {
    const payload = jwt.verify(token, secret, { issuer: 'bextra-api', audience: 'bextra-clients' }) as jwt.JwtPayload;
    return payload.sub === userId && payload.authMethod === 'otp' &&
      typeof payload.iat === 'number' && Date.now() - payload.iat * 1000 <= 5 * 60_000;
  } catch {
    return false;
  }
}

export function verifyAgentStepUpToken(token: string, userId: string, agentId: string) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw Object.assign(new Error('JWT secret is not configured'), { status: 500, code: 'AUTH_CONFIGURATION_ERROR' });
  try {
    const payload = jwt.verify(token, secret, { issuer: 'bextra-api', audience: 'bextra-clients' }) as jwt.JwtPayload;
    return payload.sub === userId && payload.agentId === agentId &&
      payload.purpose === 'agent_topup' && payload.stepUp === true;
  } catch {
    return false;
  }
}
