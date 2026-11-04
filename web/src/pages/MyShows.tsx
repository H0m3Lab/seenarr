import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, post, type ShowSummary, type Tracking } from '../api';
import { Poster, ProgressBar } from '../components';

const ended = (s: ShowSummary) => s.status === 'Ended' || s.status === 'Canceled';
const following = (s: ShowSummary) => s.tracking_state === 'following';

const FILTERS: Record<string, { label: string; test: (s: ShowSummary) => boolean }> = {
  following: { label: 'Following', test: following },
  watching: { label: 'Watching', test: (s) => following(s) && !!s.progress.lastWatched && !!s.progress.nextToWatch },
  caughtUp: { label: 'Caught Up', test: (s) => following(s) && !!s.progress.lastWatched && !s.progress.nextToWatch },
  notStarted: { label: 'Not Started', test: (s) => following(s) && !s.progress.lastWatched },
  continuing: { label: 'Continuing', test: (s) => following(s) && !ended(s) },
  ended: { label: 'Ended', test: (s) => following(s) && ended(s) },
  inSonarr: { label: 'In Sonarr', test: (s) => !!s.in_sonarr },
  discovered: { label: 'Discovered', test: (s) => s.tracking_state === 'discovered' },
  archived: { label: 'Archived', test: (s) => s.tracking_state === 'archived' },
  all: { label: 'All', test: () => true },
};

const SORTS: Record<string, { label: string; cmp: (a: ShowSummary, b: ShowSummary) => number }> = {
  title: { label: 'Title', cmp: () => 0 }, // the server already orders by title
  recent: { label: 'Last watched', cmp: (a, b) => (b.progress.lastWatched?.watchedAt ?? '').localeCompare(a.progress.lastWatched?.watchedAt ?? '') },
  percent: { label: '% complete', cmp: (a, b) => b.progress.percent - a.progress.percent },
};

export function MyShows() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filter = FILTERS[params.get('filter') ?? ''] ? params.get('filter')! : 'following';
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('title');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const { data, error } = useQuery({ queryKey: ['shows'], queryFn: () => api<ShowSummary[]>('/shows') });

  const shows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data ?? [])
      .filter(FILTERS[filter].test)
      .filter((s) => !term || s.title.toLowerCase().includes(term))
      .sort(SORTS[sort].cmp);
  }, [data, filter, q, sort]);

  const setTracking = useMutation({
    mutationFn: (state: Tracking) => post('/shows/tracking', { ids: [...selected], state }),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries();
    },
  });

  const [markResult, setMarkResult] = useState('');
  const markWatched = useMutation({
    mutationFn: (date: { mode: 'now' | 'unknown' }) => post<{ changed: number }>('/shows/watched', { ids: [...selected], date }),
    onMutate: () => setMarkResult(''),
    onSuccess: (r) => {
      setMarkResult(`Marked ${r.changed} episode${r.changed === 1 ? '' : 's'} watched.`);
      setSelected(new Set());
      void qc.invalidateQueries();
    },
    onError: (err) => setMarkResult((err as Error).message),
  });

  const markAllWatched = () => {
    const picked = (data ?? []).filter((s) => selected.has(s.id));
    const left = picked.reduce((n, s) => n + Math.max(0, s.progress.aired - s.progress.watched), 0);
    if (!left) {
      setMarkResult('Those shows are already caught up.');
      return;
    }
    if (!confirm(`Mark ${left} unwatched aired episode${left === 1 ? '' : 's'} across ${picked.length} show${picked.length === 1 ? '' : 's'} watched?\n\nEpisodes you've already watched keep their dates.`)) return;
    const today = confirm('Did you watch them today?\n\nOK = date them today. Cancel = leave the date unknown.');
    markWatched.mutate({ mode: today ? 'now' : 'unknown' });
  };

  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const pickFilter = (key: string) => {
    setSelected(new Set());
    setParams({ filter: key });
  };

  if (error) return <p className="error">{(error as Error).message}</p>;

  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder="Search your shows" value={q} onChange={(e) => setQ(e.target.value)} />
        <label>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
      </div>
      <div className="chips">
        {Object.entries(FILTERS).map(([k, v]) => (
          <button key={k} className={k === filter ? 'chip on' : 'chip'} onClick={() => pickFilter(k)}>
            {v.label} <span className="count">{(data ?? []).filter(v.test).length}</span>
          </button>
        ))}
      </div>

      <div className="bulk">
        <button onClick={() => setSelected(new Set(shows.map((s) => s.id)))} disabled={!shows.length}>Select all {shows.length}</button>
        <button onClick={() => setSelected(new Set())} disabled={!selected.size}>Clear</button>
        <span className="muted">{selected.size} selected</span>
        <button className="primary" disabled={!selected.size || setTracking.isPending} onClick={() => setTracking.mutate('following')}>Follow</button>
        <button disabled={!selected.size || setTracking.isPending} onClick={() => setTracking.mutate('archived')}>Archive</button>
        <button disabled={!selected.size || setTracking.isPending} onClick={() => setTracking.mutate('discovered')}>Back to Discovered</button>
        <button disabled={!selected.size || markWatched.isPending} onClick={markAllWatched}>Mark all watched</button>
      </div>
      {markResult && <p className="muted">{markResult}</p>}

      {data && !shows.length && <p className="muted">No shows here.</p>}
      <div className="grid">
        {shows.map((s) => (
          <div key={s.id} className={selected.has(s.id) ? 'tile selected' : 'tile'}>
            <label className="tile-check">
              <input type="checkbox" aria-label={`Select ${s.title}`} checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
            </label>
            <Link to={`/shows/${s.id}`}>
              <Poster show={s} />
              <h3>{s.title}</h3>
            </Link>
            <p className="muted">{s.status}{s.progress.aired ? ` · ${s.progress.watched}/${s.progress.aired}` : ''}</p>
            <ProgressBar percent={s.progress.percent} />
          </div>
        ))}
      </div>
    </>
  );
}
