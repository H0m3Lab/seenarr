import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, post } from '../api';

interface ImportFile { file: string; bytes: number; modified: string }
interface Suggestion { tvmazeId: number; title: string; premiered: string | null; network: string | null; existingShowId: number | null }
interface Preview {
  file: string;
  entries: number;
  episodesInFile: number;
  toAdd: number;
  newlyWatched: number;
  alreadyImported: number;
  skipped: { movies: number; trailers: number; repeats: number };
  shows: { show: string; showId: number; newWatches: number; alreadyImported: number; newlyWatched: number; byTitle: number }[];
  unplaced: { day: string; primeShow: string; season: number | null; episode: string; reason: string }[];
  missing: { primeShow: string; episodes: number; lastWatched: string; suggestions: Suggestion[] }[];
}
interface Applied { added: number; alreadyImported: number; unplaced: number; missingShows: number; backup: string }

interface TraktPreview {
  folder: string; plays: number; episodePlays: number; movies: number; toAdd: number; datedUnknown: number; newlyWatched: number; alreadyImported: number;
  shows: { showId: number; show: string; toAdd: number; newlyWatched: number; alreadyImported: number }[];
  missing: { title: string; year: number | null; plays: number }[];
  deleted: { show: string; plays: number }[];
  unplaced: { show: string; episode: string; watchedAt: string; reason: string }[];
}
interface TraktApplied extends TraktPreview { added: number; showsAdded: string[]; showsNotFound: string[]; backup: string }

