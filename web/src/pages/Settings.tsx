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
  plex: { configured: boolean; url: string; busy: boolean; minutes: number; last: Run | null; webhookConfigured: boolean; webhookLastSeen: string | null };
  counts: Record<string, number>;
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'Never');

function Connection({ source, title, detail, busy, minutes, last }: { source: 'sonarr' | 'metadata' | 'plex'; title: string; detail: string; busy: boolean; minutes: number; last: Run | null }) {
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
    refetchInterval: (q) => (q.state.data?.sonarr.busy || q.state.data?.metadata.busy || q.state.data?.plex.busy ? 3000 : false),
  });
  const log = useQuery({ queryKey: ['log', data?.sonarr.busy, data?.metadata.busy, data?.plex.busy], queryFn: () => api<Run[]>('/sync-log') });
  if (!data) return <p className="muted">Loading…</p>;
  const c = data.counts;
  const toReview = c.reviewOpen + c.unmatchedOpen;

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

      <Connection source="plex" title="Plex" busy={data.plex.busy} minutes={data.plex.minutes} last={data.plex.last}
        detail={data.plex.configured ? `Read-only, at ${data.plex.url}. Token is set. Only your account's watches count.` : 'No token set yet.'} />
      <section className="card">
        <h2>Plex webhook</h2>
        <p className="muted">
          {data.plex.webhookConfigured ? 'Ready to receive. ' : 'Not set up yet. '}
          {data.plex.webhookLastSeen ? `Last heard from Plex: ${when(data.plex.webhookLastSeen)}.` : 'Nothing received from Plex yet.'}
          {' '}Scheduled syncs catch anything it misses.
        </p>
      </section>

      <section className="card">
        <h2>Needs review <span className="count">{toReview}</span></h2>
        {toReview > 0
          ? <p>{c.reviewOpen} show issue{c.reviewOpen === 1 ? '' : 's'} and {c.unmatchedOpen} unplaced watch{c.unmatchedOpen === 1 ? '' : 'es'}. <Link to="/review">Review them</Link></p>
          : <p className="muted">Nothing to review.</p>}
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
