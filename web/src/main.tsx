import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api, ApiError, post } from './api';
import { Login } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { MyShows } from './pages/MyShows';
import { ShowPage } from './pages/Show';
import { AddShow } from './pages/AddShow';
import { Settings } from './pages/Settings';
import { ReviewPage } from './pages/Review';
import './styles.css';

const client = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: (n, err) => !(err instanceof ApiError && err.status === 401) && n < 2 },
  },
});

function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  if (me.isLoading) return <div className="loading">Loading…</div>;
  if (me.isError) return <Login />;

  const logout = async () => {
    await post('/logout');
    window.location.href = '/';
  };

  return (
    <BrowserRouter>
      <header className="topbar">
        <NavLink to="/" className="brand">TV Tracker</NavLink>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/shows">My Shows</NavLink>
          <NavLink to="/add">Add Show</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <button className="link" onClick={logout}>Sign out</button>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/shows" element={<MyShows />} />
          <Route path="/shows/:id" element={<ShowPage />} />
          <Route path="/add" element={<AddShow />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="credit">
        Show data and images from <a href="https://www.tvmaze.com" target="_blank" rel="noreferrer">TVmaze</a>, licensed CC BY-SA 4.0.
      </footer>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
