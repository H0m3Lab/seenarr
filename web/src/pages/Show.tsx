import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, epCode, fmtAir, fmtDate, post, type Episode, type ShowDetail, type Tracking } from '../api';
import { Badge, Poster, ProgressBar } from '../components';

/** A date picker's value as local noon, so it stays the same day in any time zone. */
const dateToIso = (value: string) => new Date(`${value}T12:00:00`).toISOString();
const isoToDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-CA') : '');

function EpisodeRow({ ep, onToggle, onDate, busy }: { ep: Episode; onToggle: () => void; onDate: (iso: string | null) => void; busy: boolean }) {
  const watched = ep.state === 'watched';
  return (
    <li className={`ep ${watched ? 'ep-watched' : ''} ${ep.orphaned ? 'ep-orphan' : ''}`}>
      <input type="checkbox" aria-label={`Mark ${epCode(ep)} watched`} checked={watched} onChange={onToggle} disabled={busy} />
      <div className="ep-body">
        <div className="ep-head">
          <strong>{ep.kind === 'special' ? 'Special' : `E${String(ep.number).padStart(2, '0')}`}</strong>
          <span>{ep.title ?? 'Untitled'}</span>
        </div>
        <div className="ep-meta">
          <span className="muted">{ep.aired ? `Aired ${fmtAir(ep)}` : `Airs ${fmtAir(ep)}`}</span>
          {!!ep.has_file && <Badge kind="ok">Downloaded</Badge>}
          {!!ep.in_plex && <Badge kind="ok">In Plex</Badge>}
          {!!ep.orphaned && <Badge kind="warn">No longer listed by TVmaze</Badge>}
          {watched && (
            <label className="watch-date">
              Watched
              <input type="date" value={isoToDate(ep.occurred_at_utc)} max={new Date().toLocaleDateString('en-CA')}
                onChange={(e) => onDate(e.target.value ? dateToIso(e.target.value) : null)} disabled={busy} />
            </label>
          )}
        </div>
        {ep.overview && <p className="ep-overview">{ep.overview}</p>}
      </div>
    </li>
  );
}

