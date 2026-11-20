import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, ApiError, AuthContext, Session } from './api';

interface Operator { id: string; name: string; status: string }
interface Card { id: string; card_token: string; status: string; tier: string; offline_allowance_minor: number }
interface Terminal { id: string; name: string; status: string; last_heartbeat_at: string | null; offline_queue_count: number; blocked_list_version: number }
interface Agent {
  id: string;
  name: string;
  phone: string;
  location: string | null;
  status: 'active' | 'inactive' | 'blocked';
  commission_bps: number;
  floatMinor: number;
  invitationPending: boolean;
  invitationExpiresAt: string | null;
}
interface Settlement { id: string; business_day: string; posted_minor: number; difference_minor: number; status: string }

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [externalId, setExternalId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const session = await fetch(`${import.meta.env.VITE_API_URL ?? 'http://localhost:3000'}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ externalId, password }),
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail ?? body.title ?? 'Login failed');
        return body as Session;
      });
      onLogin(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Login failed');
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <img src="/bextra-lockup-cropped.png" alt="BeXtra" className="login-logo" />
        <div>
          <p className="eyebrow">Staff access</p>
          <h1>Sign in</h1>
        </div>
        <form onSubmit={submit}>
          <label>External ID<input value={externalId} onChange={(event) => setExternalId(event.target.value)} autoComplete="username" required /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" type="submit">Sign in</button>
        </form>
      </section>
    </main>
  );
}

function useOperator(auth: AuthContext) {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [operatorId, setOperatorId] = useState(auth.operatorId ?? localStorage.getItem('bextra-operator') ?? '');

  useEffect(() => {
    if (auth.operatorId) {
      setOperatorId(auth.operatorId);
      return;
    }
    api<{ items: Operator[] }>('/v1/operators')
      .then((result) => setOperators(result.items))
      .catch(() => setOperators([]));
  }, [auth.operatorId]);

  useEffect(() => {
    if (operatorId) localStorage.setItem('bextra-operator', operatorId);
  }, [operatorId]);

  return { operators, operatorId, setOperatorId };
}

function Shell({ auth, onLogout }: { auth: AuthContext; onLogout: () => void }) {
  const { operators, operatorId, setOperatorId } = useOperator(auth);
  const location = useLocation();
  const canManageAgents = auth.role === 'platform_admin' || auth.role === 'operator_admin';
  const nav = [
    ['/', 'Overview'],
    ['/cards', 'Cards'],
    ['/terminals', 'Terminals'],
    ['/settlements', 'Settlements'],
    ['/topups', 'Agent top-ups'],
    ...(canManageAgents ? [['/agents', 'Agents']] : []),
  ];

  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><img src="/bextra-symbol.png" alt="" /><strong>BeXtra</strong></div>
        <nav aria-label="Primary navigation">
          {nav.map(([path, label]) => <Link className={location.pathname === path ? 'active' : ''} key={path} to={path}>{label}</Link>)}
        </nav>
      </aside>
      <div className="main">
        <header>
          <div>
            {!auth.operatorId && (
              <select aria-label="Operator" value={operatorId} onChange={(event) => setOperatorId(event.target.value)}>
                <option value="">Select operator</option>
                {operators.map((operator) => <option key={operator.id} value={operator.id}>{operator.name}</option>)}
              </select>
            )}
          </div>
          <div className="account"><span>{auth.externalId}</span><button onClick={onLogout}>Sign out</button></div>
        </header>
        {operatorId ? (
          <Routes>
            <Route path="/" element={<Overview operatorId={operatorId} />} />
            <Route path="/cards" element={<Cards operatorId={operatorId} />} />
            <Route path="/terminals" element={<Terminals operatorId={operatorId} />} />
            <Route path="/settlements" element={<Settlements operatorId={operatorId} />} />
            <Route path="/topups" element={<TopUps operatorId={operatorId} />} />
            {canManageAgents && <Route path="/agents" element={<AgentAdmin operatorId={operatorId} platformAdmin={auth.role === 'platform_admin'} />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : <main className="content empty"><h1>Select an operator</h1><p>Choose an operator to view portal data.</p></main>}
      </div>
    </div>
  );
}

function Overview({ operatorId }: { operatorId: string }) {
  const [data, setData] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    api<Record<string, number>>(`/v1/dashboard?operatorId=${operatorId}`)
      .then(setData).catch((caught) => setError(caught.message));
  }, [operatorId]);
  const items = [
    ['Active cards', data.cardCount],
    ['Posted taps', data.postedTapCount],
    ['Terminals', data.terminalCount],
    ['Queued terminals', data.queuedTerminalCount],
    ['Locked settlements', data.lockedSettlementCount],
    ['Risk events', data.riskEventCount],
  ] as const;
  return <main className="content"><PageTitle eyebrow="Live operations" title="Overview" /><StatusError error={error} /><section className="metric-grid">{items.map(([label, value]) => <article className="metric" key={label}><span>{label}</span><strong>{value ?? '-'}</strong></article>)}</section></main>;
}

function Cards({ operatorId }: { operatorId: string }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    api<{ items: Card[] }>(`/v1/cards?operatorId=${operatorId}`).then((result) => setCards(result.items)).catch((caught) => setError(caught.message));
  }, [operatorId]);
  async function setStatus(card: Card, status: 'blocked' | 'active') {
    if (status === 'active' && !reason.trim()) { setError('A written reason is required to unblock a card'); return; }
    try {
      await api(`/v1/cards/${card.id}/${status === 'blocked' ? 'block' : 'unblock'}?operatorId=${operatorId}`, { method: 'POST', body: JSON.stringify({ reason: status === 'blocked' ? 'Lost or compromised card' : reason }) });
      setCards((items) => items.map((item) => item.id === card.id ? { ...item, status } : item));
      setError('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Card action failed'); }
  }
  return <main className="content"><PageTitle eyebrow="Identity" title="Cards" /><StatusError error={error} /><label className="reason">Unblock reason<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Written review reason" /></label><Table columns={['Card', 'Status', 'Tier', 'Offline allowance', 'Action']} rows={cards.map((card) => [card.card_token, <Status key="status" value={card.status} />, card.tier, formatMinor(card.offline_allowance_minor), <div className="actions" key="action">{card.status === 'active' ? <button className="danger" onClick={() => setStatus(card, 'blocked')}>Block</button> : <button onClick={() => setStatus(card, 'active')}>Unblock</button>}</div>])} /></main>;
}

function Terminals({ operatorId }: { operatorId: string }) {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api<{ items: Terminal[] }>(`/v1/terminals?operatorId=${operatorId}`).then((result) => setTerminals(result.items)).catch((caught) => setError(caught.message)); }, [operatorId]);
  return <main className="content"><PageTitle eyebrow="Fleet" title="Terminals" /><StatusError error={error} /><Table columns={['Terminal', 'Status', 'Last heartbeat', 'Queue', 'Blocked-list version']} rows={terminals.map((terminal) => [terminal.name, <Status key="status" value={terminal.status} />, terminal.last_heartbeat_at ? new Date(terminal.last_heartbeat_at).toLocaleString() : 'Never', terminal.offline_queue_count, terminal.blocked_list_version])} /></main>;
}

function Settlements({ operatorId }: { operatorId: string }) {
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [error, setError] = useState('');
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [overrideReason, setOverrideReason] = useState('');
  async function load() { try { const result = await api<{ items: Settlement[] }>(`/v1/settlements?operatorId=${operatorId}`); setSettlements(result.items); setError(''); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load settlements'); } }
  useEffect(() => { void load(); }, [operatorId]);
  async function run() { try { await api('/v1/settlements/run', { method: 'POST', body: JSON.stringify({ operatorId, businessDay: day }) }); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Settlement run failed'); } }
  async function override(item: Settlement) {
    if (!overrideReason.trim()) { setError('Written override reason required'); return; }
    try {
      await api(`/v1/settlements/${item.id}/override`, { method: 'POST', body: JSON.stringify({ operatorId, reason: overrideReason }) });
      setOverrideReason('');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Settlement override failed'); }
  }
  async function payout(item: Settlement) {
    try {
      await api(`/v1/settlements/${item.id}/payout`, { method: 'POST', body: JSON.stringify({ operatorId }) });
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Payout failed'); }
  }
  return <main className="content"><PageTitle eyebrow="Finance" title="Settlements" /><StatusError error={error} /><div className="toolbar"><label>Business day<input type="date" value={day} onChange={(event) => setDay(event.target.value)} /></label><label>Override reason<input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Written finance reason" /></label><button className="primary" onClick={run}>Run reconciliation</button></div><Table columns={['Business day', 'Posted total', 'Difference', 'Status', 'Action']} rows={settlements.map((item) => [item.business_day, formatMinor(item.posted_minor), formatMinor(item.difference_minor), <Status key="status" value={item.status} />, <div className="actions" key="action">{item.status === 'locked' && <button onClick={() => override(item)}>Override</button>}{item.status === 'approved' && <button className="primary" onClick={() => payout(item)}>Payout</button>}</div>])} /></main>;
}

function TopUps({ operatorId }: { operatorId: string }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [agentId, setAgentId] = useState('');
  const [cardId, setCardId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  useEffect(() => {
    Promise.all([
      api<{ items: Agent[] }>(`/v1/agents?operatorId=${operatorId}`),
      api<{ items: Card[] }>(`/v1/cards?operatorId=${operatorId}`),
    ]).then(([agentResult, cardResult]) => { setAgents(agentResult.items); setCards(cardResult.items); setError(''); }).catch((caught) => setError(caught.message));
  }, [operatorId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(''); setResult('');
    try {
      const response = await api<{ status: string; fundingRequestId: string }>('/v1/agents/topups', { method: 'POST', body: JSON.stringify({ operatorId, agentId, cardId, amountMinor: Number(amount) }) });
      setResult(`${response.status === 'confirmed' ? 'Top-up confirmed' : 'Duplicate request'} · ${response.fundingRequestId}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Top-up failed'); }
  }
  return <main className="content"><PageTitle eyebrow="Agent operations" title="Top-up card" /><StatusError error={error} /><div className="topup-layout"><form className="panel form" onSubmit={submit}><label>Agent<select value={agentId} onChange={(event) => setAgentId(event.target.value)} required><option value="">Select agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label>Card<select value={cardId} onChange={(event) => setCardId(event.target.value)} required><option value="">Select card</option>{cards.map((card) => <option key={card.id} value={card.id}>{card.card_token}</option>)}</select></label><label>Amount in tambala<input type="number" min="1" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label><button className="primary" type="submit">Confirm top-up</button>{result && <p className="success" role="status">{result}</p>}</form><section className="panel"><h2>Agent float</h2>{agents.map((agent) => <div className="agent-row" key={agent.id}><div><strong>{agent.name}</strong><span>{agent.commission_bps / 100}% commission</span></div><strong>{formatMinor(agent.floatMinor)}</strong></div>)}</section></div></main>;
}

