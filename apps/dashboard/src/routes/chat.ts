import { Hono } from 'hono';
import { layout } from '../views/layout.js';

const app = new Hono();

const AGENT_URL = () => process.env.AGENT_API_URL ?? 'http://localhost:3001';

app.get('/chat', (c) => {
  const content = `
    <div class="chat-container">
      <div class="chat-header">
        <h2>Chat</h2>
        <button id="btn-new-chat" class="btn btn--sm" title="New conversation">New Chat</button>
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

      function renderAllMessages() {
        messagesEl.innerHTML = messages.map(function(m) {
          var cls = m.role === 'user' ? 'chat-msg chat-msg--user' : 'chat-msg chat-msg--assistant';
          var label = m.role === 'user' ? 'You' : 'Jonas';
          var body = m.role === 'user'
            ? '<pre class="chat-msg__content">' + escapeHtml(m.content) + '</pre>'
            : '<div class="chat-msg__content chat-md">' + renderMd(m.content) + '</div>';
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
                  } else if (eventType === 'error') {
                    responseContent = 'Error: ' + (data.error || 'Unknown error');
                  }
                } catch(e) {}
                eventType = '';
              }
            }
          }

          removeThinkingIndicator();
          if (responseContent) {
            messages.push({ role: 'assistant', content: responseContent });
            renderAllMessages();
            saveMessages();
          }
        } catch(err) {
          removeThinkingIndicator();
          if (err.name !== 'AbortError') {
            messages.push({ role: 'assistant', content: 'Error: ' + (err.message || 'could not reach agent') });
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

  if (!message) return c.text('', 204);

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

export default app;
