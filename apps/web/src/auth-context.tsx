import React, { createContext, useContext, useEffect, useState } from 'react';
import { Permission, Role, RolePermissions } from '@commhub/shared-types';
import { api, API_BASE, setAccessToken } from './api';

export interface User { id: string; email: string; name: string; role: Role; mfaEnabled?: boolean }

export const DIRECT_ADMIN_USER: User = {
  id: 'admin-direct',
  email: 'admin@demo.local',
  name: 'Administrator',
  role: 'ADMIN' as Role,
};

interface AuthCtx {
  user: User;
  loading: boolean;
  login: (email?: string, password?: string, mfaCode?: string) => Promise<{ mfaRequired?: boolean }>;
  logout: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User>(DIRECT_ADMIN_USER);
  const [loading] = useState(false);

  useEffect(() => {
    // Silently obtain fresh bearer token for direct admin operations without prompting the user
    fetch(`${API_BASE}/api/auth/auto-token`, { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        if (r.ok) {
          const d = await r.json();
          if (d.accessToken) setAccessToken(d.accessToken);
          if (d.user) setUser(d.user);
        }
      })
      .catch(() => undefined);
  }, []);

  const login = async () => ({});
  const logout = async () => undefined;
  const can = (_p: Permission) => true; // Direct access gives full permission across all sections

  return <Ctx.Provider value={{ user, loading, login, logout, can }}>{children}</Ctx.Provider>;
}
