const NAV_PINNED = [
  { href: '/chat', label: 'Chat', icon: 'chat' },
];

const NAV_ITEMS = [
  { href: '/memory', label: 'Memory', icon: 'memory' },
  { href: '/skills', label: 'Skills', icon: 'skills' },
  { href: '/channels', label: 'Channels', icon: 'channels' },
  { href: '/agents', label: 'Agents', icon: 'agents' },
  { href: '/tasks', label: 'Tasks', icon: 'tasks' },
  { href: '/audit', label: 'Audit', icon: 'audit' },
];

const ICONS: Record<string, string> = {
  chat: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H2v9h4v3l4-3h4V2z"/></svg>`,
  memory: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="6" rx="5" ry="3"/><path d="M3 6v4c0 1.66 2.24 3 5 3s5-1.34 5-3V6"/><path d="M3 10v4c0 1.66 2.24 3 5 3s5-1.34 5-3v-4"/></svg>`,
  skills: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="8,2 10,6 14,6 11,9 12,13 8,11 4,13 5,9 2,6 6,6"/></svg>`,
  channels: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M6 7.5L10 5M6 8.5L10 11"/></svg>`,
  agents: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M6 5V4a2 2 0 014 0v1"/><circle cx="6.5" cy="9.5" r="1" fill="currentColor" stroke="none"/><circle cx="9.5" cy="9.5" r="1" fill="currentColor" stroke="none"/><path d="M6.5 11.5h3"/></svg>`,
  tasks: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 8l2.5 2.5L11 6"/></svg>`,
  audit: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1l2 4h4l-3.3 2.4 1.3 4L8 9l-3.5 2.4 1.3-4L2.5 5h4z"/></svg>`,
};

const instanceInfo = process.env.DOMAIN || '';
const defaultIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#22d3ee"/>
  <circle cx="32" cy="28" r="14" fill="#fed7aa"/>
  <rect x="22" y="24" width="6" height="6" fill="#111827"/>
  <rect x="36" y="24" width="6" height="6" fill="#111827"/>
  <rect x="26" y="34" width="12" height="3" fill="#111827"/>
  <rect x="14" y="46" width="36" height="12" rx="4" fill="#f97316"/>
