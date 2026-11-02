import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, post } from '../api';

interface Hit {
  tvmazeId: number;
  title: string;
  premiered: string | null;
  network: string | null;
  status: string;
  overview: string | null;
  image: string | null;
  existingShowId: number | null;
}

export function AddShow() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const search = useQuery({ queryKey: ['search', q], queryFn: () => api<Hit[]>(`/search?q=${encodeURIComponent(q)}`), enabled: !!q, retry: false });
  const add = useMutation({
    mutationFn: (tvmazeId: number) => post<{ showId: number }>('/shows', { tvmazeId }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      nav(`/shows/${r.showId}`);
    },
  });

  return (
    <>
      <h1>Add a show</h1>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()); }}>
        <input type="search" autoFocus placeholder="Search TVmaze" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="primary" disabled={!text.trim()}>Search</button>
      </form>
      {search.isFetching && <p className="muted">Searching…</p>}
      {search.error && <p className="error">{(search.error as Error).message}</p>}
      {add.error && <p className="error">{(add.error as Error).message}</p>}
      {search.data && !search.data.length && <p className="muted">No matches.</p>}
      <div className="rows">
        {search.data?.map((h) => (
          <div key={h.tvmazeId} className="row">
            {h.image ? <img className="poster" src={h.image} alt="" /> : <div className="poster poster-empty">{h.title}</div>}
            <div className="row-body">
              <h3>{h.title}</h3>
              <p className="muted">{[h.premiered?.slice(0, 4), h.network, h.status].filter(Boolean).join(' · ')}</p>
              {h.overview && <p className="clamp">{h.overview}</p>}
              {h.existingShowId
                ? <p>Already here. <Link to={`/shows/${h.existingShowId}`}>Open it</Link> or <button disabled={add.isPending} onClick={() => add.mutate(h.tvmazeId)}>Follow</button></p>
                : <button className="primary" disabled={add.isPending} onClick={() => add.mutate(h.tvmazeId)}>Add and follow</button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
