'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, ExternalLink, FileText } from 'lucide-react';
import type { Squad } from '../lib/agents';
import type { LiveFinding, LivePush } from '../lib/live-types';
import { useChatFeed } from '../lib/use-chat-feed';
import { Avatar } from './agent-identity';

const statusText = { queued: 'Queued', running: 'Reviewing', passed: 'Passed', failed: 'Failed', error: 'Error' } as const;

function Findings({ title, items }: { title: string; items: LiveFinding[] }) {
  if (!items.length) return null;
  return (
    <div className="pushFindings">
      <b>{title}</b>
      <ul>
        {items.slice(0, 8).map((item) => (
          <li key={item.file + item.line + item.title}>
            <span className={'live-sev ' + item.severity.toLowerCase()}>{item.severity}</span> {item.title} <code>{item.file}:{item.line}</code>
          </li>
        ))}
        {items.length > 8 && <li>…and {items.length - 8} more</li>}
      </ul>
    </div>
  );
}

// One push, told as a conversation: GitHub announces it, the agents review it, the Director gives the verdict.
export function PushFeed({ id, filter }: { id: string; filter: (agent: string, squad: Squad) => boolean }) {
  const [push, setPush] = useState<LivePush>();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch('/api/live?id=' + id, { cache: 'no-store' });
        if (response.ok && alive) {
          const data = await response.json() as { push: LivePush };
          setPush(data.push);
          const settled = (data.push.status === 'passed' || data.push.status === 'failed' || data.push.status === 'error')
            && data.push.updates.some((update) => update.agent === 'Director' && update.text.startsWith('Verdict'));
          if (settled) return;
        }
      } catch {
        // Retried below.
      }
      if (alive) timer = setTimeout(load, 1500);
    }
    setPush(undefined);
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [id]);

  const messages = push ? [
    { key: 'intro', agent: 'GitHub', squad: 'neutral' as Squad, text: (push.author || 'Someone') + ' pushed “' + (push.message || 'a commit') + '” to ' + push.repo + '@' + push.branch + ' (' + push.sha.slice(0, 7) + ').' },
    ...push.updates.map((update, index) => ({ key: String(index), agent: update.agent, squad: update.squad as Squad, text: update.text })),
  ].filter((message) => message.key === 'intro' || filter(message.agent, message.squad)) : [];
  const working = push && (push.status === 'queued' || push.status === 'running' || !push.updates.some((u) => u.text.startsWith('Verdict')));
  const typing = !push ? '' : push.status === 'queued' ? 'Director' : working ? (push.updates.at(-1)?.agent ?? 'Scout') : '';
  const { ref, onScroll, unread, jump, enter } = useChatFeed(messages.map((m) => m.key), id, typing);
  const done = push && !working;

  return (
    <>
      <div className="feed pushFeed" ref={ref} onScroll={onScroll}>
        {push && (
          <div className="pushHead">
            <span className={'live-pill ' + push.status}>{statusText[push.status]}</span>
            <div>
              <b>{push.message || '(no message)'}</b>
              <small>{push.repo}@{push.branch} · <code>{push.sha.slice(0, 7)}</code>{push.author && ' · ' + push.author}</small>
            </div>
          </div>
        )}
        {!push && <p className="live-muted">Loading the push…</p>}
        {messages.map((m, i) => {
          const animation = enter(m.key);
          return (
            <div className={`message ${m.squad}${i > 0 && messages[i - 1].agent === m.agent ? ' continued' : ''}${animation.className}`} style={animation.style} key={m.key}>
              <div className="rail">{(i === 0 || messages[i - 1].agent !== m.agent) && <Avatar name={m.agent} squad={m.squad} />}</div>
              <div className="bubble">
                {(i === 0 || messages[i - 1].agent !== m.agent) && <div className="meta"><b>{m.agent}</b></div>}
                <p>{m.text}</p>
              </div>
            </div>
          );
        })}
        {typing && (
          <div className="typing enter">
            <Avatar name={typing} squad={typing === 'Director' ? 'neutral' : typing === 'Patch Engineer' || typing === 'Triage' ? 'blue' : typing === 'Verifier' ? 'neutral' : 'red'} />
            <span><b>{typing}</b> {push?.status === 'queued' ? 'is waiting for the reviewer' : 'is working'}<i /><i /><i /></span>
          </div>
        )}
        {done && push.summary && (
          <div className={'pushSummary enter ' + push.status}>
            <Findings title={push.summary.baseline ? 'Baseline' : 'Introduced by this push'} items={push.summary.baseline ? [] : push.summary.introduced} />
            <Findings title="Fixed by this push" items={push.summary.fixed} />
            {push.summary.baseline && <p>{push.summary.total} finding(s) recorded as this branch’s baseline.</p>}
            <div className="pushActions">
              <a className="ghost" href={'/live?push=' + push.id}><FileText size={14} /> Full report</a>
              <a className="ghost" href={'https://github.com/' + push.repo + '/commit/' + push.sha} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Commit on GitHub</a>
            </div>
          </div>
        )}
        {done && push.status === 'error' && <p className="landing-error">{push.error}</p>}
      </div>
      {unread > 0 && (
        <button className="jumpPill" onClick={jump}><ArrowDown size={14} /> {unread} new message{unread === 1 ? '' : 's'}</button>
      )}
    </>
  );
}
