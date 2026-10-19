import { ApiError, VelioApi, type SessionEstablishment, type UserSnapshot } from "./api.js";

/**
 * One persistent demo session + one persistent visitor id, owned by a small
 * subscribable store (the "small context + fetch shape" from the ticket):
 * no global state framework, no duplicated server state — the store holds
 * only the credential and the resolved person.
 *
 * Stale-response ownership: every establish attempt takes a generation; a
 * late resolution from a superseded attempt is discarded, so switching
 * identities quickly can never restore the wrong person.
 *
 * Storage is versioned ("velio.session.v1", "velio.visitor.v1") and holds
 * the minimum: token + user snapshot, and the visitor UUID. Boot resumes a
 * persisted credential without a round trip; the first authorized request
 * re-validates it and a 401 flows to credentialLost.
 */

export type SessionStatus =
  | { status: "boot" }
  | { status: "anonymous"; error?: string }
  | { status: "ready"; token: string; user: UserSnapshot }
  | { status: "credential-lost"; lostFrom: UserSnapshot | null; error?: string };

export interface SessionState {
  status: SessionStatus;
  visitorId: string;
}

const SESSION_KEY = "velio.session.v1";
const VISITOR_KEY = "velio.visitor.v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike {
  return {
    getItem: (key) => globalThis.localStorage?.getItem(key) ?? null,
    setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
    removeItem: (key) => globalThis.localStorage?.removeItem(key),
  };
}

function readJson<T>(storage: StorageLike, key: string): T | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export interface SessionStore {
  getState(): SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  /** Establish or resume the person for a contact; generation-guarded.
   * An optional inviteCode travels unchanged: the backend applies it as
   * acquisition only when this selection creates a new person. */
  establish(input: { email: string; displayName?: string; inviteCode?: string }): Promise<void>;
  cancelEstablishment(): void;
  /** Drop the credential after a 401 while keeping on-screen context. */
  credentialLost(error?: string): void;
  /** Explicit identity switch: forget everything, back to selection. */
  signOut(): void;
}

export function createSessionStore(
  api: VelioApi,
  storage: StorageLike = defaultStorage(),
): SessionStore {
  const visitId = globalThis.sessionStorage?.getItem("velio.visit.v1") ?? crypto.randomUUID();
  globalThis.sessionStorage?.setItem("velio.visit.v1", visitId);
  const visitor = readJson<{ visitorId: string }>(storage, VISITOR_KEY) ?? { visitorId: crypto.randomUUID() };
  storage.setItem(VISITOR_KEY, JSON.stringify(visitor));

  const persisted = readJson<{ token: string; user: UserSnapshot }>(storage, SESSION_KEY);
  let state: SessionState = {
    status:
      persisted !== null
        ? { status: "ready", token: persisted.token, user: persisted.user }
        : { status: "anonymous" },
    visitorId: visitor.visitorId,
  };
  const listeners = new Set<(state: SessionState) => void>();
  let establishGeneration = 0;

  function set(next: SessionState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async establish(input) {
      const generation = ++establishGeneration;
      const wasCredentialLost = state.status.status === "credential-lost";
      try {
        const establishment: SessionEstablishment = await api.establishSession({
          ...input,
          visitId,
          visitorId: visitor.visitorId,
          channel: "web",
        });
        if (generation !== establishGeneration) return; // a newer attempt owns the store
        storage.setItem(
          SESSION_KEY,
          JSON.stringify({ token: establishment.session.token, user: establishment.user }),
        );
        set({
          status: { status: "ready", token: establishment.session.token, user: establishment.user },
          visitorId: visitor.visitorId,
        });
      } catch (err) {
        if (generation !== establishGeneration) return;
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Selection failed";
        set({
          status: wasCredentialLost
            ? { status: "credential-lost", lostFrom: null, error: message }
            : { status: "anonymous", error: message },
          visitorId: visitor.visitorId,
        });
      }
    },

    cancelEstablishment() {
      establishGeneration += 1;
    },

    credentialLost(error) {
      storage.removeItem(SESSION_KEY);
      const lostFrom = state.status.status === "ready" ? state.status.user : null;
      set({ status: { status: "credential-lost", lostFrom, error }, visitorId: visitor.visitorId });
    },

    signOut() {
      establishGeneration += 1; // any in-flight selection no longer owns the store
      storage.removeItem(SESSION_KEY);
      set({ status: { status: "anonymous" }, visitorId: visitor.visitorId });
    },
  };
}
