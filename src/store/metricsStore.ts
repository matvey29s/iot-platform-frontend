import { create } from 'zustand';
import * as api from '../api';
import type { SystemInfo, SystemSample } from '../api/types';

/** Keep 15 minutes at the 3 s sampling period; older points are dropped. */
const MAX_POINTS = 300;

interface MetricsState {
  history: SystemSample[];
  latest: SystemInfo | null;
  /** true while the controller does not answer (daemon down / no network) */
  offline: boolean;
  started: boolean;
  start: () => void;
}

function toSample(i: SystemInfo): SystemSample {
  return { sampledAt: i.sampledAt, cpuUsagePercent: i.cpuUsagePercent, ramUsedMb: i.ramUsedMb, ramTotalMb: i.ramTotalMb };
}

/**
 * Lives outside the Monitoring page on purpose: history keeps accumulating
 * while the user is on another tab, so the charts never restart from empty.
 */
export const useMetricsStore = create<MetricsState>((set, get) => ({
  history: [],
  latest: null,
  offline: false,
  started: false,

  start() {
    if (get().started) return;
    set({ started: true });

    const backfill = () =>
      api.fetchSystemHistory(15, 3).then((past) => {
        // live points that arrived meanwhile stay; backfill goes before them
        set((s) => ({
          history: [...past, ...s.history.filter((p) => !past.length || p.sampledAt > past[past.length - 1].sampledAt)].slice(-MAX_POINTS)
        }));
      });
    const load = () =>
      api
        .fetchSystemInfo()
        .then((info) => set({ latest: info, offline: false }))
        .catch(() => set({ offline: true }));

    backfill();
    load();
    api.subscribeLive((event) => {
      if (event.type !== 'system_info') return;
      set((s) => ({ latest: event.payload, offline: false, history: [...s.history, toSample(event.payload)].slice(-MAX_POINTS) }));
    });
    // The controller answers at most every 3 s; if nothing arrived, keep asking
    // so the page recovers on its own when the daemon comes back.
    setInterval(() => {
      const last = get().latest;
      if (!last || Date.now() - last.sampledAt > 9000) load();
    }, 5000);
  }
}));
