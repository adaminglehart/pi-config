import { Honcho } from "@honcho-ai/sdk";

const API = "http://api:8000";

// --- Honcho SDK helpers ---

async function listWorkspaces() {
  const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: "pi" });
  const workspaces = await honcho.workspaces();
  return { 
    items: workspaces.items.map(ws => ({ id: ws, metadata: {}, configuration: {}, created_at: "" })), 
    total: workspaces.items.length, 
    page: 1, 
    size: workspaces.items.length, 
    pages: 1 
  };
}

async function listPeers(ws: string) {
  const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
  return honcho.peers();
}

async function listSessions(ws: string) {
  const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
  return honcho.sessions();
}

async function listConclusions(ws: string, page = 1, size = 50) {
  // For workspace-wide conclusions, use raw API since SDK requires peer scope
  const res = await fetch(`${API}/v3/workspaces/${ws}/conclusions/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page, size })
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<Page<Conclusion>>;
}

async function listMessages(ws: string, sid: string, page = 1, size = 50) {
  const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
  const session = await honcho.session(sid);
  return session.messages({ page, pageSize: size });
}

async function getRepresentation(ws: string, observer: string, target: string) {
  const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
  const peer = await honcho.peer(observer);
  const rep = await peer.representation({ target });
  return { representation: rep };
}

async function getSummaries(ws: string, sid: string) {
  try {
    const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
    const session = await honcho.session(sid);
    return await session.summaries();
  } catch {
    return null;
  }
}

async function getQueueStatus(ws: string) {
  try {
    const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
    return await honcho.queueStatus();
  } catch {
    return null;
  }
}

async function getPeerCard(ws: string, peerId: string) {
  try {
    const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
    const peer = await honcho.peer(peerId);
    const card = await peer.card();
    return { peer_card: card ? card.join("\n") : null };
  } catch {
    return null;
  }
}

async function getPeerSessions(ws: string, peerId: string) {
  const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
  const peer = await honcho.peer(peerId);
  return peer.sessions();
}

async function getPeerContext(ws: string, peerId: string) {
  try {
    const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
    const peer = await honcho.peer(peerId);
    const context = await peer.context();
    return {
      peer_id: context.peerId,
      target_id: context.targetId,
      representation: context.representation,
      peer_card: context.peerCard ? context.peerCard.join("\n") : null,
    };
  } catch {
    return null;
  }
}

async function queryConclusions(ws: string, query: string) {
  const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
  const results = await honcho.search(query, { pageSize: 10 });
  return results.items;
}

async function getPeerAgentContext(ws: string, peerId: string, sessionId: string) {
  try {
    const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
    const session = await honcho.session(sessionId);
    const context = await session.context({
      tokens: 2000,
      peerTarget: peerId,
    });
    return context.peerRepresentation;
  } catch {
    return null;
  }
}

// --- Types ---

interface Page<T> { items: T[]; total: number; page: number; size: number; pages: number }
interface Workspace { id: string; metadata: Record<string, unknown>; configuration: Record<string, unknown>; created_at: string }
interface Peer { id: string; workspace_id: string; created_at: string; metadata: Record<string, unknown>; configuration: Record<string, unknown> }
interface Session { id: string; created_at: string; metadata: Record<string, unknown>; configuration: Record<string, unknown> }
interface Conclusion { id: string; content: string; observer_id: string; observed_id: string; session_id: string; created_at: string }
interface Message { id: string; content: string; peer_id: string; session_id: string; created_at: string; token_count: number; metadata: Record<string, unknown> }
interface Summary { content: string; message_id: string; summary_type: string; created_at: string; token_count: number }
interface Summaries { id: string; short_summary: Summary | null; long_summary: Summary | null }
interface QueueStatus { total_work_units: number; completed_work_units: number; in_progress_work_units: number; pending_work_units: number; sessions: Record<string, unknown> }

// --- HTML rendering ---

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function layout(title: string, nav: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Honcho Dashboard</title>
<style>
  :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --orange: #d29922; --red: #f85149; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  a.card { display: block; color: var(--text); } a.card:hover { text-decoration: none; border-color: var(--accent); }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
  nav { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 16px; display: flex; align-items: center; gap: 16px; }
  nav .brand { font-weight: 600; font-size: 16px; color: var(--text); } nav .brand span { color: var(--accent); }
  nav a { color: var(--muted); font-size: 14px; } nav a:hover, nav a.active { color: var(--text); }
  h1 { font-size: 24px; margin-bottom: 16px; } h2 { font-size: 18px; margin: 24px 0 12px; color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .card h3 { font-size: 16px; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .stat { text-align: center; padding: 20px; }
  .stat .value { font-size: 32px; font-weight: 700; color: var(--accent); }
  .stat .label { font-size: 13px; color: var(--muted); margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:hover td { background: rgba(88,166,255,0.04); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
  .badge-blue { background: rgba(88,166,255,0.15); color: var(--accent); }
  .badge-green { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-orange { background: rgba(210,153,34,0.15); color: var(--orange); }
  .content-preview { color: var(--muted); font-size: 13px; max-width: 600px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .content-full { white-space: pre-wrap; font-size: 13px; color: var(--text); background: var(--bg); padding: 12px; border-radius: 6px; margin-top: 8px; max-height: 400px; overflow-y: auto; }
  .meta { font-size: 12px; color: var(--muted); }
  .progress { background: var(--border); border-radius: 4px; height: 8px; overflow: hidden; margin-top: 6px; }
  .progress-bar { background: var(--green); height: 100%; transition: width 0.3s; }
  .empty { color: var(--muted); font-style: italic; padding: 24px; text-align: center; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
  .tabs a { padding: 6px 14px; border-radius: 6px; font-size: 14px; color: var(--muted); background: transparent; }
  .tabs a:hover { background: var(--surface); color: var(--text); text-decoration: none; }
  .tabs a.active { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
</style>
</head>
<body>
<nav>
  <div class="brand">🧠 <span>Honcho</span></div>
  ${nav}
</nav>
<div class="container">${content}</div>
</body></html>`;
}

function navLinks(ws?: string, active?: string): string {
  const links = [`<a href="/" class="${active === "home" ? "active" : ""}">Workspaces</a>`];
  if (ws) {
    links.push(`<a href="/w/${esc(ws)}" class="${active === "overview" ? "active" : ""}">Overview</a>`);
    links.push(`<a href="/w/${esc(ws)}/peers" class="${active === "peers" ? "active" : ""}">Peers</a>`);
    links.push(`<a href="/w/${esc(ws)}/sessions" class="${active === "sessions" ? "active" : ""}">Sessions</a>`);
    links.push(`<a href="/w/${esc(ws)}/conclusions" class="${active === "conclusions" ? "active" : ""}">Conclusions</a>`);
    links.push(`<a href="/w/${esc(ws)}/queue" class="${active === "queue" ? "active" : ""}">Queue</a>`);
  }
  return links.join("");
}

// --- Route handlers ---

async function handleHome(): Promise<string> {
  const { items } = await listWorkspaces();
  let rows = "";
  for (const ws of items) {
    const peers = await listPeers(ws.id);
    const sessions = await listSessions(ws.id);
    const conclusions = await listConclusions(ws.id, 1, 1);
    rows += `<tr>
      <td><a href="/w/${esc(ws.id)}">${esc(ws.id)}</a></td>
      <td><a href="/w/${esc(ws.id)}/peers">${peers.total}</a></td>
      <td><a href="/w/${esc(ws.id)}/sessions">${sessions.total}</a></td>
      <td><a href="/w/${esc(ws.id)}/conclusions">${conclusions.total}</a></td>
      <td class="meta">${timeAgo(ws.created_at)}</td>
    </tr>`;
  }
  return layout("Workspaces", navLinks(undefined, "home"), `
    <h1>Workspaces</h1>
    <table><tr><th>Workspace</th><th>Peers</th><th>Sessions</th><th>Conclusions</th><th>Created</th></tr>${rows}</table>
    ${items.length === 0 ? '<div class="empty">No workspaces yet</div>' : ""}
  `);
}

async function handleWorkspace(ws: string): Promise<string> {
  const peers = await listPeers(ws);
  const sessions = await listSessions(ws);
  const conclusions = await listConclusions(ws, 1, 1);
  const queue = await getQueueStatus(ws);

  // Get representations for each peer pair
  let repHtml = "";
  for (const observer of peers.items) {
    for (const target of peers.items) {
      if (observer.id === target.id) continue;
      try {
        const { representation } = await getRepresentation(ws, observer.id, target.id);
        if (representation) {
          repHtml += `<div class="card">
            <h3><a href="/w/${esc(ws)}/peers/${esc(observer.id)}"><span class="badge badge-blue">${esc(observer.id)}</span></a> → <a href="/w/${esc(ws)}/peers/${esc(target.id)}"><span class="badge badge-green">${esc(target.id)}</span></a></h3>
            <div class="content-full">${esc(representation)}</div>
          </div>`;
        }
      } catch { /* no representation */ }
    }
  }

  const pct = queue ? Math.round((queue.completed_work_units / Math.max(queue.total_work_units, 1)) * 100) : 0;

  return layout(`${ws}`, navLinks(ws, "overview"), `
    <h1>${esc(ws)}</h1>
    <div class="grid">
      <a href="/w/${esc(ws)}/peers" class="card stat"><div class="value">${peers.total}</div><div class="label">Peers</div></a>
      <a href="/w/${esc(ws)}/sessions" class="card stat"><div class="value">${sessions.total}</div><div class="label">Sessions</div></a>
      <a href="/w/${esc(ws)}/conclusions" class="card stat"><div class="value">${conclusions.total}</div><div class="label">Conclusions</div></a>
    </div>
    ${queue ? `
    <h2>Deriver Queue</h2>
    <div class="card">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span>${queue.completed_work_units} / ${queue.total_work_units} work units</span>
        <span class="badge ${pct === 100 ? "badge-green" : "badge-orange"}">${pct}%</span>
      </div>
      <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="meta" style="margin-top:8px">Pending: ${queue.pending_work_units} · In progress: ${queue.in_progress_work_units}</div>
    </div>` : ""}
    ${repHtml ? `<h2>Representations</h2>${repHtml}` : ""}
  `);
}

async function handlePeers(ws: string): Promise<string> {
  const { items } = await listPeers(ws);
  let html = "";
  for (const peer of items) {
    const card = await getPeerCard(ws, peer.id);
    const sessions = await getPeerSessions(ws, peer.id);
    html += `<div class="card">
      <h3><a href="/w/${esc(ws)}/peers/${esc(peer.id)}">${esc(peer.id)}</a></h3>
      <div class="meta">Created ${timeAgo(peer.created_at)} · <a href="/w/${esc(ws)}/peers/${esc(peer.id)}">${sessions.total} session${sessions.total !== 1 ? "s" : ""}</a></div>
      ${card?.peer_card ? `<div class="content-full">${esc(card.peer_card)}</div>` : ""}
      ${Object.keys(peer.metadata).length > 0 ? `<div class="meta" style="margin-top:8px">Metadata: ${esc(JSON.stringify(peer.metadata))}</div>` : ""}
      ${Object.keys(peer.configuration).length > 0 ? `<div class="meta">Config: ${esc(JSON.stringify(peer.configuration))}</div>` : ""}
    </div>`;
  }
  return layout(`Peers — ${ws}`, navLinks(ws, "peers"), `
    <h1>Peers</h1>
    ${html || '<div class="empty">No peers</div>'}
  `);
}

async function handlePeer(ws: string, peerId: string): Promise<string> {
  // Fetch all data in parallel
  const [allPeers, card, sessions, context, allConclusions] = await Promise.all([
    listPeers(ws),
    getPeerCard(ws, peerId),
    getPeerSessions(ws, peerId),
    getPeerContext(ws, peerId),
    listConclusions(ws, 1, 200),
  ]);

  // Representations: what this peer knows about others, and what others know about this peer
  // Fetch all representations in parallel
  let repHtml = "";
  const repPromises: Promise<void>[] = [];
  const repResults: string[] = [];
  
  for (const other of allPeers.items) {
    if (other.id === peerId) continue;
    
    // This peer's view of others
    repPromises.push(
      getRepresentation(ws, peerId, other.id)
        .then(({ representation }) => {
          if (representation) {
            repResults.push(`<div class="card">
              <h3>${esc(peerId)}'s view of <a href="/w/${esc(ws)}/peers/${esc(other.id)}"><span class="badge badge-green">${esc(other.id)}</span></a></h3>
              <div class="content-full">${esc(representation)}</div>
            </div>`);
          }
        })
        .catch(() => {})
    );
    
    // Others' view of this peer
    repPromises.push(
      getRepresentation(ws, other.id, peerId)
        .then(({ representation }) => {
          if (representation) {
            repResults.push(`<div class="card">
              <h3><a href="/w/${esc(ws)}/peers/${esc(other.id)}"><span class="badge badge-blue">${esc(other.id)}</span></a>'s view of ${esc(peerId)}</h3>
              <div class="content-full">${esc(representation)}</div>
            </div>`);
          }
        })
        .catch(() => {})
    );
  }
  
  await Promise.all(repPromises);
  repHtml = repResults.join("");

  // Conclusions about this peer (filter client-side from cached fetch)
  const aboutPeer = allConclusions.items.filter(c => c.observed_id === peerId);
  const byPeer = allConclusions.items.filter(c => c.observer_id === peerId);

  let conclusionHtml = "";
  if (aboutPeer.length > 0) {
    conclusionHtml += `<h2>Conclusions about ${esc(peerId)} (${aboutPeer.length})</h2>`;
    for (const c of aboutPeer) {
      conclusionHtml += `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:start">
          <div style="flex:1;white-space:pre-wrap;font-size:13px">${esc(c.content)}</div>
          <div class="meta" style="margin-left:12px;white-space:nowrap">by <a href="/w/${esc(ws)}/peers/${esc(c.observer_id)}"><span class="badge badge-blue">${esc(c.observer_id)}</span></a><br>${timeAgo(c.created_at)}</div>
        </div>
      </div>`;
    }
  }
  if (byPeer.length > 0) {
    conclusionHtml += `<h2>Conclusions by ${esc(peerId)} (${byPeer.length})</h2>`;
    for (const c of byPeer.slice(0, 20)) {
      conclusionHtml += `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:start">
          <div style="flex:1;white-space:pre-wrap;font-size:13px">${esc(c.content)}</div>
          <div class="meta" style="margin-left:12px;white-space:nowrap">about <a href="/w/${esc(ws)}/peers/${esc(c.observed_id)}"><span class="badge badge-green">${esc(c.observed_id)}</span></a><br>${timeAgo(c.created_at)}</div>
        </div>
      </div>`;
    }
    if (byPeer.length > 20) {
      conclusionHtml += `<div class="meta">…and ${byPeer.length - 20} more</div>`;
    }
  }

  // Sessions list
  let sessionHtml = "";
  for (const s of sessions.items) {
    sessionHtml += `<tr>
      <td><a href="/w/${esc(ws)}/sessions/${esc(s.id)}">${esc(s.id)}</a></td>
      <td>${s.metadata?.name ? esc(String(s.metadata.name)) : ""}</td>
      <td class="meta">${timeAgo(s.created_at)}</td>
    </tr>`;
  }

  return layout(`${peerId} — ${ws}`, navLinks(ws, "peers"), `
    <h1>${esc(peerId)}</h1>
    ${card?.peer_card ? `<div class="card"><h3>Peer Card</h3><div class="content-full">${esc(card.peer_card)}</div></div>` : ""}
    ${context?.representation ? `<div class="card" style="background:#e0f2fe;border-left:4px solid #0284c7"><h3 style="color:#0c4a6e">🤖 Agent Context</h3><div class="meta" style="margin-bottom:12px;color:#0c4a6e">What gets injected into the AI agent's system prompt</div><div class="content-full" style="white-space:pre-wrap">${esc(context.representation)}</div></div>` : ""}
    <h2>Chat</h2>
    <div class="card">
      <div class="meta" style="margin-bottom:12px">Ask Honcho anything about this peer using natural language</div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input id="chat-input" type="text" placeholder="e.g. What are this user's coding preferences?" style="flex:1;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:14px">
        <button id="chat-btn" onclick="sendChat()" style="padding:8px 16px;background:#0284c7;color:white;border:none;border-radius:4px;cursor:pointer;white-space:nowrap">Ask</button>
      </div>
      <div id="chat-response" style="white-space:pre-wrap;display:none"></div>
    </div>
    <script>
      document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
      async function sendChat() {
        const input = document.getElementById('chat-input');
        const btn = document.getElementById('chat-btn');
        const response = document.getElementById('chat-response');
        const query = input.value.trim();
        if (!query) return;
        btn.textContent = '...';
        btn.disabled = true;
        response.style.display = 'none';
        try {
          const res = await fetch('/w/${esc(ws)}/peers/${esc(peerId)}/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
          });
          const data = await res.json();
          response.textContent = data.content;
          response.style.display = 'block';
        } catch (err) {
          response.textContent = 'Error: ' + err;
          response.style.display = 'block';
        } finally {
          btn.textContent = 'Ask';
          btn.disabled = false;
        }
      }
    </script>
    ${repHtml ? `<h2>Representations</h2>${repHtml}` : ""}
    ${conclusionHtml}
    ${sessions.items.length > 0 ? `<h2>Sessions (${sessions.total})</h2><table><tr><th>Session</th><th>Name</th><th>Created</th></tr>${sessionHtml}</table>` : ""}
  `);
}

async function handleSessions(ws: string): Promise<string> {
  const { items } = await listSessions(ws);
  let rows = "";
  for (const s of items) {
    const msgs = await listMessages(ws, s.id, 1, 1);
    rows += `<tr>
      <td><a href="/w/${esc(ws)}/sessions/${esc(s.id)}">${esc(s.id)}</a></td>
      <td>${msgs.total}</td>
      <td>${s.metadata?.name ? esc(String(s.metadata.name)) : ""}</td>
      <td class="meta">${timeAgo(s.created_at)}</td>
    </tr>`;
  }
  return layout(`Sessions — ${ws}`, navLinks(ws, "sessions"), `
    <h1>Sessions</h1>
    <table><tr><th>Session</th><th>Messages</th><th>Name</th><th>Created</th></tr>${rows}</table>
    ${items.length === 0 ? '<div class="empty">No sessions</div>' : ""}
  `);
}

async function handleSession(ws: string, sid: string): Promise<string> {
  const msgs = await listMessages(ws, sid, 1, 100);
  const summaries = await getSummaries(ws, sid);

  let msgHtml = "";
  for (const m of msgs.items) {
    const content = m.content.length > 300 ? m.content.slice(0, 300) + "…" : m.content;
    msgHtml += `<tr>
      <td><a href="/w/${esc(ws)}/peers/${esc(m.peer_id)}"><span class="badge badge-blue">${esc(m.peer_id)}</span></a></td>
      <td style="max-width:600px;white-space:pre-wrap;font-size:13px">${esc(content)}</td>
      <td class="meta">${m.token_count}</td>
      <td class="meta">${timeAgo(m.created_at)}</td>
    </tr>`;
  }

  let summaryHtml = "";
  if (summaries?.short_summary) {
    summaryHtml += `<div class="card"><h3>Short Summary <span class="meta">(${summaries.short_summary.token_count} tokens)</span></h3><div class="content-full">${esc(summaries.short_summary.content)}</div></div>`;
  }
  if (summaries?.long_summary) {
    summaryHtml += `<div class="card"><h3>Long Summary <span class="meta">(${summaries.long_summary.token_count} tokens)</span></h3><div class="content-full">${esc(summaries.long_summary.content)}</div></div>`;
  }

  return layout(`Session ${sid}`, navLinks(ws, "sessions"), `
    <h1>${esc(sid)}</h1>
    ${summaryHtml ? `<h2>Summaries</h2>${summaryHtml}` : ""}
    <h2>Messages (${msgs.total})</h2>
    <table><tr><th>Peer</th><th>Content</th><th>Tokens</th><th>Time</th></tr>${msgHtml}</table>
    ${msgs.total > 100 ? `<div class="meta" style="padding:12px">Showing first 100 of ${msgs.total} messages</div>` : ""}
  `);
}

async function handleConclusions(ws: string, page: number): Promise<string> {
  const data = await listConclusions(ws, page, 30);

  // Group by observer→observed
  let rows = "";
  for (const c of data.items) {
    rows += `<tr>
      <td><a href="/w/${esc(ws)}/peers/${esc(c.observer_id)}"><span class="badge badge-blue">${esc(c.observer_id)}</span></a> → <a href="/w/${esc(ws)}/peers/${esc(c.observed_id)}"><span class="badge badge-green">${esc(c.observed_id)}</span></a></td>
      <td style="max-width:600px;white-space:pre-wrap;font-size:13px">${esc(c.content)}</td>
      <td class="meta"><a href="/w/${esc(ws)}/sessions/${esc(c.session_id)}">${esc(c.session_id)}</a></td>
      <td class="meta">${timeAgo(c.created_at)}</td>
    </tr>`;
  }

  let pager = "";
  if (data.pages > 1) {
    const links: string[] = [];
    for (let i = 1; i <= data.pages; i++) {
      links.push(i === page ? `<span class="badge badge-blue">${i}</span>` : `<a href="/w/${esc(ws)}/conclusions?page=${i}">${i}</a>`);
    }
    pager = `<div style="margin-top:12px;display:flex;gap:8px;align-items:center">${links.join("")}</div>`;
  }

  return layout(`Conclusions — ${ws}`, navLinks(ws, "conclusions"), `
    <h1>Conclusions <span class="meta">(${data.total} total)</span></h1>
    <table><tr><th>Scope</th><th>Content</th><th>Session</th><th>Time</th></tr>${rows}</table>
    ${data.items.length === 0 ? '<div class="empty">No conclusions</div>' : ""}
    ${pager}
  `);
}

async function handleQueue(ws: string): Promise<string> {
  const queue = await getQueueStatus(ws);
  if (!queue) return layout(`Queue — ${ws}`, navLinks(ws, "queue"), `<div class="empty">Queue status unavailable</div>`);

  const pct = Math.round((queue.completed_work_units / Math.max(queue.total_work_units, 1)) * 100);
  let sessionRows = "";
  for (const [sid, status] of Object.entries(queue.sessions)) {
    const s = status as { session_id: string; total_work_units: number; completed_work_units: number; pending_work_units: number; in_progress_work_units: number };
    const sPct = Math.round((s.completed_work_units / Math.max(s.total_work_units, 1)) * 100);
    sessionRows += `<tr>
      <td><a href="/w/${esc(ws)}/sessions/${esc(s.session_id)}">${esc(s.session_id)}</a></td>
      <td>${s.completed_work_units} / ${s.total_work_units}</td>
      <td>${s.pending_work_units}</td>
      <td>${s.in_progress_work_units}</td>
      <td><span class="badge ${sPct === 100 ? "badge-green" : "badge-orange"}">${sPct}%</span></td>
    </tr>`;
  }

  return layout(`Queue — ${ws}`, navLinks(ws, "queue"), `
    <h1>Deriver Queue</h1>
    <div class="card">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span>${queue.completed_work_units} / ${queue.total_work_units} work units</span>
        <span class="badge ${pct === 100 ? "badge-green" : "badge-orange"}">${pct}%</span>
      </div>
      <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
    </div>
    <h2>Sessions</h2>
    <table><tr><th>Session</th><th>Completed</th><th>Pending</th><th>In Progress</th><th>Status</th></tr>${sessionRows}</table>
  `);
}

// --- Router ---

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // /
      if (path === "/" || path === "") {
        return new Response(await handleHome(), { headers: { "Content-Type": "text/html" } });
      }

      // /w/:ws
      const wsMatch = path.match(/^\/w\/([^/]+)$/);
      if (wsMatch) {
        return new Response(await handleWorkspace(decodeURIComponent(wsMatch[1])), { headers: { "Content-Type": "text/html" } });
      }

      // /w/:ws/peers/:peerId/chat (API endpoint)
      const peerChatMatch = path.match(/^\/w\/([^/]+)\/peers\/([^/]+)\/chat$/);
      if (peerChatMatch && req.method === "POST") {
        const ws = decodeURIComponent(peerChatMatch[1]);
        const peerId = decodeURIComponent(peerChatMatch[2]);
        const body = await req.json() as { query: string };
        const honcho = new Honcho({ baseURL: API, apiKey: "none", workspaceId: ws });
        const peer = await honcho.peer(peerId);
        const content = await peer.chat(body.query);
        return new Response(JSON.stringify({ content }), { headers: { "Content-Type": "application/json" } });
      }

      // /w/:ws/peers/:peerId
      const peerMatch = path.match(/^\/w\/([^/]+)\/peers\/([^/]+)$/);
      if (peerMatch) {
        return new Response(await handlePeer(decodeURIComponent(peerMatch[1]), decodeURIComponent(peerMatch[2])), { headers: { "Content-Type": "text/html" } });
      }

      // /w/:ws/peers
      const peersMatch = path.match(/^\/w\/([^/]+)\/peers$/);
      if (peersMatch) {
        return new Response(await handlePeers(decodeURIComponent(peersMatch[1])), { headers: { "Content-Type": "text/html" } });
      }

      // /w/:ws/sessions
      const sessionsMatch = path.match(/^\/w\/([^/]+)\/sessions$/);
      if (sessionsMatch) {
        return new Response(await handleSessions(decodeURIComponent(sessionsMatch[1])), { headers: { "Content-Type": "text/html" } });
      }

      // /w/:ws/sessions/:sid
      const sessionMatch = path.match(/^\/w\/([^/]+)\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        return new Response(await handleSession(decodeURIComponent(sessionMatch[1]), decodeURIComponent(sessionMatch[2])), { headers: { "Content-Type": "text/html" } });
      }

      // /w/:ws/conclusions
      const conclusionsMatch = path.match(/^\/w\/([^/]+)\/conclusions$/);
      if (conclusionsMatch) {
        const page = parseInt(url.searchParams.get("page") ?? "1", 10);
        return new Response(await handleConclusions(decodeURIComponent(conclusionsMatch[1]), page), { headers: { "Content-Type": "text/html" } });
      }

      // /w/:ws/queue
      const queueMatch = path.match(/^\/w\/([^/]+)\/queue$/);
      if (queueMatch) {
        return new Response(await handleQueue(decodeURIComponent(queueMatch[1])), { headers: { "Content-Type": "text/html" } });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`<h1>Error</h1><pre>${esc(msg)}</pre>`, { status: 500, headers: { "Content-Type": "text/html" } });
    }
  },
});

console.log(`Dashboard running on http://localhost:${server.port}`);
