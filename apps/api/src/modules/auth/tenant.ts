import { AuthContext } from './auth.types.js';

export function resolveOperatorId(auth: AuthContext | undefined, requestedOperatorId?: string): string {
  if (!auth) {
    throw Object.assign(new Error('Authentication required'), { status: 401, code: 'AUTHENTICATION_REQUIRED' });
  }
  if (auth.role === 'platform_admin' || auth.role === 'platform_finance' ||
      auth.role === 'platform_support' || auth.role === 'auditor') {
    if (!requestedOperatorId) {
      throw Object.assign(new Error('operatorId is required'), { status: 400, code: 'OPERATOR_ID_REQUIRED' });
    }
    return requestedOperatorId;
  }
  if (!auth.operatorId) {
    throw Object.assign(new Error('Operator scope is missing'), { status: 403, code: 'TENANT_SCOPE_MISSING' });
  }
  if (requestedOperatorId && requestedOperatorId !== auth.operatorId) {
    throw Object.assign(new Error('Cross-tenant access denied'), { status: 403, code: 'TENANT_MISMATCH' });
  }
  return auth.operatorId;
}
