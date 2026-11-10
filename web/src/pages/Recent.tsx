import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, type LastWatch, type ShowSummary } from '../api';
import { ShowRow, SOURCE_LABEL } from '../components';

const PAGE = 50;

/** The watch a row shows: the show's latest overall, or its latest from the chosen source. */
const watchFor = (s: ShowSummary, source: string): LastWatch | undefined =>
  source ? s.progress.lastBySource[source] : s.progress.lastWatched ?? undefined;

function byRecent(shows: ShowSummary[], source: string) {
  return shows
    .filter((s) => s.tracking_state !== 'archived')
    .map((show) => ({ show, watch: watchFor(show, source) }))
    .filter((r): r is { show: ShowSummary; watch: LastWatch } => !!r.watch?.watchedAt)
    .sort((a, b) => b.watch.watchedAt!.localeCompare(a.watch.watchedAt!));
}

/** Shows ordered by their latest dated watch, newest first. Undated watches can't be placed, and archived shows are hidden. */
export function RecentPage() {
  const [params, setParams] = useSearchParams();
  const source = params.get('source') ?? '';
  const [limit, setLimit] = useState(PAGE);
  const { data, error } = useQuery({ queryKey: ['shows'], queryFn: () => api<ShowSummary[]>('/shows') });

  const rows = useMemo(() => byRecent(data ?? [], source), [data, source]);
  const chips = useMemo(
    () => [['', 'All'] as const, ...Object.entries(SOURCE_LABEL)]
      .map(([key, label]) => ({ key, label, count: byRecent(data ?? [], key).length }))
      .filter((c) => c.key === '' || c.count || c.key === source),
    [data, source],
  );

  if (error) return <p className="error">{(error as Error).message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const pick = (key: string) => {
    setLimit(PAGE);
    setParams(key ? { source: key } : {});
  };

  return (
    <section>
      <h2>Recently Watched</h2>
      <div className="chips">
        {chips.map((c) => (
          <button key={c.key} className={c.key === source ? 'chip on' : 'chip'} onClick={() => pick(c.key)}>
            {c.label} <span className="count">{c.count}</span>
          </button>
        ))}
      </div>
      {!rows.length && <p className="muted">No dated watches here.</p>}
      <div className="rows rows-single">
        {rows.slice(0, limit).map((r) => <ShowRow key={r.show.id} show={r.show} mode="recent" watch={r.watch} />)}
      </div>
      {rows.length > limit && (
        <p><button onClick={() => setLimit(limit + PAGE)}>Show more</button></p>
      )}
    </section>
  );
}