</svg>`;
const defaultIconDataUri = `data:image/svg+xml,${encodeURIComponent(defaultIconSvg)}`;
const jonasIconUrl = process.env.DASHBOARD_ICON_URL || '/assets/avatar.png';

function getEnvironmentClass(domain: string): string {
  if (!domain) return 'env--local';
  if (domain.includes('localhost') || domain.includes('127.0.0.1')) return 'env--local';
  if (domain.includes('staging') || domain.includes('stage')) return 'env--staging';
  if (domain.includes('prod') || domain.includes('production')) return 'env--prod';
  return 'env--other';
}

function navLink(item: { href: string; label: string; icon: string }, extraClass = ''): string {
  return `<a href="${item.href}" class="sidebar-link${extraClass ? ' ' + extraClass : ''}" data-nav-link="${item.href}">${ICONS[item.icon] ?? ''}<span>${item.label}</span></a>`;
}

export function layout(title: string, content: string): string {
  const pinnedLinks = NAV_PINNED.map((i) => navLink(i, 'sidebar-link--pinned')).join('');
  const mainLinks = NAV_ITEMS.map((i) => navLink(i)).join('');

  const envClass = getEnvironmentClass(instanceInfo);
  const envBadge = instanceInfo
    ? `<span class="env-label ${envClass}">${instanceInfo}</span>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#161b22">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Jonas">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="${jonasIconUrl}">
  <link rel="apple-touch-icon" href="${jonasIconUrl}">
  <title>${title} - Jonas on ${instanceInfo}</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      background: #0d1117; color: #c9d1d9;
      line-height: 1.6; min-height: 100vh;
      display: flex; flex-direction: row;
    }
    /* ── Sidebar ── */
    .sidebar {
      position: fixed; top: 0; left: 0; bottom: 0; width: 220px;
      background: #161b22; border-right: 1px solid #30363d;
      display: flex; flex-direction: column; z-index: 100;
      overflow-y: auto; overflow-x: hidden;
    }
    .sidebar-brand {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 1rem 1rem 0.875rem;
      border-bottom: 1px solid #21262d;
      color: #f0f6fc; text-decoration: none; font-weight: 600; font-size: 0.9rem;
      flex-shrink: 0;
    }
    .sidebar-brand:hover { color: #f0f6fc; }
    .sidebar-brand-icon {
      width: 28px; height: 28px; border-radius: 7px;
      border: 1px solid #30363d; flex-shrink: 0;
    }
    .sidebar-pinned { padding: 0.625rem 0.625rem 0.5rem; border-bottom: 1px solid #21262d; }
    .sidebar-nav { flex: 1; padding: 0.625rem 0.625rem 0.5rem; display: flex; flex-direction: column; gap: 0.1rem; }
    .sidebar-section { font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #484f58; padding: 0.5rem 0.625rem 0.3rem; }
    .sidebar-link {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.45rem 0.625rem; border-radius: 6px;
      color: #8b949e; text-decoration: none; font-size: 0.85rem;
      transition: background 0.12s, color 0.12s; white-space: nowrap;
    }
    .sidebar-link:hover { background: #1f293766; color: #c9d1d9; }
    .sidebar-link:visited { color: #8b949e; }
    .sidebar-link:hover { color: #c9d1d9; }
    .sidebar-link--pinned { color: #58a6ff; font-weight: 500; }
    .sidebar-link--pinned:visited { color: #58a6ff; }
    .sidebar-link--pinned:hover { color: #79b8ff; }
    .sidebar-link.active { background: #1f6feb1a; color: #58a6ff; }
    .sidebar-link.active:visited { color: #58a6ff; }
    .sidebar-link svg { flex-shrink: 0; }
    .sidebar-footer { padding: 0.75rem 1rem; border-top: 1px solid #21262d; flex-shrink: 0; }
    /* ── Env label ── */
    .env-label {
      display: inline-block; padding: 0.2rem 0.55rem;
      border-radius: 4px; font-size: 0.65rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap;
    }
    .env--local { background: #1f6feb1a; color: #58a6ff; border: 1px solid #58a6ff44; }
    .env--staging { background: #9e6a0022; color: #d29922; border: 1px solid #d2992244; }
    .env--prod { background: #f8514922; color: #f85149; border: 1px solid #f8514944; }
    .env--other { background: #6e40a922; color: #bc8ef9; border: 1px solid #bc8ef944; }
    /* ── App body ── */
    .app-body { margin-left: 220px; flex: 1; display: flex; flex-direction: column; min-height: 100vh; }
    main { flex: 1; padding: 1.5rem; max-width: 1200px; width: 100%; margin: 0 auto; }
    footer { text-align: center; padding: 1rem; border-top: 1px solid #30363d; color: #484f58; font-size: 0.75rem; }
    /* ── Mobile topbar ── */
    .topbar {
      display: none; position: sticky; top: 0; z-index: 150;
      background: #161b22; border-bottom: 1px solid #30363d;
      padding: 0.6rem 1rem; align-items: center; justify-content: space-between;
    }
    .topbar-brand { display: flex; align-items: center; gap: 0.5rem; color: #f0f6fc; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
    .topbar-brand:visited { color: #f0f6fc; }
    .topbar-brand-icon { width: 24px; height: 24px; border-radius: 6px; border: 1px solid #30363d; }
    .topbar-right { display: flex; align-items: center; gap: 0.5rem; }
    .sidebar-toggle {
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      color: #c9d1d9; padding: 0.3rem 0.6rem; font-size: 1rem; cursor: pointer; line-height: 1;
      font-family: inherit;
    }
    .sidebar-toggle:hover { background: #1f2937; }
    .sidebar-backdrop {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.55); z-index: 99;
    }
    .sidebar-backdrop--open { display: block; }
    /* ── Global styles ── */
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #21262d; vertical-align: middle; }
    .actions-col { white-space: nowrap; }
    .table-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    th { color: #8b949e; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; background: #1f6feb33; color: #58a6ff; }
    .badge--green { background: #23863533; color: #3fb950; }
    .badge--yellow { background: #9e6a0033; color: #d29922; }
    .badge--red { background: #f8514933; color: #f85149; }
    .badge--blue { background: #1f6feb33; color: #58a6ff; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; color: #f0f6fc; }
    h2 { font-size: 1rem; margin-bottom: 0.75rem; color: #f0f6fc; }
    input[type="text"], input[type="search"], input[type="radio"] {
      background: #0d1117; border: 1px solid #30363d;
      color: #c9d1d9; padding: 0.5rem 0.75rem; border-radius: 6px;
      font-family: inherit; font-size: 0.875rem;
    }
    input[type="text"], input[type="search"] { width: 100%; max-width: 400px; }
    input[type="radio"] { width: auto; padding: 0; margin-right: 0.5rem; accent-color: #58a6ff; }
    input:focus { outline: none; border-color: #58a6ff; }
    .form-group { margin-bottom: 1.5rem; }
    .form-group label { display: block; margin-bottom: 0.5rem; font-weight: 500; }
    .form-group small { display: block; margin-top: 0.25rem; color: #8b949e; font-size: 0.8rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
    .meta { color: #8b949e; font-size: 0.75rem; }
    .score { color: #d29922; }
    .btn { background: #238636; color: #fff; border: none; padding: 0.4rem 0.75rem; border-radius: 6px; font-family: inherit; font-size: 0.8rem; cursor: pointer; transition: background 0.15s; }
    .btn:hover { background: #2ea043; }
    .btn--primary { background: #1f6feb; }
    .btn--primary:hover { background: #388bfd; }
    .btn--sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
    .btn--danger { background: #da3633; }
    .btn--danger:hover { background: #f85149; }
    select, textarea { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 0.5rem 0.75rem; border-radius: 6px; font-family: inherit; font-size: 0.875rem; }
    select:focus, textarea:focus { outline: none; border-color: #58a6ff; }
    textarea { width: 100%; min-height: 80px; resize: vertical; }
    a { color: #58a6ff; }
    a:visited { color: #58a6ff; }
    a.row-link { text-decoration: none; color: inherit; }
    a.row-link:hover td { background: #1f293744; }
    .htmx-indicator { opacity: 0; transition: opacity 0.2s; }
    .htmx-request .htmx-indicator { opacity: 1; }
    .info-box { background: #0d1117; border: 1px solid #1f6feb44; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; font-size: 0.85rem; }
    .info-box code { background: #1f293744; padding: 0.1em 0.3em; border-radius: 3px; }
    code { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .table-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .table-scroll table { min-width: 680px; }
    .table-scroll th { white-space: nowrap; }
    .table-scroll td { overflow-wrap: break-word; }
    /* ── Chat ── */
    .chat-container { display: flex; flex-direction: column; height: calc(100dvh - 92px); min-height: 0; }
    .chat-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
    .chat-header h2 { margin: 0; }
    .chat-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.75rem; padding-bottom: 1rem; }
    .chat-msg { max-width: 80%; padding: 0.75rem 1rem; border-radius: 8px; }
    .chat-msg--user { align-self: flex-end; background: #1f6feb; color: #fff; }
    .chat-msg--assistant { align-self: flex-start; background: #161b22; border: 1px solid #30363d; }
    .chat-msg--error { background: #f8514911 !important; border-color: #f85149 !important; }
    .chat-msg__label { font-size: 0.7rem; font-weight: 600; margin-bottom: 0.25rem; opacity: 0.7; }
    .chat-msg__content { white-space: pre-wrap; margin: 0; font-family: inherit; font-size: 0.875rem; background: none; border: none; color: inherit; }
    .chat-input-bar { display: flex; gap: 0.5rem; padding-top: 0.75rem; border-top: 1px solid #30363d; align-items: stretch; }
    .chat-input-bar textarea { flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 0.5rem 0.75rem; border-radius: 6px; font-family: inherit; font-size: 0.875rem; resize: none; min-height: 56px; max-height: 240px; line-height: 1.5; }
    .chat-input-bar textarea:focus { outline: none; border-color: #58a6ff; }
    .chat-input-bar textarea:disabled { opacity: 0.5; }
    .chat-input-bar button { background: #238636; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 6px; font-family: inherit; font-size: 0.875rem; cursor: pointer; white-space: nowrap; display: flex; align-items: center; }
    .chat-input-bar button:hover { background: #2ea043; }
    .chat-input-bar button.btn--danger { background: #da3633; }
    .chat-input-bar button.btn--danger:hover { background: #f85149; }
    .chat-input-bar button:disabled { opacity: 0.4; cursor: not-allowed; }
    .chat-status-banner { padding: 0.4rem 0.75rem; background: #f8514911; border: 1px solid #f8514966; border-radius: 6px; color: #f85149; font-size: 0.78rem; margin-bottom: 0.5rem; }
    .typing-dots span { animation: blink 1.4s infinite both; font-size: 1.2rem; font-weight: bold; }
    .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
    .chat-md { white-space: normal; }
    .chat-md p { margin: 0.4em 0; }
    .chat-md p:first-child { margin-top: 0; }
    .chat-md p:last-child { margin-bottom: 0; }
    .chat-md pre { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 0.75rem; overflow-x: auto; margin: 0.5em 0; }
    .chat-md code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85em; }
    .chat-md :not(pre) > code { background: #0d111788; padding: 0.15em 0.35em; border-radius: 3px; }
    .chat-md ul, .chat-md ol { padding-left: 1.5em; margin: 0.4em 0; }
    .chat-md li { margin: 0.2em 0; }
    .chat-md h1, .chat-md h2, .chat-md h3 { margin: 0.6em 0 0.3em; color: #f0f6fc; }
    .chat-md h1 { font-size: 1.1em; } .chat-md h2 { font-size: 1em; } .chat-md h3 { font-size: 0.95em; }
    .chat-md blockquote { border-left: 3px solid #30363d; padding-left: 0.75rem; color: #8b949e; margin: 0.4em 0; }
    .chat-md a { color: #58a6ff; }
    .chat-md table { border-collapse: collapse; margin: 0.4em 0; }
    .chat-md th, .chat-md td { border: 1px solid #30363d; padding: 0.3rem 0.5rem; }
    .chat-md details { margin: 0.5em 0; padding: 0.5rem; background: #0d111744; border: 1px solid #30363d; border-radius: 4px; }
    .chat-md details summary { cursor: pointer; font-weight: 600; margin-bottom: 0.5rem; }
    .chat-md details[open] summary { margin-bottom: 0.75rem; }
    /* ── Modal ── */
    .modal-overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .modal-overlay[hidden] { display: none; }
    .modal-card { width: min(520px, 100%); background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 1rem; box-shadow: 0 12px 28px rgba(0,0,0,0.4); }
    .modal-title { margin-bottom: 0.4rem; color: #f0f6fc; font-size: 1rem; }
    .modal-body { margin-bottom: 0.9rem; color: #c9d1d9; white-space: pre-wrap; }
    .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    /* ── Responsive ── */
    @media (max-width: 900px) {
      body { flex-direction: column; }
      .sidebar {
        width: 260px; transform: translateX(-100%);
        transition: transform 0.24s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 200; border-right-color: #30363d;
      }
      .sidebar--open { transform: translateX(0); box-shadow: 4px 0 24px rgba(0,0,0,0.4); }
      .topbar { display: flex; }
      .app-body { margin-left: 0; min-height: 0; flex: 1; }
      main { padding: 1rem; }
      table { font-size: 0.84rem; }
      th { white-space: nowrap; }
      .table-scroll { border-radius: 8px; }
      .table-scroll table { min-width: 700px; box-shadow: inset 10px 0 8px -12px rgba(255,255,255,0.25), inset -10px 0 8px -12px rgba(255,255,255,0.25); }
      .chat-container { height: calc(100dvh - 140px); }
      .chat-input-bar textarea { font-size: 16px; }
    }
  </style>
</head>
<body>
  <aside id="sidebar" class="sidebar">
    <a class="sidebar-brand" href="/">
      <img class="sidebar-brand-icon" src="${jonasIconUrl}" alt="Jonas icon">
      <span>Jonas</span>
    </a>
    <div class="sidebar-pinned">${pinnedLinks}</div>
    <nav class="sidebar-nav">
      <span class="sidebar-section">Navigation</span>
      ${mainLinks}
    </nav>
    <div class="sidebar-footer">${envBadge}</div>
  </aside>
  <div id="sidebar-backdrop" class="sidebar-backdrop"></div>
  <div class="app-body">
    <header class="topbar">
      <a class="topbar-brand" href="/">
        <img class="topbar-brand-icon" src="${jonasIconUrl}" alt="Jonas icon">
        <span>Jonas</span>
      </a>
      <div class="topbar-right">
        ${envBadge}
        <button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-expanded="false" aria-controls="sidebar" aria-label="Toggle navigation">☰</button>
      </div>
    </header>
    <main>${content}</main>
    <footer>Jonas Dashboard</footer>
  </div>
  <div id="jonas-modal" class="modal-overlay" hidden>
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="jonas-modal-title">
      <h3 id="jonas-modal-title" class="modal-title">Notice</h3>
      <div id="jonas-modal-body" class="modal-body"></div>
      <div id="jonas-modal-actions" class="modal-actions"></div>
    </div>
  </div>
  <script>
    (() => {
      // Active nav link
      const path = window.location.pathname;
      document.querySelectorAll('[data-nav-link]').forEach((el) => {
        const href = el.getAttribute('data-nav-link');
        if (href && (path === href || (href !== '/' && path.startsWith(href)))) {
          el.classList.add('active');
        }
      });

      // Sidebar toggle (mobile)
      const sidebar = document.getElementById('sidebar');
      const backdrop = document.getElementById('sidebar-backdrop');
      const toggle = document.getElementById('sidebar-toggle');
      if (!sidebar || !backdrop || !toggle) return;

      const setOpen = (open) => {
        sidebar.classList.toggle('sidebar--open', open);
        backdrop.classList.toggle('sidebar-backdrop--open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? '✕' : '☰';
      };

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(sidebar.getAttribute('aria-expanded') !== 'true' && !sidebar.classList.contains('sidebar--open'));
      });

      backdrop.addEventListener('click', () => setOpen(false));

      window.addEventListener('resize', () => {
        if (window.innerWidth > 900) setOpen(false);
      });
    })();

    (() => {
      const modal = document.getElementById('jonas-modal');
      const titleEl = document.getElementById('jonas-modal-title');
      const bodyEl = document.getElementById('jonas-modal-body');
      const actionsEl = document.getElementById('jonas-modal-actions');
      if (!modal || !titleEl || !bodyEl || !actionsEl) return;

      const closeModal = () => { modal.setAttribute('hidden', ''); actionsEl.innerHTML = ''; };

      const createButton = (label, className, onClick) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = className; btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
      };

      window.jonasAck = (message, title = 'Notice') => {
        titleEl.textContent = title;
        bodyEl.textContent = String(message ?? '');
        actionsEl.innerHTML = '';
        actionsEl.appendChild(createButton('OK', 'btn btn--sm', closeModal));
        modal.removeAttribute('hidden');
      };

      window.jonasConfirm = (message, title = 'Please confirm') => new Promise((resolve) => {
        titleEl.textContent = title;
        bodyEl.textContent = String(message ?? '');
        actionsEl.innerHTML = '';
        actionsEl.appendChild(createButton('Cancel', 'btn btn--sm', () => { closeModal(); resolve(false); }));
        actionsEl.appendChild(createButton('Confirm', 'btn btn--sm btn--danger', () => { closeModal(); resolve(true); }));
        modal.removeAttribute('hidden');
      });

      window.alert = (message) => window.jonasAck(message);

      document.body.addEventListener('htmx:confirm', (evt) => {
        if (!evt.detail.question) return;
        evt.preventDefault();
        window.jonasConfirm(evt.detail.question).then((ok) => { if (ok) evt.detail.issueRequest(true); });
      });
    })();

    (() => {
      const shouldAutoRefresh = Array.from(document.querySelectorAll('.badge--red'))
        .some((el) => /agent unreachable/i.test((el.textContent || '').trim()));
      if (!shouldAutoRefresh) return;
      window.setInterval(() => window.location.reload(), 30000);
    })();
  </script>
</body>
</html>`;
}
