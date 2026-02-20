import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';

function describeConversationSource(channelType?: string, channelId?: string): string {
  if (!channelType || channelType === 'dashboard') return 'Dashboard UI';
  if (channelType === 'gateway') return `Gateway bridge${channelId ? ` (${channelId})` : ''}`;
  return `Channel: ${channelType}${channelId ? ` (${channelId})` : ''}`;
}

function safeExcerpt(text: string, max = 140): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

app.get('/chat', (c) => {
  const content = `
    <div class="chat-container">
      <div class="chat-header">
        <h2>Chat</h2>
        <div style="display:flex;gap:0.5rem">
          <a href="/chat/history" class="btn btn--sm" style="text-decoration:none">History</a>
          <button id="btn-new-chat" class="btn btn--sm" title="New conversation">New Chat</button>
        </div>
      </div>
      <div id="chat-messages" class="chat-messages"></div>
      <div class="chat-input-bar">
        <textarea id="chat-input" placeholder="Send a message... (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
        <button id="btn-send" class="btn">Send</button>
        <button id="btn-abort" class="btn btn--danger" style="display:none">Stop</button>
      </div>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
    <script>
    (function() {
      var MSGS_KEY = 'jonas-chat-messages';
      var SK_KEY = 'jonas-chat-session';

      var messagesEl = document.getElementById('chat-messages');
      var inputEl = document.getElementById('chat-input');
      var sendBtn = document.getElementById('btn-send');
      var abortBtn = document.getElementById('btn-abort');
      var newChatBtn = document.getElementById('btn-new-chat');

      var sessionKey = localStorage.getItem(SK_KEY);
      if (!sessionKey) {
        sessionKey = crypto.randomUUID();
        localStorage.setItem(SK_KEY, sessionKey);
      }

      var abortController = null;
      var messages = []; // [{role, content}]

      // --- Restore saved messages ---
      try {
        var saved = localStorage.getItem(MSGS_KEY);
        if (saved) messages = JSON.parse(saved);
      } catch(e) { messages = []; }
      renderAllMessages();

      // --- Markdown config ---
      if (typeof marked !== 'undefined') {
        marked.setOptions({ breaks: true, gfm: true });
      }

      function escapeHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      function renderMd(text) {
        if (typeof marked !== 'undefined') {
          try { return marked.parse(text); } catch(e) { /* fall through */ }
        }
        return '<pre>' + escapeHtml(text) + '</pre>';
      }

      function normalizeErrorMessage(message) {
        var text = String(message || 'Unknown error').trim();
        return text.replace(/^Error:\s*/i, '');
      }

      function isAssistantErrorMessage(message) {
        return message
          && message.role === 'assistant'
          && (message.error === true || (typeof message.content === 'string' && /^Error:\s*/i.test(message.content)));
      }

      function renderAllMessages() {
        messagesEl.innerHTML = messages.map(function(m) {
          var isError = isAssistantErrorMessage(m);
          var cls = m.role === 'user'
            ? 'chat-msg chat-msg--user'
            : ('chat-msg chat-msg--assistant' + (isError ? ' chat-msg--error' : ''));
          var label = m.role === 'user' ? 'You' : 'Jonas';
          var assistantContent = isError ? normalizeErrorMessage(m.content) : m.content;
          var body = m.role === 'user'
            ? '<pre class="chat-msg__content">' + escapeHtml(m.content) + '</pre>'
            : '<div class="chat-msg__content chat-md">' + renderMd(assistantContent) + '</div>';
          return '<div class="' + cls + '"><div class="chat-msg__label">' + label + '</div>' + body + '</div>';
        }).join('');
        scrollToBottom();
      }

      function saveMessages() {
        localStorage.setItem(MSGS_KEY, JSON.stringify(messages));
      }

      function scrollToBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function setLoading(loading) {
        if (loading) {
          sendBtn.style.display = 'none';
          abortBtn.style.display = '';
          inputEl.disabled = true;
        } else {
          sendBtn.style.display = '';
          abortBtn.style.display = 'none';
          inputEl.disabled = false;
          inputEl.focus();
        }
      }

      function addThinkingIndicator() {
        var div = document.createElement('div');
        div.className = 'chat-msg chat-msg--assistant chat-msg--thinking';
        div.innerHTML = '<div class="chat-msg__label">Jonas</div><div class="chat-msg__content"><span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></div>';
        div.id = 'thinking-indicator';
        messagesEl.appendChild(div);
        scrollToBottom();
      }

      function removeThinkingIndicator() {
        var el = document.getElementById('thinking-indicator');
        if (el) el.remove();
      }

      async function sendMessage() {
        var text = inputEl.value.trim();
        if (!text) return;

        messages.push({ role: 'user', content: text });
        renderAllMessages();
        saveMessages();
        inputEl.value = '';
        autoResize();

        setLoading(true);
        addThinkingIndicator();

        abortController = new AbortController();

        try {
          var res = await fetch('/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              sessionKey: sessionKey,
              channelType: 'dashboard',
              channelId: 'dashboard',
            }),
            signal: abortController.signal,
          });

          if (!res.ok) {
            throw new Error('Agent returned ' + res.status);
          }

          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';
          var responseContent = '';
          var responseIsError = false;

          while (true) {
            var result = await reader.read();
            if (result.done) break;
            buffer += decoder.decode(result.value, { stream: true });

            var lines = buffer.split('\\n');
            buffer = lines.pop() || '';

            var eventType = '';
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              if (line.startsWith('event: ')) {
                eventType = line.slice(7);
              } else if (line.startsWith('data: ') && eventType) {
                try {
                  var data = JSON.parse(line.slice(6));
                  if (eventType === 'message') {
                    responseContent = data.content || '';
                    responseIsError = false;
                  } else if (eventType === 'error') {
                    responseContent = normalizeErrorMessage(data.error || 'Unknown error');
                    responseIsError = true;
                  }
                } catch(e) {}
                eventType = '';
              }
            }
          }

          removeThinkingIndicator();
          if (responseContent) {
            messages.push({ role: 'assistant', content: responseContent, error: responseIsError });
            renderAllMessages();
            saveMessages();
          }
        } catch(err) {
          removeThinkingIndicator();
          if (!err || err.name !== 'AbortError') {
            messages.push({
              role: 'assistant',
              content: normalizeErrorMessage((err && err.message) || 'could not reach agent'),
              error: true,
            });
            renderAllMessages();
            saveMessages();
          }
        } finally {
          abortController = null;
          setLoading(false);
        }
      }

      async function abortChat() {
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        try {
          await fetch('/chat/abort', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionKey: sessionKey }),
          });
        } catch(e) {}
        removeThinkingIndicator();
        setLoading(false);
      }

      async function newChat() {
        if (abortController) await abortChat();
        try {
          await fetch('/chat/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionKey: sessionKey }),
          });
        } catch(e) {}
        sessionKey = crypto.randomUUID();
        localStorage.setItem(SK_KEY, sessionKey);
        messages = [];
        saveMessages();
        renderAllMessages();
        inputEl.focus();
      }

      // --- Auto-resize textarea ---
      function autoResize() {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
      }

      inputEl.addEventListener('input', autoResize);

      // --- Enter to send, Shift+Enter for newline ---
      inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      sendBtn.addEventListener('click', function(e) {
        e.preventDefault();
        sendMessage();
      });

      abortBtn.addEventListener('click', function(e) {
        e.preventDefault();
        abortChat();
      });

      newChatBtn.addEventListener('click', function(e) {
        e.preventDefault();
        newChat();
      });

      inputEl.focus();
    })();
    </script>`;
  return c.html(layout('Chat', content));
});

