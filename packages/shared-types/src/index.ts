export const Roles = ['ADMIN', 'OPERATOR', 'APPROVER', 'AUDITOR'] as const;
export type Role = (typeof Roles)[number];

export type Permission =
  | 'users:manage' | 'settings:manage' | 'providers:manage'
  | 'contacts:import' | 'contacts:read' | 'contacts:suppress'
  | 'campaigns:create' | 'campaigns:approve' | 'campaigns:control'
  | 'reports:read' | 'reports:export' | 'audit:read';

export const RolePermissions: Record<Role, Permission[]> = {
  ADMIN: ['users:manage', 'settings:manage', 'providers:manage', 'contacts:read', 'reports:read', 'audit:read'],
  OPERATOR: ['contacts:import', 'contacts:read', 'contacts:suppress', 'campaigns:create', 'campaigns:control', 'reports:read'],
  APPROVER: ['contacts:read', 'campaigns:approve', 'reports:read'],
  AUDITOR: ['contacts:read', 'reports:read', 'reports:export', 'audit:read'],
};

export const CampaignStatuses = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PROCESSING',
  'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED',
] as const;
export type CampaignStatus = (typeof CampaignStatuses)[number];

/** Allowed campaign transitions. Anything else must be rejected server-side. */
export const CampaignTransitions: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['PROCESSING', 'PAUSED', 'CANCELLED'],
  PROCESSING: ['PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  PAUSED: ['SCHEDULED', 'PROCESSING', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return CampaignTransitions[from].includes(to);
}

export type Channel = 'VOICE' | 'SMS';

/**
 * Normalised provider outcome. SUBMITTED/ACCEPTED/ANSWERED/COMPLETED are distinct:
 * ANSWERED does not mean the message was heard.
 */
export const OutcomeStatuses = [
  'SUBMITTED', 'PROVIDER_ACCEPTED', 'ANSWERED', 'COMPLETED', 'DELIVERED',
  'FAILED', 'UNCERTAIN', 'SKIPPED_SUPPRESSED', 'CANCELLED',
] as const;
export type OutcomeStatus = (typeof OutcomeStatuses)[number];

/** Rank used to ignore out-of-order provider events. Higher never regresses to lower. */
export const OutcomeRank: Record<OutcomeStatus, number> = {
  UNCERTAIN: 0, SUBMITTED: 1, PROVIDER_ACCEPTED: 2, ANSWERED: 3,
  COMPLETED: 4, DELIVERED: 4, FAILED: 5, CANCELLED: 5, SKIPPED_SUPPRESSED: 5,
};

export function shouldApplyOutcome(current: OutcomeStatus, incoming: OutcomeStatus): boolean {
  if (current === incoming) return false;
  if (OutcomeRank[current] >= 4 && current !== 'UNCERTAIN') return false; // terminal
  return OutcomeRank[incoming] > OutcomeRank[current];
}
