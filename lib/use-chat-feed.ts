'use client';

import { type CSSProperties, useCallback, useLayoutEffect, useRef, useState } from 'react';

// Messaging-app behaviour for a scrolling conversation:
// - follows new messages while the reader is at the bottom, and stops once they scroll up;
// - counts messages that arrive while they are away, for a "new messages" jump button;
// - animates only messages that arrive after the conversation opened, staggered when several land at once.
export function useChatFeed(keys: string[], resetKey: string, extra: unknown = null) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const lastTop = useRef(0);
  const shown = useRef(keys.length);
  const [unread, setUnread] = useState(0);
  const known = useRef<{ reset: string; seen: Set<string>; delays: Map<string, number> } | null>(null);

  if (!known.current || known.current.reset !== resetKey) {
    known.current = { reset: resetKey, seen: new Set(keys), delays: new Map() };
  }
  let batch = 0;
  for (const key of keys) {
    if (known.current.seen.has(key)) continue;
    known.current.seen.add(key);
    known.current.delays.set(key, Math.min(batch++, 6) * 140);
  }

  const onScroll = useCallback(() => {
    const feed = ref.current;
    if (!feed) return;
    const gap = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    if (gap < 48) {
      stuck.current = true;
      setUnread(0);
    } else if (feed.scrollTop < lastTop.current - 4) {
      // Only an upward scroll detaches; smooth auto-scrolling moves down and never unsticks.
      stuck.current = false;
    }
    lastTop.current = feed.scrollTop;
  }, []);

  // Opening a conversation starts at its latest message.
  useLayoutEffect(() => {
    const feed = ref.current;
    stuck.current = true;
    shown.current = keys.length;
    setUnread(0);
    if (feed) {
      feed.scrollTop = feed.scrollHeight;
      lastTop.current = feed.scrollTop;
    }
    // Only a conversation switch resets; keys are read for their current length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useLayoutEffect(() => {
    const feed = ref.current;
    const added = keys.length - shown.current;
    shown.current = keys.length;
    if (!feed) return;
    if (stuck.current) feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    else if (added > 0) setUnread((count) => count + added);
  }, [keys.length, extra]);

  const jump = useCallback(() => {
    const feed = ref.current;
    stuck.current = true;
    setUnread(0);
    feed?.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
  }, []);

  const enter = useCallback((key: string): { className: string; style?: CSSProperties } => {
    const delay = known.current?.delays.get(key);
    return delay === undefined ? { className: '' } : { className: ' enter', style: { animationDelay: delay + 'ms' } };
  }, []);

  return { ref, onScroll, unread, jump, enter };
}
