import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';

type Connection = {
  id: string;
  label: string;
  status: string;
  revision: number;
  endpoint: string;
  desiredAccountIds: string[];
  identity: string | null;
  verifiedAt: number | null;
  errorCode: string | null;
};
type Data = {
  connections: Connection[];
  legacy: string[];
  eligibleAccounts: string[];
  appliesTo: string;
};
export function ConnectionsView() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('Jira');
  useEffect(() => {
    let alive = true;
    apiFetch('/api/connections')
      .then(async (r) => {
        if (!r.ok) throw new Error('Unable to load connections');
        return r.json() as Promise<Data>;
      })
      .then((value) => alive && setData(value))
      .catch(() => alive && setError('Unable to load connections.'));
    return () => {
      alive = false;
      setToken('');
    };
  }, []);
  if (error)
    return (
      <main className="workspace-page">
        <h1>Connections</h1>
        <p role="alert">{error}</p>
      </main>
    );
  if (!data)
    return (
      <main className="workspace-page">
        <h1>Connections</h1>
        <p>Loading connections…</p>
      </main>
    );
  return (
    <main className="workspace-page">
      <h1>Connections</h1>
      <p className="workspace-muted">
        Assignments apply to {data.appliesTo}. Existing GitHub and Google Workspace access is
        managed by the operator.
      </p>
      <section className="today-section">
        <h2>Connect Jira</h2>
        <p>
          Approved endpoint: <code>https://redhat.atlassian.net</code>. The gateway enforces its
          reviewed read-only policy; your Jira token permissions remain configured upstream.
        </p>
        <label className="workspace-setting">
          Label
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="workspace-setting">
          Jira email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="workspace-setting">
          Jira API token
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <p className="workspace-muted">
          Reauthorize before submitting. Token values are kept only in this form and cleared when
          you leave this page.
        </p>
      </section>
      <section className="today-section">
        <h2>Managed connections</h2>
        {data.connections.length === 0 ? (
          <p>No managed Jira connection.</p>
        ) : (
          data.connections.map((connection) => (
            <article className="workspace-record" key={connection.id}>
              <span>
                {connection.label} — {connection.status}
              </span>
              <small>{connection.identity ?? connection.errorCode ?? 'Not verified'}</small>
            </article>
          ))
        )}
      </section>
      <section className="today-section">
        <h2>Operator-managed legacy services</h2>
        <p>{data.legacy.join(', ')}</p>
      </section>
    </main>
  );
}
