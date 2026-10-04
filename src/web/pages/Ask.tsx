// Ask a question about your money (src/server/ask.ts): answered by a model from the figures the app
// works out, and shown as what it is, an inference to check against the pages, never a computed figure.

import { MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { resolveTask } from '../../shared/tasks';
import { SessionsLink } from '../components/SessionsLink';
import { Badge, Button, Callout, Card, EmptyState, Input, PageHeader } from '../components/ui';
import { api, useApi, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { timeAgo } from '../lib/format';

interface Question {
  id: string;
  question: string;
  askedAt: string;
  status: 'running' | 'answered' | 'failed';
  answer?: { answer: string; figures: { label: string; value: string; from: string }[]; confidence: string; caveats: string[]; cannotAnswer: boolean };
  error?: string;
  engine?: string;
  model?: string;
}

export default function Ask() {
  const { data } = useAppData();
  const choice = resolveTask('ask', data.settings.models.tasks);
  const [text, setText] = useState('');
  const q = useApi<{ questions: Question[] }>(['ask'], '/ask', { refetchInterval: (d) => (d?.questions.some((x) => x.status === 'running') ? 4000 : false) });
  const send = useApiMutation((question: string) => api<Question>('/ask', { body: { question } }), { onSuccess: () => setText('') });
  const busy = q.data?.questions.some((x) => x.status === 'running') ?? false;
  return (
    <div>
      <PageHeader title="Ask" subtitle="A question about your money, answered from the figures the app works out" />
      <Card>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send.mutate(text.trim());
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="How much did I spend eating out last month?" className="flex-1" maxLength={1000} aria-label="Your question" />
          <Button type="submit" icon={<MessageCircleQuestion className="size-4" />} loading={send.isPending} disabled={busy || !text.trim()}>
            Ask
          </Button>
        </form>
        <div className="mt-2 text-[12.5px] text-ink-3">
          {choice.engine === 'inference' ? 'The local model answers, on this machine: nothing leaves it. It thinks first, so an answer takes a few minutes.' : `Claude (${choice.model}) answers: your figures go to Anthropic.`} It is given the app’s computed figures (the digest the agents read), not your documents, and an answer is an inference to check against the pages, never a figure of the app’s. <Link to="/settings#extraction" className="text-accent hover:underline">Change the model</Link>
        </div>
        {send.error && <Callout tone="bad" className="mt-2">{send.error.message}</Callout>}
      </Card>
      <div className="mt-4 flex flex-col gap-3">
        {!q.data?.questions.length && <EmptyState title="No questions yet">Questions and answers are kept until the app restarts.</EmptyState>}
        {q.data?.questions.map((x) => (
          <Card key={x.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-[14px] font-medium text-ink">{x.question}</div>
              <div className="text-[12px] text-ink-3">{timeAgo(x.askedAt)}</div>
            </div>
            {x.status === 'running' && <div className="mt-2 text-[13px] text-ink-3">Thinking… <SessionsLink of={x.id}>Watch</SessionsLink></div>}
            {x.status === 'failed' && <Callout tone="bad" className="mt-2">{x.error}</Callout>}
            {x.answer && (
              <div className="mt-2 flex flex-col gap-2 text-[13.5px] text-ink-2">
                <div className="flex flex-wrap gap-2">
                  <Badge tone="neutral">inferred by {x.engine === 'inference' ? 'the local model' : 'Claude'}</Badge>
                  <Badge tone={x.answer.confidence === 'high' ? 'good' : 'warn'}>{x.answer.confidence} confidence</Badge>
                  {x.answer.cannotAnswer && <Badge tone="warn">the figures do not say</Badge>}
                </div>
                <p className="whitespace-pre-line">{x.answer.answer}</p>
                {x.answer.figures.length > 0 && (
                  <ul className="list-disc pl-4 text-[12.5px] text-ink-3">
                    {x.answer.figures.map((f, i) => (
                      <li key={i}>
                        {f.label}: {f.value} <span className="font-mono text-[11.5px]">({f.from})</span>
                      </li>
                    ))}
                  </ul>
                )}
                {x.answer.caveats.length > 0 && <div className="text-[12.5px] text-ink-3">{x.answer.caveats.join(' ')}</div>}
                <div className="text-[12px] text-ink-3">
                  <SessionsLink of={x.id}>What it was given and said</SessionsLink>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
