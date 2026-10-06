export async function api(path, { token, pin, method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(pin ? { 'X-Room-Pin': pin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

export async function login(password) {
  return (await api('/api/login', { method: 'POST', body: { password } })).token;
}

export function startPolling({ token, room, pin, role, onEvent, onError }) {
  let since = 0;
  let stopped = false;
  async function poll() {
    while (!stopped) {
      try {
        const result = await api(`/api/rooms/${room}/events?role=${role}&since=${since}`, { token, pin });
        for (const event of result.events) {
          since = Math.max(since, event.seq);
          await onEvent(event);
        }
        since = Math.max(since, result.latest || 0);
        await new Promise(resolve => setTimeout(resolve, 700));
      } catch (error) {
        onError(error);
        await new Promise(resolve => setTimeout(resolve, 1800));
      }
    }
  }
  poll();
  return () => { stopped = true; };
}

export const rtcConfig = { iceServers: [] };