// SSE proxy — streams agent response to browser
app.post('/chat/stream', async (c) => {
  const body = await c.req.json<{
    message: string;
    sessionKey?: string;
    channelType?: string;
    channelId?: string;
  }>();

  try {
    const agentRes = await fetch(`${AGENT_URL()}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (agentRes.status === 403) {
      let message = 'Channel pairing required. Configure pairing in Channels.';
      try {
        const data = await agentRes.json() as { error?: string; pairingRequired?: boolean };
        if (data?.pairingRequired) {
          message = `${data.error ?? 'Channel pairing required'}. Configure pairing in Channels.`;
        }
      } catch {
        // Keep default message
      }

      return new Response(
        `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } },
      );
    }

    if (!agentRes.ok || !agentRes.body) {
      return new Response(
        `event: error\ndata: ${JSON.stringify({ error: `Agent returned ${agentRes.status}` })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } },
      );
    }

    // Pipe the SSE stream through
    return new Response(agentRes.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: 'Could not reach agent' })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } },
    );
  }
});

// Abort proxy
app.post('/chat/abort', async (c) => {
  const body = await c.req.json<{ sessionKey: string }>();
  try {
    const res = await fetch(`${AGENT_URL()}/api/chat/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ error: 'Could not reach agent' }, 502);
  }
});

