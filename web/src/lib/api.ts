/** Client for the Rust signalling server. Only metadata and SDP/ICE go here. */

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
  sha256: string;
}

export type Role = "sender" | "receiver";

/**
 * What the deployment allows. `required` is the default and what a public
 * instance should run; `off` exists for trusted networks where the DTLS the data
 * channel already provides is deemed enough.
 */
export type EncryptionPolicy = "required" | "optional" | "off";

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(detail.error ?? `signalling server returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Read once at startup and shared by both peers, so they agree on whether to
 * encrypt before the handshake rather than negotiating from scratch.
 */
export async function encryptionPolicy(): Promise<EncryptionPolicy> {
  try {
    // Never from cache: the policy is a property of the deployment as it is
    // right now, and a stale copy would have the peers negotiating an
    // encryption level the server no longer allows.
    const { encryption } = await request<{ encryption: EncryptionPolicy }>("/config", {
      cache: "no-store",
    });
    return encryption;
  } catch {
    // An older or unreachable server: assume the safe end of the range.
    return "required";
  }
}

/**
 * Registers the file and receives a nameplate — the leading number of the code.
 * The two words the user reads out are chosen in the browser and deliberately
 * never sent here; see spake2.ts.
 */
export function createSession(meta: FileMeta): Promise<{ nameplate: string }> {
  return request("/sessions", { method: "POST", body: JSON.stringify(meta) });
}

export function getSession(
  nameplate: string,
): Promise<{ nameplate: string; meta: FileMeta; claimed: boolean }> {
  return request(`/sessions/${encodeURIComponent(nameplate)}`);
}

export function postSignal(code: string, role: Role, message: unknown): Promise<unknown> {
  return request(`/sessions/${encodeURIComponent(code)}/signal?role=${role}`, {
    method: "POST",
    body: JSON.stringify(message),
  });
}

export function deleteSession(code: string): Promise<unknown> {
  return request(`/sessions/${encodeURIComponent(code)}`, { method: "DELETE" }).catch(() => null);
}

/**
 * Drains the peer's mailbox until aborted. The server holds each request open
 * until there is mail or ~20s pass, so this is a long poll, not a busy loop.
 */
export async function pollSignals(
  code: string,
  role: Role,
  onMessage: (message: any) => void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await fetch(
        `${BASE}/api/sessions/${encodeURIComponent(code)}/poll?role=${role}`,
        { signal },
      );
      if (response.status === 404) throw new Error("the transfer code expired");
      if (!response.ok) throw new Error(`signalling server returned ${response.status}`);
      const { messages } = (await response.json()) as { messages: any[] };
      for (const message of messages) {
        if (signal.aborted) return;
        await onMessage(message);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof Error && error.message.includes("expired")) throw error;
      // A transient network blip should not end the session; back off and retry.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * The STUN-only list used until (or unless) the signalling server answers with
 * something better. `VITE_ICE_SERVERS` can still hard-code a list at build time;
 * it wins over the default but is itself overridden by a live `/api/turn`.
 */
function iceFallback(): RTCIceServer[] {
  const configured = import.meta.env.VITE_ICE_SERVERS;
  if (configured) {
    try {
      return JSON.parse(configured) as RTCIceServer[];
    } catch {
      console.warn("VITE_ICE_SERVERS is not valid JSON; falling back to the default STUN server");
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

let iceCache: RTCIceServer[] | null = null;
let iceInFlight: Promise<RTCIceServer[]> | null = null;
// Set true only once /api/turn confirms it appended a real relay.
let relayConfirmed = false;

/**
 * Whether a TURN relay is in play. Disabled by default: it is on only when the
 * build sets `VITE_TURN_ENABLED=true` or the server reports it serves one. When
 * false the app warns that STUN-only transfers can fail across corporate VPNs
 * and mobile carriers.
 */
export function turnEnabled(): boolean {
  return import.meta.env.VITE_TURN_ENABLED === "true" || relayConfirmed;
}

/**
 * ICE servers for the peer connection. The deployment owns this list at
 * `/api/turn`, so a TURN relay can be added by server config alone — no rebuild.
 * Without a relay, two peers behind symmetric NATs (most mobile networks) can
 * never punch a direct path. Resolves to the STUN-only fallback if the endpoint
 * is unreachable or empty.
 */
export function loadIceServers(): Promise<RTCIceServer[]> {
  if (iceCache) return Promise.resolve(iceCache);
  if (!iceInFlight) {
    iceInFlight = request<{ iceServers: RTCIceServer[]; relay?: boolean }>("/turn")
      .then((body) => {
        relayConfirmed = body.relay === true;
        iceCache =
          Array.isArray(body.iceServers) && body.iceServers.length > 0
            ? body.iceServers
            : iceFallback();
        return iceCache;
      })
      .catch(() => {
        iceCache = iceFallback();
        return iceCache;
      });
  }
  return iceInFlight;
}

/** Whatever is known synchronously right now — the fallback until the fetch lands. */
export function iceServersNow(): RTCIceServer[] {
  return iceCache ?? iceFallback();
}

// Warm the cache at load, well before the first transfer needs it.
void loadIceServers();
