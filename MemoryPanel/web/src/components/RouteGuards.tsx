/**
 * RouteGuards — Route-level permission guards
 *
 * - ResourceGuard: admin role accessing resource page → redirect to workbench
 * - MemberManageGuard: member role accessing member management page → redirect to workbench
 */
import { type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';

/** Resource management page guard: admin not visible */
export function ResourceGuard({ children }: { children: ReactNode }) {
  const role = useCurrentRole();
  const navigate = useNavigate();
  const blocked = role === 'admin';

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}

/** Member management guard: reviewer cannot see (admin / member can see). */
 *  member can view the member list, add existing members, but creating new members/deleting members/creating and deleting Teams
 The button is converged by role inside TeamManagementPanel. */
export function MemberManageGuard({ children, allowedRoles }: {
  children: ReactNode;
  allowedRoles?: TeamRole[];
}) {
  const role = useCurrentRole();
  const navigate = useNavigate();
  const allowed = allowedRoles ?? ['admin', 'member'];
  const blocked = role !== null && !allowed.includes(role);

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}