// Reset session proxy
app.post('/chat/reset', async (c) => {
  const body = await c.req.json<{ sessionKey: string }>();
  try {
    const res = await fetch(`${AGENT_URL()}/api/chat/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ error: 'Could not reach agent' }, 502);
  }
});

// Keep the old POST endpoint for backwards compat (gateway might use it)
app.post('/chat/send', async (c) => {
  const body = await c.req.parseBody();
  const message = String(body.message ?? '').trim();
  const sessionKey = String(body.sessionKey ?? '');

  if (!message) return c.body(null, 204);

  try {
    const res = await fetch(`${AGENT_URL()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        sessionKey,
        channelType: 'dashboard',
        channelId: 'dashboard',
      }),
    });

    if (!res.ok) return c.json({ error: `Agent returned ${res.status}` }, 502);
    const data = (await res.json()) as { response: string };
    return c.json(data);
  } catch {
    return c.json({ error: 'Could not reach agent' }, 502);
  }
});

// Chat history list page
app.get('/chat/history', async (c) => {
  const limit = Number(c.req.query('limit')) || 50;
  const offset = Number(c.req.query('offset')) || 0;

  try {
    const res = await fetch(`${AGENT_URL()}/api/conversations/history?limit=${limit}&offset=${offset}`);
    const conversations = (await res.json()) as Array<{
      id: string;
      updatedAt?: string;
      createdAt?: string;
      channelType?: string;
      channelId?: string;
    }>;

    const enriched = await Promise.all(
      conversations.map(async (conv) => {
        try {
          const detailRes = await fetch(`${AGENT_URL()}/api/conversations/history/${encodeURIComponent(conv.id)}`);
          if (!detailRes.ok) {
            return { conv, messageCount: 0, excerpt: 'No messages yet' };
          }
          const detail = (await detailRes.json()) as {
            messages: Array<{ role: string; content: string; timestamp: string }>;
          };
          const messages = detail.messages ?? [];
          const lastMessage = [...messages].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
          return {
            conv,
            messageCount: messages.length,
            excerpt: lastMessage ? safeExcerpt(lastMessage.content) : 'No messages yet',
          };
        } catch {
          return { conv, messageCount: 0, excerpt: 'No messages yet' };
        }
      }),
    );

    const rows = enriched
      .map(({ conv, excerpt, messageCount }) => {
        const activity = conv.updatedAt || conv.createdAt;
        const time = activity ? new Date(activity).toLocaleString() : 'No activity';
        const source = describeConversationSource(conv.channelType, conv.channelId);
        return `
          <tr style="cursor:pointer" onclick="window.location.href='/chat/history/${encodeURIComponent(conv.id)}'">
            <td class="history-col--date">
              <strong>${time}</strong><br>
              <span class="meta">${source}</span>
            </td>
            <td class="meta history-col--excerpt">${excerpt}</td>
            <td class="meta history-col--messages">${messageCount} messages</td>
            <td class="history-col--type"><span class="badge badge--blue">${conv.channelType || 'dashboard'}</span></td>
            <td class="history-col--actions"><a href="/chat/history/${encodeURIComponent(conv.id)}" class="btn btn--sm">View</a></td>
          </tr>`;
      })
      .join('');

    const pagination = `
      <div style="margin-top:1rem;display:flex;justify-content:space-between;align-items:center">
        <div>
          ${offset > 0 ? `<a href="/chat/history?limit=${limit}&offset=${Math.max(0, offset - limit)}" class="btn btn--sm">&larr; Previous</a>` : ''}
        </div>
        <span class="meta">Showing ${offset + 1} - ${offset + conversations.length}</span>
        <div>
          ${conversations.length === limit ? `<a href="/chat/history?limit=${limit}&offset=${offset + limit}" class="btn btn--sm">Next &rarr;</a>` : ''}
        </div>
      </div>`;

    const content = `
      <p><a href="/chat">&larr; Back to Chat</a></p>
      <h1>Chat History</h1>
      <div class="card">
        <style>
          .history-table .history-col--date { min-width: 180px; }
          .history-table .history-col--excerpt { min-width: 260px; }
          .history-table .history-col--messages,
          .history-table .history-col--type,
          .history-table .history-col--actions { white-space: nowrap; }
          @media (max-width: 900px) {
            .history-table .history-col--excerpt { min-width: 320px; }
          }
        </style>
        ${enriched.length > 0 ? `
          <div class="table-scroll">
            <table class="history-table">
              <thead><tr><th>Date / Source</th><th>Excerpt</th><th>Messages</th><th>Type</th><th>Action</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          ${pagination}
        ` : '<p class="meta">No conversations yet.</p>'}
      </div>`;

    return c.html(layout('Chat History', content));
  } catch {
    return c.html(layout('Chat History', '<h1>Chat History</h1><p class="badge badge--red">Agent unreachable</p>'));
  }
});

