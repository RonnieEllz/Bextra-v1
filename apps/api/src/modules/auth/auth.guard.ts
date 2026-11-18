import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { ROLES_KEY } from './auth.decorator.js';
import { AuthContext, BextraRole } from './auth.types.js';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly reflector = new Reflector();

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<BextraRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined>; auth?: AuthContext }>();
    const authorizationHeader = request.headers.authorization;
    const authorization = typeof authorizationHeader === 'string' ? authorizationHeader : undefined;
    if (!authorization?.startsWith('Bearer ')) {
      throw Object.assign(new Error('Authentication required'), { status: 401, code: 'AUTHENTICATION_REQUIRED' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw Object.assign(new Error('JWT secret is not configured'), { status: 500, code: 'AUTH_CONFIGURATION_ERROR' });
    }

    let payload: AuthContext;
    try {
      payload = jwt.verify(authorization.slice(7), secret, {
        issuer: 'bextra-api',
        audience: 'bextra-clients',
      }) as unknown as AuthContext;
    } catch {
      throw Object.assign(new Error('Invalid or expired access token'), { status: 401, code: 'INVALID_ACCESS_TOKEN' });
    }

    if (!payload.userId || !payload.role) {
      throw Object.assign(new Error('Invalid access token payload'), { status: 401, code: 'INVALID_ACCESS_TOKEN' });
    }
    if (requiredRoles?.length && !requiredRoles.includes(payload.role)) {
      throw Object.assign(new Error('Insufficient permissions'), { status: 403, code: 'FORBIDDEN' });
    }
    request.auth = payload;
    return true;
  }
}
