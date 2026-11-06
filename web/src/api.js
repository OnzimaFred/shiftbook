// Talking to the Shiftbook API. Same origin, session cookie, JSON both ways.
export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const listeners = { signedOut: () => {}, mustChange: () => {} };
export const onAuthProblem = (kind, fn) => { listeners[kind] = fn; };

export async function api(method, url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "No connection. Check your signal and try again.", "offline");
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? "Something went wrong. Try again.", data?.code);
    if (err.code === "signed_out") listeners.signedOut();
    if (err.code === "must_change_password") listeners.mustChange();
    throw err;
  }
  return data;
}

export const get = (url) => api("GET", url);
export const post = (url, body = {}, headers) => api("POST", url, body, headers);
export const put = (url, body = {}) => api("PUT", url, body);
export const patch = (url, body = {}) => api("PATCH", url, body);
export const del = (url) => api("DELETE", url);
