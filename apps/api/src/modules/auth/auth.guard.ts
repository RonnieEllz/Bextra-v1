import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { database } from '../../database.js';
import { ROLES_KEY } from './auth.decorator.js';
import { AuthContext, BextraRole } from './auth.types.js';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly reflector = new Reflector();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<BextraRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      auth?: AuthContext;
      stepUp?: boolean;
    }>();
    const authorizationHeader = request.headers.authorization;
    const authorization = typeof authorizationHeader === 'string' ? authorizationHeader : undefined;
    if (!authorization?.startsWith('Bearer ')) {
      throw Object.assign(new Error('Authentication required'), { status: 401, code: 'UNAUTHORIZED' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw Object.assign(new Error('JWT secret is not configured'), { status: 500, code: 'AUTH_CONFIGURATION_ERROR' });
    }

    let payload: AuthContext & { purpose?: string; stepUp?: boolean; authVersion?: number };
    try {
      payload = jwt.verify(authorization.slice(7), secret, {
        issuer: 'bextra-api',
        audience: 'bextra-clients',
      }) as unknown as AuthContext & { purpose?: string; stepUp?: boolean };
    } catch {
      throw Object.assign(new Error('Invalid or expired access token'), { status: 401, code: 'UNAUTHORIZED' });
    }

    if (!payload.userId || !payload.role) {
      throw Object.assign(new Error('Invalid access token payload'), { status: 401, code: 'UNAUTHORIZED' });
    }
    const user = await database.query(
      `SELECT status, auth_version FROM users WHERE id = $1`,
      [payload.userId],
    );
    const tokenVersion = payload.authVersion ?? 0;
    if (!user.rowCount || user.rows[0].status !== 'active' ||
        !Number.isSafeInteger(tokenVersion) || tokenVersion !== user.rows[0].auth_version) {
      throw Object.assign(new Error('Account is inactive'), { status: 401, code: 'UNAUTHORIZED' });
    }
    if (requiredRoles?.length && !requiredRoles.includes(payload.role)) {
      throw Object.assign(new Error('Insufficient permissions'), { status: 403, code: 'FORBIDDEN' });
    }
    request.auth = payload;
    request.stepUp = payload.stepUp === true && payload.purpose === 'agent_topup';
    return true;
  }
}
