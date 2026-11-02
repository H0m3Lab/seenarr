import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, epCode, fmtDate, post, type ShowDetail, type ShowSummary } from '../api';

interface ReviewItem {
  id: number;
  type: string;
  show_id: number | null;
  show_title: string | null;
  summary: string;
  payload: string;
}

interface Unmatched {
  id: number;
  source: string;
  show_id: number | null;
  show_title: string | null;
  reason: string;
  occurred_at_utc: string | null;
  payload: string;
}

interface Hit { tvmazeId: number; title: string; premiered: string | null; network: string | null }

function details(item: ReviewItem): string[] {
  const p = JSON.parse(item.payload) as { mismatches?: { sonarr: string; reason: string }[]; problems?: string[] };
  if (p.mismatches) return p.mismatches.map((m) => `${m.sonarr}: ${m.reason}`);
  return p.problems ?? [];
}

function LinkTvmaze({ onPick, busy }: { onPick: (id: number) => void; busy: boolean }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const search = useQuery({ queryKey: ['search', q], queryFn: () => api<Hit[]>(`/search?q=${encodeURIComponent(q)}`), enabled: !!q, retry: false });
  return (
    <div>
      <form className="bulk" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()); }}>
        <input type="search" placeholder="Find it on TVmaze" value={text} onChange={(e) => setText(e.target.value)} />
        <button disabled={!text.trim()}>Search</button>
      </form>
      {search.error && <p className="error">{(search.error as Error).message}</p>}
      <ul className="plain">
        {search.data?.map((h) => (
          <li key={h.tvmazeId}>
            <button disabled={busy} onClick={() => onPick(h.tvmazeId)}>Use this</button>{' '}
            {h.title} <span className="muted">{[h.premiered?.slice(0, 4), h.network].filter(Boolean).join(' · ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShowIssue({ item }: { item: ReviewItem }) {
  const qc = useQueryClient();
  const [more, setMore] = useState(false);
  const act = useMutation({
    mutationFn: (body: { action: string; tvmazeId?: number }) => post(`/review/${item.id}/resolve`, body),
    onSettled: () => void qc.invalidateQueries(),
  });
  const lines = details(item);
  const go = (action: string) => act.mutate({ action });
  return (
    <li className="card">
      <h3>{item.show_id ? <Link to={`/shows/${item.show_id}`}>{item.show_title}</Link> : item.show_title}</h3>
      <p>{item.summary}</p>
      {lines.length > 0 && (
        <>
          <ul className="muted">{(more ? lines : lines.slice(0, 4)).map((l) => <li key={l}>{l}</li>)}</ul>
          {lines.length > 4 && <button className="link" onClick={() => setMore(!more)}>{more ? 'Show fewer' : `Show all ${lines.length}`}</button>}
        </>
      )}
      <div className="bulk">
        {item.type === 'episode_mismatch' && (
          <button disabled={act.isPending} onClick={() => go('trust_numbering')} title="Air dates may differ, for example with batch releases">Numbers are right, ignore date differences</button>
        )}
        {item.type === 'show_id_conflict' && (
          <>
            <button disabled={act.isPending} onClick={() => go('same_show')}>It's the same show, keep going</button>
            <button disabled={act.isPending} onClick={() => go('not_this_show')}>Wrong show, don't use TVmaze</button>
          </>
        )}
        {item.type === 'show_not_on_tvmaze' && (
          <button disabled={act.isPending} onClick={() => go('keep_sonarr')}>Keep using Sonarr's episode list</button>
        )}
      </div>
      {item.type === 'show_not_on_tvmaze' && <LinkTvmaze busy={act.isPending} onPick={(tvmazeId) => act.mutate({ action: 'link_tvmaze', tvmazeId })} />}
      {act.error && <p className="error">{(act.error as Error).message}</p>}
    </li>
  );
}

const fileName = (item: { Media?: { Part?: { file?: string }[] }[] }) => item.Media?.[0]?.Part?.[0]?.file?.split(/[\\/]/).pop() ?? '';

function UnmatchedRow({ row, episodes, selected, onSelect }: { row: Unmatched; episodes: ShowDetail['episodes'] | undefined; selected: boolean; onSelect: (on: boolean) => void }) {
  const qc = useQueryClient();
  const [pick, setPick] = useState('');
  const act = useMutation({
    mutationFn: (body: unknown) => post(`/unmatched/${row.id}`, body),
    onSettled: () => void qc.invalidateQueries(),
  });
  const { item } = JSON.parse(row.payload) as { item: { title?: string; parentIndex?: number; index?: number; grandparentTitle?: string; Media?: { Part?: { file?: string }[] }[] } };
  const file = fileName(item);
  return (
    <li className="unmatched">
      <label className="unmatched-head">
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        <span><strong>S{item.parentIndex}E{item.index}</strong> {item.title ?? ''}<span className="muted"> · watched {fmtDate(row.occurred_at_utc)}</span></span>
      </label>
      {file && <p className="file-name">{file}</p>}
      <p className="muted">{row.reason}</p>
      <div className="bulk">
        {episodes && (
          <select aria-label="Episode to assign" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose an episode…</option>
            {episodes.filter((e) => !e.orphaned).map((e) => <option key={e.id} value={e.id}>{epCode(e)}{e.title ? ` · ${e.title}` : ''}</option>)}
          </select>
        )}
        {episodes && <button className="primary" disabled={!pick || act.isPending} onClick={() => act.mutate({ episodeId: Number(pick) })}>Assign</button>}
        <button disabled={act.isPending} onClick={() => { if (confirm('Dismiss this watch? It will not be imported.')) act.mutate({ dismiss: true }); }}>Dismiss</button>
      </div>
      {act.error && <p className="error">{(act.error as Error).message}</p>}
    </li>
  );
}

function UnmatchedGroup({ showId, title, rows }: { showId: number | null; title: string; rows: Unmatched[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState('');
  const [filter, setFilter] = useState('');
  const show = useQuery({ queryKey: ['show', showId], queryFn: () => api<ShowDetail>(`/shows/${showId}`), enabled: open && showId !== null });
  const allShows = useQuery({ queryKey: ['shows'], queryFn: () => api<ShowSummary[]>('/shows'), enabled: open });
  const bulk = useMutation({
    mutationFn: () => post<{ assigned: number; skipped: number }>('/unmatched/bulk-assign', { ids: [...selected], showId: Number(target) }),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries();
    },
  });
  // One Plex show can hold files from two real shows, so "Select all" covers only what's listed.
  const term = filter.trim().toLowerCase();
  const visible = term
    ? rows.filter((r) => fileName((JSON.parse(r.payload) as { item: Parameters<typeof fileName>[0] }).item).toLowerCase().includes(term))
    : rows;
  const targetTitle = allShows.data?.find((s) => s.id === Number(target))?.title ?? '';
  const sendToShow = () => {
    if (confirm(`Record ${selected.size} selected watch${selected.size === 1 ? '' : 'es'} on ${targetTitle}, by the same season and episode number, keeping their dates?`)) bulk.mutate();
  };
  return (
    <section className="season">
      <div className="season-head">
        <button className="season-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {title} <span className="muted">{rows.length}</span>
        </button>
        {showId !== null && <Link to={`/shows/${showId}`}>Open show</Link>}
      </div>
      {open && (
        <div className="eps">
          <div className="bulk">
            <input type="search" aria-label="Filter by file name" placeholder="Filter by file name" value={filter}
              onChange={(e) => { setFilter(e.target.value); setSelected(new Set()); }} />
            <button onClick={() => setSelected(new Set(visible.map((r) => r.id)))}>Select all {visible.length}</button>
            <button disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear</button>
            <span className="muted">{selected.size} selected</span>
            <select aria-label="Show to send selected watches to" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Send to show…</option>
              {allShows.data?.map((s) => <option key={s.id} value={s.id}>{s.title}{s.premiere_date ? ` (${s.premiere_date.slice(0, 4)})` : ''}</option>)}
            </select>
            <button className="primary" disabled={!selected.size || !target || bulk.isPending} onClick={sendToShow}>Send</button>
          </div>
          <p className="muted">Show missing from the list? <Link to="/add">Add it</Link> first.</p>
          {bulk.data && <p className="okay">Recorded {bulk.data.assigned}. {bulk.data.skipped > 0 ? `${bulk.data.skipped} had no matching episode there and stayed here.` : ''}</p>}
          {bulk.error && <p className="error">{(bulk.error as Error).message}</p>}
          <ul className="plain">
            {visible.map((r) => (
              <UnmatchedRow key={r.id} row={r} episodes={show.data?.episodes} selected={selected.has(r.id)}
                onSelect={(on) => {
                  const next = new Set(selected);
                  if (on) next.add(r.id);
                  else next.delete(r.id);
                  setSelected(next);
                }} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function ReviewPage() {
  const items = useQuery({ queryKey: ['review'], queryFn: () => api<ReviewItem[]>('/review') });
  const unmatched = useQuery({ queryKey: ['unmatched'], queryFn: () => api<Unmatched[]>('/unmatched') });

  const groups = new Map<string, { showId: number | null; title: string; rows: Unmatched[] }>();
  for (const r of unmatched.data ?? []) {
    const fallback = (JSON.parse(r.payload) as { item: { grandparentTitle?: string } }).item.grandparentTitle ?? 'Unknown show';
    const key = String(r.show_id ?? fallback);
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { showId: r.show_id, title: r.show_title ?? fallback, rows: [r] });
  }

  return (
    <>
      <h1>Needs review</h1>
      <p className="muted">Nothing here was guessed. Your history isn't affected while these wait.</p>

      <h2>Unplaced watches <span className="count">{unmatched.data?.length ?? 0}</span></h2>
      {unmatched.data && !unmatched.data.length && <p className="muted">None.</p>}
      {[...groups.entries()].map(([k, g]) => <UnmatchedGroup key={k} showId={g.showId} title={g.title} rows={g.rows} />)}

      <h2>Show issues <span className="count">{items.data?.length ?? 0}</span></h2>
      {items.data && !items.data.length && <p className="muted">None.</p>}
      <ul className="plain">{items.data?.map((i) => <ShowIssue key={i.id} item={i} />)}</ul>
    </>
  );
}
