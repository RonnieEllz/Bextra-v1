export type BextraRole =
  | 'platform_admin'
  | 'platform_finance'
  | 'platform_support'
  | 'operator_admin'
  | 'operator_finance'
  | 'operator_fleet'
  | 'agent'
  | 'auditor'
  | 'customer';

export interface AuthContext {
  userId: string;
  externalId: string;
  role: BextraRole;
  operatorId: string | null;
  agentId?: string | null;
  cardToken?: string | null;
}
