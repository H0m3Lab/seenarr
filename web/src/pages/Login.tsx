import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '../api';

export function Login() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/login', { password });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <h1>TV Tracker</h1>
      <label>
        Password
        <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !password}>Sign in</button>
    </form>
  );
}
