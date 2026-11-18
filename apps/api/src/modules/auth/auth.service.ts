import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { database } from '../../database.js';
import { AuthContext, BextraRole } from './auth.types.js';

@Injectable()
export class AuthService {
  async login(externalId: string, password: string): Promise<{ accessToken: string; auth: AuthContext }> {
    if (!externalId?.trim() || !password) {
      throw Object.assign(new Error('External ID and password are required'), { status: 400, code: 'INVALID_CREDENTIALS' });
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw Object.assign(new Error('JWT secret is not configured'), { status: 500, code: 'AUTH_CONFIGURATION_ERROR' });
    }

    const result = await database.query(
      `SELECT u.id, u.external_id, u.operator_id, u.password_hash, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.external_id = $1 AND u.status = 'active'`,
      [externalId.trim()],
    );
    if (!result.rowCount) {
      throw Object.assign(new Error('Invalid credentials'), { status: 401, code: 'INVALID_CREDENTIALS' });
    }
    const user = result.rows[0];
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      throw Object.assign(new Error('Invalid credentials'), { status: 401, code: 'INVALID_CREDENTIALS' });
    }

    const auth: AuthContext = {
      userId: user.id,
      externalId: user.external_id,
      role: user.role as BextraRole,
      operatorId: user.operator_id,
    };
    const accessToken = jwt.sign(auth, secret, {
      issuer: 'bextra-api',
      audience: 'bextra-clients',
      expiresIn: '8h',
      subject: user.id,
    });
    return { accessToken, auth };
  }
}
