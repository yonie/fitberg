import { useState } from 'react';
import { api } from '../lib/api';
import type { AppConfig } from '../lib/api';
import { useGet } from '../lib/hooks';
import { Card, Loading, ErrorNotice, Empty } from '../components/common';
import { Markdown } from '../components/Markdown';

// The AI coach.
//
// Runs against whatever Ollama host is configured (OLLAMA_URL) using whatever model
// is named (OLLAMA_MODEL). Prompts are built from compact numeric summaries rather
// than raw sample streams, so a small model is enough.

const SUGGESTIONS = [
  'How many kilometres did I run last month?',
  'What was my longest ride this year?',
  'Compare my average heart rate this month with last month',
  'Which week had the highest training load?',
  'How many rest days did I take in the last 30 days?',
];

export function Coach({ config }: { config: AppConfig }) {
  const status = useGet<{ available: boolean; url?: string; model: string; modelInstalled: boolean; models: string[]; reason: string | null; hint?: string }>(
    '/api/ai/status',
  );

  const [weekly, setWeekly] = useState<{ content: string; model: string; cached: boolean } | null>(null);
  // Show a review that already exists rather than an empty state with a button.
  const storedWeekly = useGet<{ content: string | null; model: string; cached: boolean }>('/api/ai/weekly');
  const shownWeekly = weekly ?? (storedWeekly.data?.content ? storedWeekly.data : null);
  const [weeklyBusy, setWeeklyBusy] = useState(false);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ answer: string | null; sql?: string; rowCount?: number; error?: string } | null>(null);
  const [asking, setAsking] = useState(false);

  const runWeekly = async (refresh = false) => {
    setWeeklyBusy(true);
    setWeeklyError(null);
    try {
      setWeekly(await api.post('/api/ai/weekly', { refresh }));
    } catch (err) {
      setWeeklyError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setWeeklyBusy(false);
    }
  };

  const ask = async (text: string) => {
    if (!text.trim()) return;
    setAsking(true);
    setAnswer(null);
    try {
      setAnswer(await api.post('/api/ai/ask', { question: text }));
    } catch (err) {
      setAnswer({ answer: null, error: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setAsking(false);
    }
  };

  if (status.loading) return <Loading />;

  if (!status.data?.available) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Coach</h1>
            <p>AI analysis of your training, via Ollama</p>
          </div>
        </div>
        <Empty title={status.data?.modelInstalled === false && status.data?.models?.length
          ? `Model "${status.data.model}" not found on that host`
          : 'Ollama is not reachable'}>
          <>
            <p style={{ marginBottom: '1rem' }}>{status.data?.reason}</p>
            {status.data?.hint && <p style={{ marginBottom: '1rem' }}>{status.data.hint}</p>}
            <div style={{ textAlign: 'left', maxWidth: '34rem', margin: '0 auto' }}>
              <p style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}>Point Fitberg at an Ollama host:</p>
              <pre className="code">{`# in .env — any reachable Ollama host, any model it serves
OLLAMA_URL=http://172.17.0.1:11434
OLLAMA_MODEL=qwen3.5

docker compose restart fitberg`}</pre>
              <p className="card-sub" style={{ marginTop: '0.75rem' }}>
                Run <code>ollama list</code> on that host to see the model names it serves.
                Prompts are built from compact numeric summaries rather than raw sample data, so a
                small model is enough if you are running one on the box itself.
              </p>
            </div>
          </>
        </Empty>
      </>
    );
  }

  if (!status.data.modelInstalled) {
    return (
      <Empty title={`The model "${status.data.model}" is not installed`}>
        <>
          <pre className="code" style={{ textAlign: 'left' }}>ollama pull {status.data.model}</pre>
          {status.data.models.length > 0 && (
            <p className="card-sub" style={{ marginTop: '0.75rem' }}>
              Installed models: {status.data.models.join(', ')}. Set <code>OLLAMA_MODEL</code> to one
              of these instead if you prefer.
            </p>
          )}
        </>
      </Empty>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Coach</h1>
          <p>Using {status.data.model} via {status.data.url}</p>
        </div>
      </div>

      <Card
        title="This week"
        sub="A review of the last seven days against the previous week"
        style={{ marginBottom: '1rem' }}
        action={
          <button type="button" className="btn btn-sm" onClick={() => runWeekly(Boolean(shownWeekly))} disabled={weeklyBusy}>
            {weeklyBusy ? <span className="spinner" /> : shownWeekly ? 'Regenerate' : 'Generate'}
          </button>
        }
      >
        {weeklyError && <ErrorNotice error={weeklyError} />}
        {shownWeekly?.content ? (
          <>
            <Markdown text={shownWeekly.content} />
            <p className="card-sub" style={{ marginTop: '0.875rem' }}>
              {shownWeekly.model}{shownWeekly.cached ? ' · written earlier' : ''}
            </p>
          </>
        ) : !weeklyBusy && (
          <p className="card-sub">
            The model is given your load, fitness, form and every session from the last two
            weeks, and asked what stands out. On a Pi this takes a minute or two.
          </p>
        )}
      </Card>

      <Card title="Ask about your data" sub="Answered by querying your own database">
        <form
          onSubmit={(event) => { event.preventDefault(); ask(question); }}
          style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.875rem', flexWrap: 'wrap' }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How far did I ride in June?"
            style={{
              flex: 1, minWidth: '14rem', padding: '0.5rem 0.625rem',
              borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-strong)',
              background: 'var(--surface-1)',
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={asking || !question.trim()}>
            {asking ? <span className="spinner" /> : 'Ask'}
          </button>
        </form>

        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s} type="button" className="btn btn-sm"
              onClick={() => { setQuestion(s); ask(s); }}
              disabled={asking}
              style={{ fontSize: '0.78125rem' }}
            >
              {s}
            </button>
          ))}
        </div>

        {asking && <Loading label="Thinking" />}

        {answer && (
          <div>
            {answer.error ? (
              <ErrorNotice error={answer.error} />
            ) : (
              <>
                <div style={{ marginBottom: '0.875rem' }}><Markdown text={answer.answer || ''} /></div>
                {answer.sql && (
                  <details>
                    <summary style={{ cursor: 'pointer', fontSize: '0.8125rem', color: 'var(--text-2)' }}>
                      Show the query it ran ({answer.rowCount} rows)
                    </summary>
                    <pre className="code" style={{ marginTop: '0.5rem' }}>{answer.sql}</pre>
                    <p className="card-sub" style={{ marginTop: '0.5rem' }}>
                      The model writes the query but never executes anything. Fitberg validates it
                      first — a single read-only SELECT, only known tables, and it must be scoped to
                      your own account — then runs it and hands the rows back for phrasing.
                    </p>
                  </details>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      <p className="card-sub" style={{ marginTop: '1rem' }}>
        Model: {config.ai.model}. Change it with <code>OLLAMA_MODEL</code>; larger models give better
        answers if your hardware can run them.
      </p>
    </>
  );
}
