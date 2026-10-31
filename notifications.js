import { create } from 'zustand';
import api from '../utils/api';

/**
 * In-app notifications (Phase E.3).
 * Backend: GET/POST /api/notifications*
 */
export const useNotificationStore = create((set, get) => ({
  items: [],
  unread: 0,
  loading: false,
  error: null,

  /** Load from API */
  fetchNotifications: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get('/notifications', { params: { limit: 50 } });
      const data = res.data?.data || res.data || {};
      const items = data.notifications || data.items || [];
      const unread =
        typeof data.unread === 'number'
          ? data.unread
          : items.filter((n) => !n.read).length;
      set({ items, unread, loading: false });
      return { items, unread };
    } catch (e) {
      set({
        loading: false,
        error: e?.response?.data?.error || e?.message || 'Failed to load',
      });
      return null;
    }
  },

  /** Socket or push append */
  pushNotification: (n) => {
    if (!n?.id) return;
    set((state) => {
      if (state.items.some((x) => x.id === n.id)) return state;
      const items = [n, ...state.items].slice(0, 50);
      const unread = state.unread + (n.read ? 0 : 1);
      return { items, unread };
    });
  },

  markRead: async (id) => {
    if (!id) return;
    try {
      await api.post(`/notifications/${id}/read`);
    } catch (_) {}
    set((state) => {
      const items = state.items.map((n) =>
        n.id === id ? { ...n, read: true } : n
      );
      const unread = items.filter((n) => !n.read).length;
      return { items, unread };
    });
  },

  markAllRead: async () => {
    try {
      await api.post('/notifications/read-all');
    } catch (_) {}
    set((state) => ({
      items: state.items.map((n) => ({ ...n, read: true })),
      unread: 0,
    }));
  },

  clear: () => set({ items: [], unread: 0, error: null }),
}));
