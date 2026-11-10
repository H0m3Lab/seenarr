import { Link } from 'react-router-dom';
import { epCode, fmtAir, fmtDate, type ShowSummary } from './api';

export function Poster({ show }: { show: Pick<ShowSummary, 'poster_file' | 'title'> }) {
  return show.poster_file
    ? <img className="poster" src={`/api/v1/posters/${show.poster_file}`} alt="" loading="lazy" />
    : <div className="poster poster-empty">{show.title}</div>;
}

export function ProgressBar({ percent }: { percent: number }) {
  return <div className="bar" aria-label={`${percent}% complete`}><div style={{ width: `${percent}%` }} /></div>;
}

export function Badge({ kind, children }: { kind: string; children: React.ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function Availability({ available }: { available: boolean }) {
  return available ? <Badge kind="ok">Available</Badge> : null;
}

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Marked by hand',
  plex: 'Plex',
  trakt: 'Trakt',
  prime: 'Prime Video',
  netflix: 'Netflix',
};

type Mode ='continue' | 'new' | 'soon' | 'caught' | 'notStarted' | 'ended' | 'recent';

/** One dashboard row. What it says depends on the section it's in. */
export function ShowRow({ show, mode }: { show: ShowSummary; mode: Mode }) {
  const p = show.progress;
  const next = p.nextToWatch;
  const toAir = p.nextToAir;
  return (
    <Link to={`/shows/${show.id}`} className="row">
      <Poster show={show} />
      <div className="row-body">
        <h3>{show.title}</h3>
        {(mode === 'continue' || mode === 'new') && next && (
          <p>
            <strong>Next: {epCode(next)}</strong>{next.title ? ` · ${next.title}` : ''} <Availability available={next.available} />
          </p>
        )}
        {mode === 'continue' && p.nextAfterLast && <p className="muted">After your last watch: {epCode(p.nextAfterLast)}</p>}
        {mode === 'new' && next && <p className="muted">Aired {fmtAir(next)}</p>}
        {(mode === 'continue' || mode === 'new') && (
          <p className="muted">
            {p.remaining} left
            {p.lastWatched ? ` · last watched ${epCode(p.lastWatched)}${p.lastWatched.watchedAt ? ` on ${fmtDate(p.lastWatched.watchedAt)}` : ''}` : ''}
          </p>
        )}
        {mode === 'soon' && toAir && <p><strong>{fmtAir(toAir)}</strong> · {epCode(toAir)}{toAir.title ? ` · ${toAir.title}` : ''}</p>}
        {mode === 'caught' && <p className="muted">Caught up · {p.watched} of {p.aired}{toAir ? ` · next airs ${fmtAir(toAir)}` : ''}</p>}
        {mode === 'notStarted' && <p className="muted">{p.aired} aired · {show.status}</p>}
        {mode === 'recent' && p.lastWatched && (
          <>
            <p>
              <strong>{epCode(p.lastWatched)}</strong>{p.lastWatched.title ? ` · ${p.lastWatched.title}` : ''}
              {p.lastWatched.watchedAt ? ` · ${fmtDate(p.lastWatched.watchedAt)}` : ''}
              {p.lastWatched.source && <> <Badge kind="muted">{SOURCE_LABEL[p.lastWatched.source] ?? p.lastWatched.source}</Badge></>}
            </p>
            <p className="muted">{next ? `Next: ${epCode(next)} · ${p.remaining} left` : `Caught up · ${p.watched} of ${p.aired}`}</p>
          </>
        )}
        {mode === 'ended' &&<><p className="muted">{show.status} · {p.percent}% complete ({p.watched} of {p.aired})</p><ProgressBar percent={p.percent} /></>}
      </div>
    </Link>
  );
}
