'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { timeline, type Msg } from './agents';

type DraftMessage = Omit<Msg, 'id' | 'time'>;

/** Owns the presentation timeline independently of user messages. */
export function useSimulation() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [running, setIsRunning] = useState(false);
  const [step, setStep] = useState(0);
  const [runId, setRunId] = useState(0);
  const [activeAgent, setActiveAgent] = useState('');
  const [pendingDirective, setPendingDirective] = useState(false);
  const [approved, setApproved] = useState<boolean | null>(null);
  const messageId = useRef(0);
  const runVersion = useRef(0);
  const approvalChosen = useRef(false);

  function stamp(draft: DraftMessage): Msg {
    return {
      ...draft,
      id: ++messageId.current,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
  }

  useEffect(() => {
    if (!running || step >= timeline.length) return;

    let postTimer: ReturnType<typeof setTimeout> | undefined;
    const typingTimer = setTimeout(
      () => {
        const draft = timeline[step];
        setActiveAgent(draft.agent);
        postTimer = setTimeout(() => {
          setMessages((current) => [...current, stamp(draft)]);
          setActiveAgent('');
          setStep((current) => current + 1);
          if (step === timeline.length - 1) setIsRunning(false);
        }, 650);
      },
      step === 0 ? 300 : 1550,
    );

    // Pausing, resetting and unmounting all cancel both pending callbacks.
    return () => {
      clearTimeout(typingTimer);
      clearTimeout(postTimer);
    };
  }, [running, step, runId]);

  const stats = useMemo(
    () => ({
      attacks: messages.filter((message) => message.squad === 'red' && message.status)
        .length,
      caught: messages.filter((message) => message.agent === 'Sentinel').length,
      patched: messages.some((message) => message.agent === 'Patch Engineer') ? 1 : 0,
    }),
    [messages],
  );

  function reset() {
    runVersion.current += 1;
    setRunId((current) => current + 1);
    approvalChosen.current = false;
    setMessages([]);
    setApproved(null);
    setActiveAgent('');
    setPendingDirective(false);
    setStep(0);
    setIsRunning(true);
  }

  function setRunning(next: boolean) {
    if (next && step >= timeline.length) reset();
    else setIsRunning(next);
    if (!next) setActiveAgent('');
  }

  function choose(allowFreeze: boolean) {
    if (approvalChosen.current) return;
    approvalChosen.current = true;
    setApproved(allowFreeze);
    setMessages((current) => [
      ...current,
      stamp({
        agent: 'You',
        squad: 'you',
        text: allowFreeze
          ? 'Approved — freeze the route.'
          : 'Keep the route live. Apply the ownership rule in place.',
      }),
      stamp({
        agent: 'Containment',
        squad: 'blue',
        status: 'success',
        text: allowFreeze
          ? 'Route frozen. Existing sessions drained safely.'
          : 'Understood. Route remains live while Patch Engineer applies the scoped rule.',
      }),
    ]);
  }

  async function sendDirective(directive: string) {
    const version = runVersion.current;
    setMessages((current) => [
      ...current,
      stamp({ agent: 'You', squad: 'you', text: directive }),
    ]);
    setPendingDirective(true);
    let reply = `I’m following ${stats.attacks} attempts and ${stats.caught} detections. Your directive is noted: “${directive}”.`;

    try {
      const response = await fetch('/api/directive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: directive,
          context: `${stats.attacks} attempts, ${stats.caught} caught, ${stats.patched} patched`,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (response.ok) {
        const result = await response.json();
        if (typeof result.text === 'string') reply = result.text;
      }
    } catch {
      // A local response keeps the conversation usable when offline.
    }

    if (version !== runVersion.current) return;
    setMessages((current) => [
      ...current,
      stamp({ agent: 'Director', squad: 'neutral', text: reply }),
    ]);
    setPendingDirective(false);
  }

  return {
    messages,
    running,
    typing: pendingDirective ? 'Director' : activeAgent,
    approved,
    stats,
    reset,
    setRunning,
    choose,
    sendDirective,
  };
}
