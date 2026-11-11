'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveConfig, LivePushSummary } from './live-types';

// Polls the live monitor. `arrival` changes whenever a push appears or starts reviewing after the page opened.
export function useLive(interval = 2000) {
  const [config, setConfig] = useState<LiveConfig>();
  const [pushes, setPushes] = useState<LivePushSummary[]>([]);
  const [arrival, setArrival] = useState<{ push: LivePushSummary; at: number }>();
  const seen = useRef<Map<string, string> | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/live', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json() as { config: LiveConfig; pushes: LivePushSummary[] };
      setConfig(data.config);
      setPushes(data.pushes);
      const before = seen.current;
      seen.current = new Map(data.pushes.map((push) => [push.id, push.status]));
      if (!before) return;
      const fresh = data.pushes
        .filter((push) => (!before.has(push.id) && push.status !== 'passed' && push.status !== 'failed') || (before.get(push.id) === 'queued' && push.status === 'running'))
        .sort((a, b) => a.receivedAt - b.receivedAt)[0];
      if (fresh) setArrival({ push: fresh, at: Date.now() });
    } catch {
      // The monitor is optional; the lab keeps working without it.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, interval);
    return () => clearInterval(timer);
  }, [load, interval]);

  return { config, pushes, arrival, refresh: load };
}
