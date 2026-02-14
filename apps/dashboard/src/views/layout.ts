const NAV_ITEMS = [
  { href: '/chat', label: 'Chat' },
  { href: '/', label: 'Status' },
  { href: '/memory', label: 'Memory' },
  { href: '/skills', label: 'Skills' },
  { href: '/connections', label: 'Connections' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/audit', label: 'Audit' },
];

export function layout(title: string, content: string): string {
  const nav = NAV_ITEMS.map(
    (item) => `<a href="${item.href}">${item.label}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Jonas Dashboard</title>
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
      align-items: center;
    }
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
    input[type="text"], input[type="search"] {
      background: #0d1117; border: 1px solid #30363d;
      color: #c9d1d9; padding: 0.5rem 0.75rem; border-radius: 6px;
      font-family: inherit; font-size: 0.875rem; width: 100%; max-width: 400px;
    }
    input:focus { outline: none; border-color: #58a6ff; }
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
    .chat-msg__label { font-size: 0.7rem; font-weight: 600; margin-bottom: 0.25rem; opacity: 0.7; }
    .chat-msg__content { white-space: pre-wrap; margin: 0; font-family: inherit; font-size: 0.875rem; background: none; border: none; color: inherit; }
    .chat-input-bar { display: flex; gap: 0.5rem; padding-top: 0.75rem; border-top: 1px solid #30363d; align-items: flex-end; }
    .chat-input-bar textarea {
      flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
      padding: 0.5rem 0.75rem; border-radius: 6px; font-family: inherit; font-size: 0.875rem;
      resize: none; min-height: 38px; max-height: 200px; line-height: 1.5;
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
    .info-box {
      background: #0d1117; border: 1px solid #1f6feb44; border-radius: 6px;
      padding: 0.75rem 1rem; margin-bottom: 1rem; font-size: 0.85rem;
    }
    .info-box code { background: #1f293744; padding: 0.1em 0.3em; border-radius: 3px; }
  </style>
</head>
<body>
  <nav>${nav}</nav>
  <main>${content}</main>
  <footer>Jonas Dashboard</footer>
</body>
</html>`;
}
