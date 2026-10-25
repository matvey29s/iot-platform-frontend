import { create } from 'zustand';
import * as api from '../api/mockApi';

interface AuthState {
  token: string | null;
  mustChangePassword: boolean;
  error: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  clearMustChangePassword: () => void;
}

// DEV STUB: auto-authorized on load, no login screen. Set to `null` to
// restore the normal login flow (LoginPage is still fully implemented and
// reachable at /login, just not required to enter the app right now).
const AUTO_LOGIN_TOKEN: string | null = 'dev-auto-token';

export const useAuthStore = create<AuthState>((set) => ({
  token: AUTO_LOGIN_TOKEN,
  mustChangePassword: false,
  error: null,
  loading: false,

  async login(username, password) {
    set({ loading: true, error: null });
    const result = await api.login(username, password);
    if (result.ok) {
      set({ token: result.token!, mustChangePassword: !!result.mustChangePassword, loading: false });
      return true;
    }
    set({ error: result.error ?? 'Ошибка входа', loading: false });
    return false;
  },

  logout() {
    set({ token: null, mustChangePassword: false });
  },

  clearMustChangePassword() {
    set({ mustChangePassword: false });
  }
}));