export function ShowPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const { data: show, error } = useQuery({ queryKey: ['show', id], queryFn: () => api<ShowDetail>(`/shows/${id}`) });
  const [openSeasons, setOpenSeasons] = useState<Set<number> | null>(null);
  const [actionError, setActionError] = useState('');

  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => setActionError(''),
    onError: (err) => setActionError((err as Error).message),
    onSettled: () => void qc.invalidateQueries(),
  });

  const seasons = useMemo(() => {
    const map = new Map<number, Episode[]>();
    for (const e of show?.episodes ?? []) {
      const list = map.get(e.season);
      if (list) list.push(e);
      else map.set(e.season, [e]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [show]);

  if (error) return <p className="error">{(error as Error).message}</p>;
  if (!show) return <p className="muted">Loading…</p>;
  const p = show.progress;

  // Until you open or close one, show the season you're up to.
  const open = openSeasons ?? new Set(p.nextToWatch ? [p.nextToWatch.season] : seasons.length ? [seasons[seasons.length - 1][0]] : []);
  const toggleSeason = (s: number) => {
    const next = new Set(open);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setOpenSeasons(next);
  };

  const markSeason = (season: number, watched: boolean) => {
    if (!watched) {
      if (confirm(`Mark all of season ${season} unwatched? Each episode's watch stays in your history.`)) {
        act.mutate(() => post(`/shows/${id}/seasons/${season}/watched`, { watched: false }));
      }
      return;
    }
    if (!confirm(`Mark every aired episode in season ${season} watched?`)) return;
    const today = confirm('Did you watch them today?\n\nOK = date them today. Cancel = leave the date unknown.');
    act.mutate(() => post(`/shows/${id}/seasons/${season}/watched`, { watched: true, date: { mode: today ? 'now' : 'unknown' } }));
  };

  const setTracking = (state: Tracking) => act.mutate(() => post('/shows/tracking', { ids: [id], state }));

  return (
    <>
      <div className="show-head">
        <Poster show={show} />
        <div>
          <h1>{show.title}</h1>
          <p className="badges">
            <Badge kind="status">{show.status}</Badge>
            {!!show.in_sonarr && <Badge kind="ok">In Sonarr</Badge>}
            {!show.in_sonarr && show.sonarr_removed_at && <Badge kind="muted">Removed from Sonarr</Badge>}
            {show.inPlex && <Badge kind="ok">In Plex</Badge>}
            {show.metadata_state !== 'ok' && <Badge kind="warn">Metadata: {show.metadata_state.replace('_', ' ')}</Badge>}
          </p>
          <p className="muted">{[show.network, show.premiere_date?.slice(0, 4), `${show.seasons} season${show.seasons === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</p>
          {show.overview && <p>{show.overview}</p>}
          <dl className="facts">
            <div><dt>Progress</dt><dd>{p.watched} of {p.aired} aired · {p.percent}%<ProgressBar percent={p.percent} /></dd></div>
            <div><dt>Last watched</dt><dd>{p.lastWatched ? `${epCode(p.lastWatched)}${p.lastWatched.watchedAt ? ` on ${fmtDate(p.lastWatched.watchedAt)}` : ' (date unknown)'}` : 'Nothing yet'}</dd></div>
            <div><dt>Next to watch</dt><dd>{p.nextToWatch ? `${epCode(p.nextToWatch)}${p.nextToWatch.title ? ` · ${p.nextToWatch.title}` : ''}` : p.aired ? 'All caught up' : 'Nothing aired yet'}</dd></div>
            {p.nextAfterLast && <div><dt>After your last watch</dt><dd>{epCode(p.nextAfterLast)}{p.nextAfterLast.title ? ` · ${p.nextAfterLast.title}` : ''}</dd></div>}
            <div><dt>Next air date</dt><dd>{p.nextToAir ? `${fmtAir(p.nextToAir)} · ${epCode(p.nextToAir)}` : 'None announced'}</dd></div>
          </dl>
          <div className="bulk">
            <span className="muted">Tracking:</span>
            {(['following', 'discovered', 'archived'] as Tracking[]).map((t) => (
              <button key={t} className={show.tracking_state === t ? 'chip on' : 'chip'} disabled={act.isPending} onClick={() => setTracking(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
            <button disabled={act.isPending} onClick={() => act.mutate(() => post(`/shows/${id}/refresh`))}>Refresh metadata</button>
          </div>
          {actionError && <p className="error">{actionError}</p>}
        </div>
      </div>

      {!seasons.length && <p className="muted">No episodes yet. They'll appear after the next metadata sync.</p>}
      {seasons.map(([season, eps]) => {
        const regular = eps.filter((e) => e.kind === 'regular' && !e.orphaned);
        const aired = regular.filter((e) => e.aired);
        const done = aired.filter((e) => e.state === 'watched').length;
        const isOpen = open.has(season);
        return (
          <section key={season} className="season">
            <div className="season-head">
              <button className="season-toggle" aria-expanded={isOpen} onClick={() => toggleSeason(season)}>
                {isOpen ? '▾' : '▸'} {season === 0 ? 'Specials' : `Season ${season}`} <span className="muted">{done}/{aired.length}</span>
              </button>
              {regular.length > 0 && (
                <span className="season-actions">
                  <button disabled={act.isPending || !aired.length || done === aired.length} onClick={() => markSeason(season, true)}>Mark watched</button>
                  <button disabled={act.isPending || !regular.some((e) => e.state === 'watched')} onClick={() => markSeason(season, false)}>Mark unwatched</button>
                </span>
              )}
            </div>
            {isOpen && (
              <ul className="eps">
                {eps.map((e) => (
                  <EpisodeRow key={e.id} ep={e} busy={act.isPending}
                    onToggle={() => act.mutate(() => post(`/episodes/${e.id}/watched`, { watched: e.state !== 'watched' }))}
                    onDate={(at) => act.mutate(() => post(`/episodes/${e.id}/watch-date`, { at }))} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
