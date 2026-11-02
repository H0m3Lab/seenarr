import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Dashboard, type ShowSummary } from '../api';
import { ShowRow } from '../components';

function Section({ title, shows, mode }: { title: string; shows: ShowSummary[]; mode: React.ComponentProps<typeof ShowRow>['mode'] }) {
  if (!shows.length) return null;
  return (
    <section>
      <h2>{title} <span className="count">{shows.length}</span></h2>
      <div className="rows">{shows.map((s) => <ShowRow key={s.id} show={s} mode={mode} />)}</div>
    </section>
  );
}

export function DashboardPage() {
  const { data, error } = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard') });
  if (error) return <p className="error">{(error as Error).message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const empty = !Object.values(data).some((list) => list.length);
  return (
    <>
      {empty && (
        <div className="empty">
          <h2>Nothing followed yet</h2>
          <p>Pick shows from <Link to="/shows?filter=discovered">what Sonarr found</Link>, or <Link to="/add">add one yourself</Link>.</p>
        </div>
      )}
      <Section title="Continue Watching" shows={data.continueWatching} mode="continue" />
      <Section title="New Episodes" shows={data.newEpisodes} mode="new" />
      <Section title="Coming Soon" shows={data.comingSoon} mode="soon" />
      <Section title="Not Started" shows={data.notStarted} mode="notStarted" />
      <Section title="Caught Up" shows={data.caughtUp} mode="caught" />
      <Section title="Ended" shows={data.ended} mode="ended" />
    </>
  );
}
