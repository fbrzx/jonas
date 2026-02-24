import { Hono } from 'hono';

const AGENT_API_URL = process.env.AGENT_API_URL ?? 'http://localhost:3001';

const app = new Hono();

app.post('/webhooks/:channel', async (c) => {
  const channelName = c.req.param('channel');
  const body = await c.req.json();

  // Fire-and-forget: respond immediately so platforms like Telegram get a fast ack
  fetch(`${AGENT_API_URL}/api/channels/${encodeURIComponent(channelName)}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);

  return c.json({ ok: true });
});

export default app;
