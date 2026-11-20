const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export interface AuthContext {
  userId: string;
  externalId: string;
  role: string;
  operatorId: string | null;
}

export interface Session {
  accessToken: string;
  auth: AuthContext;
}

export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const stored = sessionStorage.getItem('bextra-session');
  const session = stored ? JSON.parse(stored) as Session : null;
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (session?.accessToken) headers.set('authorization', `Bearer ${session.accessToken}`);
  headers.set('x-request-id', crypto.randomUUID());
  if (!headers.has('x-idempotency-key') && init.method && init.method !== 'GET') {
    headers.set('x-idempotency-key', crypto.randomUUID());
  }

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as { detail?: string; title?: string; code?: string };
    throw new ApiError(
      error.detail ?? error.title ?? error.code ?? `Request failed (${response.status})`,
      error.code,
      response.status,
    );
  }
  return body as T;
}
