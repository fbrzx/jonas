const NAV_ITEMS = [
  { href: '/', label: 'Status' },
  { href: '/memory', label: 'Memory' },
  { href: '/skills', label: 'Skills' },
  { href: '/vault', label: 'Vault' },
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
    .htmx-indicator { opacity: 0; transition: opacity 0.2s; }
    .htmx-request .htmx-indicator { opacity: 1; }
  </style>
</head>
<body>
  <nav>${nav}</nav>
  <main>${content}</main>
  <footer>Jonas Dashboard</footer>
</body>
</html>`;
}