function AgentAdmin({ operatorId, platformAdmin }: { operatorId: string; platformAdmin: boolean }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [location, setLocation] = useState('');
  const [commissionPercent, setCommissionPercent] = useState('');
  const [invitation, setInvitation] = useState<{ token: string; expiresAt: string; agentName: string } | null>(null);
  const [statusDrafts, setStatusDrafts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function loadAgents() {
    setLoading(true);
    try {
      const result = await api<{ items: Agent[] }>(
        `/v1/agents?operatorId=${encodeURIComponent(operatorId)}&page=1&pageSize=100`,
      );
      setAgents(result.items);
      setError('');
    } catch (caught) {
      setError(formatAgentError(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAgents();
  }, [operatorId]);

  async function createAgent(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');
    setInvitation(null);
    setBusy(true);
    try {
      const response = await api<{
        agent: Agent;
        setupToken: string;
        setupExpiresAt: string;
      }>('/v1/agents', {
        method: 'POST',
        body: JSON.stringify({
          ...(platformAdmin ? { operatorId } : {}),
          name,
          phone,
          ...(location.trim() ? { location: location.trim() } : {}),
          ...(commissionPercent.trim() ? { commissionBps: Math.round(Number(commissionPercent) * 100) } : {}),
        }),
      });
      setInvitation({
        token: response.setupToken,
        expiresAt: response.setupExpiresAt,
        agentName: response.agent.name,
      });
      setSuccess(`Agent ${response.agent.name} was created. The setup token is shown once below.`);
      setName('');
      setPhone('');
      setLocation('');
      setCommissionPercent('');
      await loadAgents();
    } catch (caught) {
      setError(formatAgentError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function reissueInvitation(agent: Agent) {
    const confirmed = window.confirm(
      `Reissue an invitation for ${agent.name}? This disables the agent's current password and PIN. The new setup token will be shown once.`,
    );
    if (!confirmed) return;
    setError('');
    setSuccess('');
    setInvitation(null);
    setBusy(true);
    try {
      const response = await api<{ setupToken: string; setupExpiresAt: string }>(
        `/v1/agents/${encodeURIComponent(agent.id)}/invitation?operatorId=${encodeURIComponent(operatorId)}`,
        { method: 'POST' },
      );
      setInvitation({ token: response.setupToken, expiresAt: response.setupExpiresAt, agentName: agent.name });
      setSuccess(`A new setup token was generated for ${agent.name}. The previous password and PIN are disabled.`);
      await loadAgents();
    } catch (caught) {
      setError(formatAgentError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function changeAgentStatus(agent: Agent) {
    const status = statusDrafts[agent.id] ?? (agent.status === 'active' ? 'inactive' : 'active');
    const reason = reasons[agent.id]?.trim() ?? '';
    if (!reason) {
      setError(`Enter a written reason before changing ${agent.name}'s status.`);
      return;
    }
    setError('');
    setSuccess('');
    setInvitation(null);
    setBusy(true);
    try {
      await api(`/v1/agents/${encodeURIComponent(agent.id)}/status?operatorId=${encodeURIComponent(operatorId)}`, {
        method: 'POST',
        body: JSON.stringify({ status, reason }),
      });
      setSuccess(`${agent.name}'s status was changed to ${status}.`);
      setReasons((current) => ({ ...current, [agent.id]: '' }));
      await loadAgents();
    } catch (caught) {
      setError(formatAgentError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function copyInvitationToken() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.token);
      setSuccess(`Setup token for ${invitation.agentName} copied. Deliver it securely before it expires.`);
    } catch {
      setError('Could not access the clipboard. Select and copy the token manually, then deliver it securely.');
    }
  }

  return (
    <main className="content">
      <PageTitle eyebrow="Access management" title="Agents" />
      <StatusError error={error} />
      {success && <p className="success panel-error" role="status">{success}</p>}

      <form className="panel agent-create" onSubmit={createAgent}>
        <h2>Create agent account</h2>
        <p className="muted">The agent remains inactive until they set their own password and PIN.</p>
        <div className="agent-form-grid">
          <label>Full name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></label>
          <label>Phone number<input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+265..." autoComplete="tel" required /></label>
          <label>General location <span className="optional">(optional)</span><input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={200} /></label>
          <label>Commission percent <span className="optional">(optional, defaults to 1%)</span><input type="number" min="0" max="100" step="0.01" value={commissionPercent} onChange={(event) => setCommissionPercent(event.target.value)} /></label>
        </div>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Working...' : 'Create agent'}</button>
      </form>

      {invitation && (
        <section className="panel invitation-panel" aria-live="polite">
          <h2>One-time setup token for {invitation.agentName}</h2>
          <p role="alert">No SMS is sent. Deliver this token to the agent securely. It will not be shown again after you leave or refresh this page.</p>
          <p className="muted">Expires {new Date(invitation.expiresAt).toLocaleString()}</p>
          <div className="token-row">
            <input aria-label="One-time setup token" readOnly value={invitation.token} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" onClick={copyInvitationToken}>Copy token</button>
            <button type="button" onClick={() => setInvitation(null)}>Hide token</button>
          </div>
        </section>
      )}

      <section className="agents-section">
        <div className="section-heading">
          <div><h2>Agent accounts</h2><p className="muted">Invitation tokens are never saved by the portal.</p></div>
          <button type="button" onClick={() => void loadAgents()} disabled={loading || busy}>{loading ? 'Loading...' : 'Refresh'}</button>
        </div>
        {loading ? <p className="panel" role="status">Loading agents...</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Phone</th><th>Location</th><th>Status</th><th>Float balance</th><th>Invitation</th><th>Actions</th></tr></thead>
              <tbody>
                {agents.map((agent) => {
                  const targetStatus = statusDrafts[agent.id] ?? (agent.status === 'active' ? 'inactive' : 'active');
                  return (
                    <tr key={agent.id}>
                      <td>{agent.name}</td>
                      <td>{agent.phone}</td>
                      <td>{agent.location || 'Not provided'}</td>
                      <td><Status value={agent.status} /></td>
                      <td>{formatMinor(agent.floatMinor)}</td>
                      <td>
                        {agent.invitationPending
                          ? <span>Pending until {agent.invitationExpiresAt ? new Date(agent.invitationExpiresAt).toLocaleString() : 'expiry'}</span>
                          : 'Not pending'}
                      </td>
                      <td className="agent-actions">
                        <button type="button" onClick={() => void reissueInvitation(agent)} disabled={busy}>
                          {agent.invitationPending ? 'Reissue invite' : 'Issue invite'}
                        </button>
                        <label className="status-control">Set status
                          <select value={targetStatus} onChange={(event) => setStatusDrafts((current) => ({ ...current, [agent.id]: event.target.value }))} disabled={busy}>
                            <option value="active">Active</option>
                            <option value="inactive">Inactive</option>
                            <option value="blocked">Blocked</option>
                          </select>
                        </label>
                        <label className="status-control">Reason
                          <input value={reasons[agent.id] ?? ''} onChange={(event) => setReasons((current) => ({ ...current, [agent.id]: event.target.value }))} maxLength={500} required placeholder="Written reason" />
                        </label>
                        <button type="button" onClick={() => void changeAgentStatus(agent)} disabled={busy}>Update status</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {agents.length === 0 && <p className="empty-table">{error ? 'Agent list could not be loaded.' : 'No agents found for this operator.'}</p>}
          </div>
        )}
      </section>
    </main>
  );
}

function formatAgentError(error: unknown) {
  if (error instanceof ApiError && error.code === 'AGENT_SETUP_REQUIRED') {
    return 'This agent must complete account setup before they can be activated.';
  }
  if (error instanceof ApiError && error.code) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : 'Agent action failed. Try again.';
}

function PageTitle({ eyebrow, title }: { eyebrow: string; title: string }) { return <div className="page-title"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>; }
function StatusError({ error }: { error: string }) { return error ? <p className="error panel-error" role="alert">{error}</p> : null; }
function formatMinor(value: number | bigint | undefined) { return `${(Number(value ?? 0) / 100).toLocaleString('en-MW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MWK`; }
function Status({ value }: { value: string }) { const state = value === 'active' || value === 'approved' || value === 'paid' ? 'good' : value === 'locked' || value === 'blocked' ? 'bad' : 'neutral'; return <span className={`status ${state}`}><i />{value}</span>; }
function Table({ columns, rows }: { columns: string[]; rows: unknown[][] }) { return <div className="table-wrap"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell as ReactNode}</td>)}</tr>)}</tbody></table>{rows.length === 0 && <p className="empty-table">No records found</p>}</div>; }

export default function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const stored = sessionStorage.getItem('bextra-session');
    return stored ? JSON.parse(stored) as Session : null;
  });
  function login(next: Session) { sessionStorage.setItem('bextra-session', JSON.stringify(next)); setSession(next); }
  function logout() { sessionStorage.removeItem('bextra-session'); setSession(null); }
  if (!session) return <Login onLogin={login} />;
  return <Shell auth={session.auth} onLogout={logout} />;
}