// Chat history detail page
app.get('/chat/history/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const res = await fetch(`${AGENT_URL()}/api/conversations/history/${encodeURIComponent(id)}`);
    if (!res.ok) {
      return c.html(layout('Conversation Not Found', '<h1>Conversation not found</h1><p><a href="/chat/history">&larr; Back to History</a></p>'), 404);
    }

    const data = (await res.json()) as {
      messages: Array<{ role: string; content: string; timestamp: string }>;
    };

    const messagesHtml = data.messages
      .map((m) => {
        const cls = m.role === 'user' ? 'chat-msg chat-msg--user' : 'chat-msg chat-msg--assistant';
        const label = m.role === 'user' ? 'You' : 'Jonas';
        const timestamp = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
        const body = m.role === 'user'
          ? `<pre class="chat-msg__content">${m.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`
          : `<div class="chat-msg__content chat-md">${m.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;

        return `
          <div class="${cls}">
            <div class="chat-msg__label">${label} <span class="meta" style="font-weight:normal;margin-left:0.5rem">${timestamp}</span></div>
            ${body}
          </div>`;
      })
      .join('');

    const content = `
      <script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
      <script>
        if (typeof marked !== 'undefined') {
          marked.setOptions({ breaks: true, gfm: true });
          document.addEventListener('DOMContentLoaded', function() {
            document.querySelectorAll('.chat-md').forEach(function(el) {
              el.innerHTML = marked.parse(el.textContent);
            });
          });
        }
      </script>
      <p><a href="/chat/history">&larr; Back to History</a></p>
      <h1>Conversation</h1>
      <div style="margin-bottom:1rem">
        <button class="btn" onclick="window.location.href='/chat'">Continue in Chat</button>
      </div>
      <div class="card" style="display:flex;flex-direction:column;gap:0.75rem;max-height:70vh;overflow-y:auto">
        ${messagesHtml || '<p class="meta">No messages in this conversation.</p>'}
      </div>`;

    return c.html(layout('Conversation', content));
  } catch {
    return c.html(layout('Chat History', '<h1>Error</h1><p class="badge badge--red">Could not load conversation</p><p><a href="/chat/history">&larr; Back to History</a></p>'));
  }
});

export default app;