function TraktImport() {
  const qc = useQueryClient();
  const exports = useQuery({ queryKey: ['imports', 'trakt'], queryFn: () => api<{ folder: string; files: number }[]>('/imports/trakt') });
  const folder = exports.data?.[0]?.folder ?? '';
  const [preview, setPreview] = useState<TraktPreview | null>(null);
  const [applied, setApplied] = useState<TraktApplied | null>(null);
  const [error, setError] = useState('');
  const run = useMutation({
    mutationFn: () => post<TraktPreview>('/imports/trakt/preview', { folder }),
    onMutate: () => setError(''),
    onSuccess: setPreview,
    onError: (e) => setError((e as Error).message),
  });
  const apply = useMutation({
    mutationFn: () => post<TraktApplied>('/imports/trakt/apply', { folder }),
    onMutate: () => setError(''),
    onSuccess: (r) => { setApplied(r); setPreview(r); void qc.invalidateQueries(); },
    onError: (e) => setError((e as Error).message),
  });
  const busy = run.isPending || apply.isPending;
  if (!exports.data?.length) return null;
  return (
    <section>
      <h2>Trakt export</h2>
      <p className="muted">Folder <code>{folder}</code>. Matched by TVDB/IMDb IDs. Shows Trakt has that aren't here are added from TVmaze when you import.</p>
      <div className="toolbar">
        <button className="primary" disabled={busy} onClick={() => run.mutate()}>{run.isPending ? 'Checking…' : 'Preview'}</button>
        {preview && <button className="primary" disabled={busy || (!preview.toAdd && !preview.missing.length)}
          onClick={() => confirm(`Import ${preview.toAdd} Trakt plays and add ${preview.missing.length} shows?\n\nA copy of the database is saved first.`) && apply.mutate()}>
          {apply.isPending ? 'Importing…' : 'Import'}</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {applied && <p className="ok-note">Imported {applied.added} plays; added {applied.showsAdded.length} shows. Database copy saved as <code>{applied.backup}</code>.{applied.showsNotFound.length ? ` Not found on TVmaze: ${applied.showsNotFound.join(', ')}.` : ''}</p>}
      {preview && (
        <>
          <dl className="facts">
            <div><dt>In the export</dt><dd>{preview.episodePlays} episode plays · {preview.movies} movies (skipped)</dd></div>
            <div><dt>Ready to add</dt><dd>{preview.toAdd} plays ({preview.newlyWatched} episodes become watched; {preview.datedUnknown} were bulk "mark as watched" clicks, so their date is left unknown)</dd></div>
            <div><dt>Already imported</dt><dd>{preview.alreadyImported}</dd></div>
            <div><dt>Shows to add</dt><dd>{preview.missing.length ? preview.missing.map((m) => `${m.title}${m.year ? ` (${m.year})` : ''} · ${m.plays}`).join('; ') : 'none'}</dd></div>
            {preview.deleted.length > 0 && <div><dt>Deleted here, skipped</dt><dd>{preview.deleted.map((d) => `${d.show} · ${d.plays}`).join('; ')}</dd></div>}
            <div><dt>Not placed</dt><dd>{preview.unplaced.length}</dd></div>
          </dl>
          {preview.unplaced.length > 0 && (
            <table className="list">
              <thead><tr><th>Show</th><th>Episode</th><th>Watched</th><th>Why</th></tr></thead>
              <tbody>{preview.unplaced.slice(0, 200).map((u, i) => <tr key={i}><td>{u.show}</td><td>{u.episode}</td><td>{u.watchedAt.slice(0, 10)}</td><td className="muted">{u.reason}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

export function ImportPage() {
  const qc = useQueryClient();
  const files = useQuery({ queryKey: ['imports'], queryFn: () => api<ImportFile[]>('/imports') });
  const [file, setFile] = useState('');
  const chosen = file || files.data?.[0]?.file || '';
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [error, setError] = useState('');

  const run = useMutation({
    mutationFn: () => post<Preview>('/imports/prime/preview', { file: chosen }),
    onMutate: () => { setError(''); setApplied(null); },
    onSuccess: setPreview,
    onError: (e) => setError((e as Error).message),
  });
  const apply = useMutation({
    mutationFn: () => post<Applied>('/imports/prime/apply', { file: chosen }),
    onMutate: () => setError(''),
    onSuccess: (r) => {
      setApplied(r);
      void qc.invalidateQueries();
      run.mutate();
    },
    onError: (e) => setError((e as Error).message),
  });
  const link = useMutation({
    mutationFn: (b: { primeShow: string; showId?: number; tvmazeId?: number }) => post('/imports/prime/link', b),
    onMutate: () => setError(''),
    onSuccess: () => {
      void qc.invalidateQueries();
      run.mutate();
    },
    onError: (e) => setError((e as Error).message),
  });
  const busy = run.isPending || apply.isPending || link.isPending;

  const confirmApply = () => {
    if (!preview) return;
    if (confirm(`Add ${preview.toAdd} Prime Video watch${preview.toAdd === 1 ? '' : 'es'} to Seenarr?\n\nA copy of the database is saved first. Nothing unplaced or from missing shows is added.`)) apply.mutate();
  };

  return (
    <>
      <h1>Import watch history</h1>
      <TraktImport />
      <h2>Prime Video</h2>
      <p className="muted">Prime Video history files saved on the server. Preview first: nothing is added until you click Import.</p>
      <div className="toolbar">
        <select value={chosen} onChange={(e) => { setFile(e.target.value); setPreview(null); setApplied(null); }} disabled={busy}>
          {!files.data?.length && <option value="">No files in the imports folder</option>}
          {files.data?.map((f) => <option key={f.file} value={f.file}>{f.file} ({Math.round(f.bytes / 1024)} KB)</option>)}
        </select>
        <button className="primary" disabled={!chosen || busy} onClick={() => run.mutate()}>{run.isPending ? 'Checking…' : 'Preview'}</button>
        {preview && <button className="primary" disabled={busy || !preview.toAdd} onClick={confirmApply}>{apply.isPending ? 'Importing…' : `Import ${preview.toAdd}`}</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {applied && (
        <p className="ok-note">Imported {applied.added} watch{applied.added === 1 ? '' : 'es'}. Database copy saved as <code>{applied.backup}</code>.</p>
      )}

      {preview && (
        <>
          <dl className="facts">
            <div><dt>In the file</dt><dd>{preview.entries} entries · {preview.episodesInFile} episode views</dd></div>
            <div><dt>Ready to add</dt><dd>{preview.toAdd} watches ({preview.newlyWatched} not yet marked watched here)</dd></div>
            <div><dt>Already imported</dt><dd>{preview.alreadyImported}</dd></div>
            <div><dt>Skipped</dt><dd>{preview.skipped.movies} movies · {preview.skipped.trailers} trailers/previews · {preview.skipped.repeats} repeated entries</dd></div>
            <div><dt>Need your help</dt><dd>{preview.missing.length} shows not found · {preview.unplaced.length} episodes not placed</dd></div>
          </dl>

          {preview.missing.length > 0 && (
            <section>
              <h2>Shows not found here</h2>
              <p className="muted">Pick the right show for each Amazon name. That choice is remembered, then the preview runs again. Leave any you don't want.</p>
              <div className="rows">
                {preview.missing.map((m) => (
                  <div key={m.primeShow} className="row">
                    <div className="row-body">
                      <h3>{m.primeShow}</h3>
                      <p className="muted">{m.episodes} episode{m.episodes === 1 ? '' : 's'} · last watched {m.lastWatched}</p>
                      {!m.suggestions.length && <p className="muted">No TVmaze match. <Link to="/add">Search by hand</Link>, then preview again.</p>}
                      <ul className="plain">
                        {m.suggestions.map((s) => (
                          <li key={s.tvmazeId}>
                            {s.title} <span className="muted">{[s.premiered?.slice(0, 4), s.network].filter(Boolean).join(' · ')}</span>{' '}
                            {s.existingShowId
                              ? <button disabled={busy} onClick={() => link.mutate({ primeShow: m.primeShow, showId: s.existingShowId! })}>Use (already here)</button>
                              : <button disabled={busy} onClick={() => link.mutate({ primeShow: m.primeShow, tvmazeId: s.tvmazeId })}>Add and use</button>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {preview.unplaced.length > 0 && (
            <section>
              <h2>Episodes not placed</h2>
              <p className="muted">These stay out. Mark them by hand on the show's page if you know which episode it was.</p>
              <table className="list">
                <thead><tr><th>Watched</th><th>Amazon show</th><th>Episode</th><th>Why</th></tr></thead>
                <tbody>
                  {preview.unplaced.map((u, i) => (
                    <tr key={i}><td>{u.day}</td><td>{u.primeShow}{u.season !== null ? ` · S${u.season}` : ''}</td><td>{u.episode}</td><td className="muted">{u.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {preview.shows.length > 0 && (
            <section>
              <h2>Matched shows</h2>
              <table className="list">
                <thead><tr><th>Show</th><th>To add</th><th>Newly watched</th><th>Already imported</th></tr></thead>
                <tbody>
                  {preview.shows.map((s) => (
                    <tr key={s.showId}>
                      <td><Link to={`/shows/${s.showId}`}>{s.show}</Link>{s.byTitle ? <span className="muted"> · {s.byTitle} by episode title</span> : null}</td>
                      <td>{s.newWatches}</td><td>{s.newlyWatched}</td><td>{s.alreadyImported}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </>
  );
}
