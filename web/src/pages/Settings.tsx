import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, post } from '../api';

interface Run {
  id?: number;
  source?: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
}

interface Status {
  sonarr: { configured: boolean; url: string; busy: boolean; minutes: number; last: Run | null };
  metadata: { provider: string; busy: boolean; minutes: number; last: Run | null };
  counts: Record<string, number>;
}

interface Review {
  id: number;
  type: string;
  show_id: number | null;
  show_title: string | null;
  summary: string;
  updated_at: string;
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'Never');

function Connection({ source, title, detail, busy, minutes, last }: { source: 'sonarr' | 'metadata'; title: string; detail: string; busy: boolean; minutes: number; last: Run | null }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [mins, setMins] = useState(String(minutes));
  const test = useMutation({ mutationFn: () => post<{ ok: boolean; message: string }>(`/test/${source}`), onSuccess: setResult });
  const sync = useMutation({ mutationFn: () => post(`/sync/${source}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['status'] }) });
  const save = useMutation({
    mutationFn: () => api('/settings/frequency', { method: 'PUT', body: { source, minutes: Number(mins) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['status'] }),
  });
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted">{detail}</p>
      <p>
        Last sync: {busy ? 'running now' : when(last?.finished_at ?? last?.started_at)}
        {!busy && last?.status === 'error' && <span className="error"> · {last.error}</span>}
      </p>
      <div className="bulk">
        <button onClick={() => test.mutate()} disabled={test.isPending}>Test connection</button>
        <button onClick={() => sync.mutate()} disabled={busy || sync.isPending}>Sync now</button>
        <label>
          Every
          <input type="number" min={5} max={10080} value={mins} onChange={(e) => setMins(e.target.value)} />
          minutes
        </label>
        <button onClick={() => save.mutate()} disabled={save.isPending || Number(mins) === minutes}>Save</button>
      </div>
      {save.error && <p className="error">{(save.error as Error).message}</p>}
      {result && <p className={result.ok ? 'okay' : 'error'}>{result.message}</p>}
    </section>
  );
}

export function Settings() {
  const { data } = useQuery({
    queryKey: ['status'],
    queryFn: () => api<Status>('/settings/status'),
    refetchInterval: (q) => (q.state.data?.sonarr.busy || q.state.data?.metadata.busy ? 3000 : false),
  });
  const log = useQuery({ queryKey: ['log', data?.sonarr.busy, data?.metadata.busy], queryFn: () => api<Run[]>('/sync-log') });
  const review = useQuery({ queryKey: ['review', data?.sonarr.busy, data?.metadata.busy], queryFn: () => api<Review[]>('/review') });
  if (!data) return <p className="muted">Loading…</p>;
  const c = data.counts;

  return (
    <>
      <h1>Settings</h1>
      <section className="card">
        <h2>Library</h2>
        <p>{c.following} following · {c.discovered} discovered · {c.archived} archived · {c.episodes} episodes · {c.watchEvents} watches</p>
        {c.metadataPending > 0 && <p className="muted">{c.metadataPending} shows still waiting for metadata.</p>}
      </section>
      <Connection source="sonarr" title="Sonarr" busy={data.sonarr.busy} minutes={data.sonarr.minutes} last={data.sonarr.last}
        detail={data.sonarr.configured ? `Read-only, at ${data.sonarr.url}. API key is set.` : 'No API key set yet.'} />
      <Connection source="metadata" title="Metadata (TVmaze)" busy={data.metadata.busy} minutes={data.metadata.minutes} last={data.metadata.last}
        detail="Free, no key needed. Posters are stored on the server." />

      <section className="card">
        <h2>Needs review <span className="count">{review.data?.length ?? 0}</span></h2>
        {!review.data?.length && <p className="muted">Nothing to review.</p>}
        <ul className="plain">
          {review.data?.map((r) => (
            <li key={r.id}>
              {r.show_id ? <Link to={`/shows/${r.show_id}`}>{r.show_title}</Link> : null} {r.summary}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Sync log</h2>
        <div className="scroll">
          <table>
            <thead><tr><th>Started</th><th>Source</th><th>Result</th><th>Details</th></tr></thead>
            <tbody>
              {log.data?.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.started_at)}</td>
                  <td>{r.source}</td>
                  <td className={r.status === 'error' ? 'error' : ''}>{r.status}</td>
                  <td>{r.error ?? r.summary ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
