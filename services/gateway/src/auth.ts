/**
 * Token-based authentication for WebSocket connections.
 */

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? '';

/**
 * Validates that the provided token matches the configured GATEWAY_TOKEN.
 * Returns false if GATEWAY_TOKEN is not set (empty).
 */
export function validateToken(token: string): boolean {
  if (!GATEWAY_TOKEN) return false;
  return token === GATEWAY_TOKEN;
}

/**
 * Extracts the `token` query parameter from a WebSocket URL.
 * Expects URLs like `ws://host:port/?token=abc123` or `/path?token=abc123`.
 */
export function extractToken(url: string): string | null {
  try {
    // Handle relative URLs by prepending a base
    const parsed = new URL(url, 'http://localhost');
    return parsed.searchParams.get('token');
  } catch {
    return null;
  }
}
