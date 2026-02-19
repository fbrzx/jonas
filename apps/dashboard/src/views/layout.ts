const NAV_ITEMS = [
  { href: '/chat', label: 'Chat' },
  { href: '/memory', label: 'Memory' },
  { href: '/ext', label: 'Ext' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/audit', label: 'Audit' },
];

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

export function layout(title: string, content: string): string {
  const nav = NAV_ITEMS.map(
    (item) => `<a href="${item.href}">${item.label}</a>`
  ).join('');
  const mobileNav = NAV_ITEMS.map(
    (item) => `<a href="${item.href}" class="mobile-nav__link">${item.label}</a>`
  ).join('');
  
  const envClass = getEnvironmentClass(instanceInfo);
  const envLabel = instanceInfo ? `<span class="env-label ${envClass}">${instanceInfo}</span>` : '';
  const menuLabel = instanceInfo || 'Menu';
  const menuClass = `nav-menu-btn ${envClass}`;

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
      display: flex; flex-direction: column;
    }
    nav {
      background: #161b22; border-bottom: 1px solid #30363d;
      padding: 0.75rem 1.5rem; display: flex; gap: 1.5rem;
      align-items: center; justify-content: space-between;
      position: sticky; top: 0; z-index: 100;
      transition: box-shadow 0.2s ease, background-color 0.2s ease, backdrop-filter 0.2s ease;
    }
    nav.nav--scrolled {
      background: rgba(22, 27, 34, 0.82);
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.16);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    .nav-left { display: flex; align-items: center; gap: 1rem; min-width: 0; }
    .brand {
      display: inline-flex; align-items: center; gap: 0.5rem;
      color: #f0f6fc; text-decoration: none; font-size: 0.9rem; font-weight: 600;
    }
    .brand:hover { color: #f0f6fc; text-decoration: none; }
    .brand-icon {
      width: 24px; height: 24px; border-radius: 6px;
      border: 1px solid #30363d; background: #0d1117;
      image-rendering: pixelated;
    }
    .nav-links { display: flex; gap: 1.5rem; align-items: center; }
    .nav-right { display: flex; align-items: center; gap: 0.75rem; }
    .nav-menu-btn {
      display: none;
      border: 1px solid #30363d;
      border-radius: 6px;
      background: #0d1117;
      color: #c9d1d9;
      padding: 0.3rem 0.5rem;
      font-family: inherit;
      font-size: 0.75rem;
      cursor: pointer;
      align-items: center;
      gap: 0.4rem;
    }
    .nav-menu-btn:hover { background: #1f2937; }
    .nav-menu-btn__icon { font-size: 0.85rem; line-height: 1; opacity: 0.9; }
    .nav-menu-btn--open .nav-menu-btn__icon { transform: scale(0.95); }
    .mobile-nav {
      display: none;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 0.5rem 1rem 0.75rem;
      position: fixed;
      left: 0;
      right: 0;
      top: var(--mobile-nav-top, 56px);
      z-index: 99;
    }
    .mobile-nav[hidden] { display: none !important; }
    .mobile-nav--open { display: block; }
    .mobile-nav__link {
      display: block;
      padding: 0.5rem 0.6rem;
      border-radius: 6px;
      text-decoration: none;
      color: #58a6ff;
      font-size: 0.88rem;
    }
    .mobile-nav__link:hover { background: #1f293744; }
    .env-label {
      display: inline-block; padding: 0.25rem 0.75rem;
      border-radius: 4px; font-size: 0.7rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.05em;
      white-space: nowrap;
    }
    .env--local { background: #1f6feb33; color: #58a6ff; border: 1px solid #58a6ff66; }
    .env--staging { background: #9e6a0044; color: #d29922; border: 1px solid #d2992266; }
    .env--prod { background: #f8514944; color: #f85149; border: 1px solid #f8514966; }
    .env--other { background: #6e40a944; color: #bc8ef9; border: 1px solid #bc8ef966; }
    nav a {
      color: #58a6ff; text-decoration: none; font-size: 0.875rem;
      padding: 0.25rem 0.5rem; border-radius: 4px;
      transition: background 0.15s;
    }
    nav a:hover { background: #1f2937; }
    main { flex: 1; padding: 1.5rem; max-width: 1200px; width: 100%; margin: 0 auto; }
    footer {
      text-align: center; padding: 1rem;
      border-top: 1px solid #30363d; color: #484f58;
      font-size: 0.75rem;
    }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td {
      text-align: left; padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #21262d;
      vertical-align: middle;
    }
    .actions-col { white-space: nowrap; }
    .table-actions {
      display: flex; gap: 0.5rem; flex-wrap: wrap;
      align-items: center;
    }
    th { color: #8b949e; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    .card {
      background: #161b22; border: 1px solid #30363d;
      border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
    }
    .badge {
      display: inline-block; padding: 0.125rem 0.5rem;
      border-radius: 12px; font-size: 0.75rem; font-weight: 600;
      background: #1f6feb33; color: #58a6ff;
    }
    .badge--green { background: #23863533; color: #3fb950; }
    .badge--yellow { background: #9e6a0033; color: #d29922; }
    .badge--red { background: #f8514933; color: #f85149; }
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
    .btn {
      background: #238636; color: #fff; border: none;
      padding: 0.4rem 0.75rem; border-radius: 6px;
      font-family: inherit; font-size: 0.8rem; cursor: pointer;
      transition: background 0.15s;
    }
    .btn:hover { background: #2ea043; }
    .btn--primary { background: #1f6feb; }
    .btn--primary:hover { background: #388bfd; }
    .btn--sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
    .btn--danger { background: #da3633; }
    .btn--danger:hover { background: #f85149; }
    select, textarea {
      background: #0d1117; border: 1px solid #30363d;
      color: #c9d1d9; padding: 0.5rem 0.75rem; border-radius: 6px;
      font-family: inherit; font-size: 0.875rem;
    }
    select:focus, textarea:focus { outline: none; border-color: #58a6ff; }
    textarea { width: 100%; min-height: 80px; resize: vertical; }
    .badge--blue { background: #1f6feb33; color: #58a6ff; }
    a { color: #58a6ff; }
    a:visited { color: #58a6ff; }
    a.row-link { text-decoration: none; color: inherit; }
    a.row-link:hover td { background: #1f293744; }
    .htmx-indicator { opacity: 0; transition: opacity 0.2s; }
    .htmx-request .htmx-indicator { opacity: 1; }
    .chat-container { display: flex; flex-direction: column; height: calc(100vh - 120px); }
    .chat-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
    .chat-header h2 { margin: 0; }
    .chat-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.75rem; padding-bottom: 1rem; }
    .chat-msg { max-width: 80%; padding: 0.75rem 1rem; border-radius: 8px; }
    .chat-msg--user { align-self: flex-end; background: #1f6feb; color: #fff; }
    .chat-msg--assistant { align-self: flex-start; background: #161b22; border: 1px solid #30363d; }
    .chat-msg--error { background: #f8514911 !important; border-color: #f85149 !important; }
    .chat-msg__label { font-size: 0.7rem; font-weight: 600; margin-bottom: 0.25rem; opacity: 0.7; }
    .chat-msg__content { white-space: pre-wrap; margin: 0; font-family: inherit; font-size: 0.875rem; background: none; border: none; color: inherit; }
    .chat-input-bar { display: flex; gap: 0.5rem; padding-top: 0.75rem; border-top: 1px solid #30363d; align-items: flex-end; }
    .chat-input-bar textarea {
      flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
      padding: 0.5rem 0.75rem; border-radius: 6px; font-family: inherit; font-size: 0.875rem;
      resize: none; min-height: 56px; max-height: 240px; line-height: 1.5;
    }
    .chat-input-bar textarea:focus { outline: none; border-color: #58a6ff; }
    .chat-input-bar textarea:disabled { opacity: 0.5; }
    .chat-input-bar button {
      background: #238636; color: #fff; border: none; padding: 0.5rem 1rem;
      border-radius: 6px; font-family: inherit; font-size: 0.875rem; cursor: pointer;
      white-space: nowrap;
    }
    .chat-input-bar button:hover { background: #2ea043; }
    /* Typing indicator */
    .typing-dots span {
      animation: blink 1.4s infinite both;
      font-size: 1.2rem; font-weight: bold;
    }
    .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
    /* Markdown in assistant messages */
    .chat-md { white-space: normal; }
    .chat-md p { margin: 0.4em 0; }
    .chat-md p:first-child { margin-top: 0; }
    .chat-md p:last-child { margin-bottom: 0; }
    .chat-md pre {
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      padding: 0.75rem; overflow-x: auto; margin: 0.5em 0;
    }
    .chat-md code {
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85em;
    }
    .chat-md :not(pre) > code {
      background: #0d111788; padding: 0.15em 0.35em; border-radius: 3px;
    }
    .chat-md ul, .chat-md ol { padding-left: 1.5em; margin: 0.4em 0; }
    .chat-md li { margin: 0.2em 0; }
    .chat-md h1, .chat-md h2, .chat-md h3 { margin: 0.6em 0 0.3em; color: #f0f6fc; }
    .chat-md h1 { font-size: 1.1em; } .chat-md h2 { font-size: 1em; } .chat-md h3 { font-size: 0.95em; }
    .chat-md blockquote {
      border-left: 3px solid #30363d; padding-left: 0.75rem;
      color: #8b949e; margin: 0.4em 0;
    }
    .chat-md a { color: #58a6ff; }
    .chat-md table { border-collapse: collapse; margin: 0.4em 0; }
    .chat-md th, .chat-md td { border: 1px solid #30363d; padding: 0.3rem 0.5rem; }
    .chat-md details { margin: 0.5em 0; padding: 0.5rem; background: #0d111744; border: 1px solid #30363d; border-radius: 4px; }
    .chat-md details summary { cursor: pointer; font-weight: 600; margin-bottom: 0.5rem; }
    .chat-md details[open] summary { margin-bottom: 0.75rem; }
    .info-box {
      background: #0d1117; border: 1px solid #1f6feb44; border-radius: 6px;
      padding: 0.75rem 1rem; margin-bottom: 1rem; font-size: 0.85rem;
    }
    .info-box code { background: #1f293744; padding: 0.1em 0.3em; border-radius: 3px; }
    .table-scroll {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .table-scroll table { min-width: 680px; }
    .table-scroll th { white-space: nowrap; }
    .table-scroll td { overflow-wrap: break-word; }
    .modal-overlay {
      position: fixed; inset: 0; z-index: 2000;
      background: rgba(0, 0, 0, 0.55);
      display: flex; align-items: center; justify-content: center;
      padding: 1rem;
    }
    .modal-overlay[hidden] { display: none; }
    .modal-card {
      width: min(520px, 100%);
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 1rem;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.4);
    }
    .modal-title { margin-bottom: 0.4rem; color: #f0f6fc; font-size: 1rem; }
    .modal-body { margin-bottom: 0.9rem; color: #c9d1d9; white-space: pre-wrap; }
    .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    code { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    @media (max-width: 900px) {
      nav {
        padding: 0.65rem 0.9rem;
        gap: 0.75rem;
      }
      .nav-links { display: none; }
      .env-label { display: none; }
      .nav-menu-btn { display: inline-flex; }
      table { font-size: 0.84rem; }
      th { white-space: nowrap; }
      td { white-space: normal; overflow-wrap: break-word; word-break: normal; }
      .table-scroll { border-radius: 8px; }
      .table-scroll table {
        min-width: 700px;
        box-shadow: inset 10px 0 8px -12px rgba(255, 255, 255, 0.25), inset -10px 0 8px -12px rgba(255, 255, 255, 0.25);
      }
      .table-scroll th { white-space: nowrap; }
      .table-scroll td { white-space: normal; overflow-wrap: break-word; }
      main { padding: 1rem; }
    }
  </style>
</head>
<body>
  <nav id="top-nav">
    <div class="nav-left">
      <a class="brand" href="/">
        <img class="brand-icon" src="${jonasIconUrl}" alt="Jonas icon">
        <span>Jonas</span>
      </a>
      <div class="nav-links">${nav}</div>
    </div>
    <div class="nav-right">
      ${envLabel}
      <button id="nav-menu-btn" class="${menuClass}" type="button" aria-expanded="false" aria-controls="mobile-nav" aria-label="Open Jonas menu">
        <span class="nav-menu-btn__label">${menuLabel}</span>
        <span id="nav-menu-icon" class="nav-menu-btn__icon">☰</span>
      </button>
    </div>
  </nav>
  <div id="mobile-nav" class="mobile-nav" hidden>
    ${mobileNav}
  </div>
  <main>${content}</main>
  <footer>Jonas Dashboard</footer>
  <div id="jonas-modal" class="modal-overlay" hidden>
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="jonas-modal-title">
      <h3 id="jonas-modal-title" class="modal-title">Notice</h3>
      <div id="jonas-modal-body" class="modal-body"></div>
      <div id="jonas-modal-actions" class="modal-actions"></div>
    </div>
  </div>
  <script>
    (() => {
      const nav = document.getElementById('top-nav');
      if (!nav) return;
      const sync = () => nav.classList.toggle('nav--scrolled', window.scrollY > 4);
      sync();
      window.addEventListener('scroll', sync, { passive: true });

      const menuBtn = document.getElementById('nav-menu-btn');
      const menuIcon = document.getElementById('nav-menu-icon');
      const mobileNav = document.getElementById('mobile-nav');
      if (!menuBtn || !mobileNav || !menuIcon) return;

      const syncMobileNavTop = () => {
        document.documentElement.style.setProperty('--mobile-nav-top', String(nav.getBoundingClientRect().height) + 'px');
      };
      syncMobileNavTop();

      const setOpen = (open) => {
        menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        menuBtn.classList.toggle('nav-menu-btn--open', open);
        menuIcon.textContent = open ? '✕' : '☰';
        mobileNav.classList.toggle('mobile-nav--open', open);
        if (open) mobileNav.removeAttribute('hidden');
        else mobileNav.setAttribute('hidden', '');
      };

      menuBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = menuBtn.getAttribute('aria-expanded') === 'true';
        setOpen(!isOpen);
      });

      document.addEventListener('click', (event) => {
        if (!(event.target instanceof Node)) return;
        if (mobileNav.contains(event.target) || menuBtn.contains(event.target)) return;
        setOpen(false);
      });

      window.addEventListener('resize', () => {
        syncMobileNavTop();
        if (window.innerWidth > 900) setOpen(false);
      });
    })();

    (() => {
      const modal = document.getElementById('jonas-modal');
      const titleEl = document.getElementById('jonas-modal-title');
      const bodyEl = document.getElementById('jonas-modal-body');
      const actionsEl = document.getElementById('jonas-modal-actions');
      if (!modal || !titleEl || !bodyEl || !actionsEl) return;

      const closeModal = () => {
        modal.setAttribute('hidden', '');
        actionsEl.innerHTML = '';
      };

      const createButton = (label, className, onClick) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = className;
        btn.textContent = label;
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
        window.jonasConfirm(evt.detail.question).then((ok) => {
          if (ok) evt.detail.issueRequest(true);
        });
      });
    })();

    (() => {
      const shouldAutoRefresh = Array.from(document.querySelectorAll('.badge--red'))
        .some((el) => /agent unreachable/i.test((el.textContent || '').trim()));
      if (!shouldAutoRefresh) return;
      window.setInterval(() => {
        window.location.reload();
      }, 30000);
    })();
  </script>
</body>
</html>`;
}
