import React, { createContext, useContext, useEffect, useState } from 'react';
import { Permission, Role, RolePermissions } from '@commhub/shared-types';
import { api, API_BASE, setAccessToken } from './api';

export interface User { id: string; email: string; name: string; role: Role; mfaEnabled?: boolean }

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string, mfaCode?: string) => Promise<{ mfaRequired?: boolean }>;
  logout: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        if (r.ok) {
          const d = await r.json();
          setAccessToken(d.accessToken);
          setUser(d.user);
        }
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string, mfaCode?: string) => {
    const d = await api<{ mfaRequired?: boolean; accessToken?: string; user?: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, mfaCode: mfaCode || undefined }),
    });
    if (d.mfaRequired) return { mfaRequired: true };
    setAccessToken(d.accessToken ?? null);
    setUser(d.user ?? null);
    return {};
  };

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    setUser(null);
  };

  const can = (p: Permission) => (user ? RolePermissions[user.role]?.includes(p) ?? false : false);

  return <Ctx.Provider value={{ user, loading, login, logout, can }}>{children}</Ctx.Provider>;
}
