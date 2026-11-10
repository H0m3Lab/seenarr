import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ShowSummary } from '../api';
import { ShowRow } from '../components';

const PAGE = 50;

/** Shows ordered by their latest dated watch, newest first. Undated watches can't be placed, so they're left out. */
export function RecentPage() {
  const [limit, setLimit] = useState(PAGE);
  const { data, error } = useQuery({ queryKey: ['shows'], queryFn: () => api<ShowSummary[]>('/shows') });
  if (error) return <p className="error">{(error as Error).message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const recent = data
    .filter((s) => s.progress.lastWatched?.watchedAt)
    .sort((a, b) => b.progress.lastWatched!.watchedAt!.localeCompare(a.progress.lastWatched!.watchedAt!));

  return (
    <section>
      <h2>Recently Watched <span className="count">{recent.length}</span></h2>
      {!recent.length && <p className="muted">No dated watches yet.</p>}
      <div className="rows">{recent.slice(0, limit).map((s) => <ShowRow key={s.id} show={s} mode="recent" />)}</div>
      {recent.length > limit && (
        <p><button onClick={() => setLimit(limit + PAGE)}>Show more</button></p>
      )}
    </section>
  );
}
