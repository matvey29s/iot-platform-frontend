import { create } from 'zustand';
import * as api from '../api/mockApi';
import type { SystemInfo, SystemSample } from '../api/types';

/** Keep 15 minutes at the 3 s sampling period; older points are dropped. */
const MAX_POINTS = 300;

interface MetricsState {
  history: SystemSample[];
  latest: SystemInfo | null;
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
  started: false,

  start() {
    if (get().started) return;
    set({ started: true });
    api.fetchSystemHistory(15, 3).then((past) => {
      // live points that arrived during the fetch stay; backfill goes before them
      set((s) => ({ history: [...past, ...s.history.filter((p) => !past.length || p.sampledAt > past[past.length - 1].sampledAt)].slice(-MAX_POINTS) }));
    });
    api.fetchSystemInfo().then((info) => set({ latest: info }));
    api.subscribeLive((event) => {
      if (event.type !== 'system_info') return;
      set((s) => ({ latest: event.payload, history: [...s.history, toSample(event.payload)].slice(-MAX_POINTS) }));
    });
  }
}));
