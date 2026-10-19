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
  | { status: "credential-lost"; lostFrom: UserSnapshot | null; restoring?: boolean; error?: string };

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
  establish(input: { email: string; displayName?: string; inviteCode?: string }, signal?: AbortSignal): Promise<void>;
  /** Restore the remembered email after a 401 without replaying a mutation. */
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

  const persisted = readJson<{ token: string | null; user: UserSnapshot }>(storage, SESSION_KEY);
  let state: SessionState = {
    status:
      persisted !== null
        ? persisted.token !== null
          ? { status: "ready", token: persisted.token, user: persisted.user }
          : { status: "credential-lost", lostFrom: persisted.user }
        : { status: "anonymous" },
    visitorId: visitor.visitorId,
  };
  const listeners = new Set<(state: SessionState) => void>();
  let establishGeneration = 0;

  function set(next: SessionState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  const store: SessionStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async establish(input, signal) {
      if (signal?.aborted) return;
      const generation = ++establishGeneration;
      const lostFrom = state.status.status === "credential-lost" ? state.status.lostFrom : null;
      const restoring = state.status.status === "credential-lost" && state.status.restoring === true;
      try {
        const establishment: SessionEstablishment = await api.establishSession({
          ...input,
          visitId,
          visitorId: visitor.visitorId,
          channel: "web",
        }, signal);
        if (generation !== establishGeneration || signal?.aborted) return;
        if (restoring && lostFrom !== null && establishment.user.id !== lostFrom.id) {
          throw new Error("Could not restore your remembered account. Please sign in again.");
        }
        storage.setItem(
          SESSION_KEY,
          JSON.stringify({ token: establishment.session.token, user: establishment.user }),
        );
        set({
          status: { status: "ready", token: establishment.session.token, user: establishment.user },
          visitorId: visitor.visitorId,
        });
      } catch (err) {
        if (generation !== establishGeneration || signal?.aborted) return;
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Selection failed";
        set({
          status: lostFrom !== null
            ? { status: "credential-lost", lostFrom, error: message }
            : { status: "anonymous", error: message },
          visitorId: visitor.visitorId,
        });
      }
    },

    credentialLost(error) {
      if (state.status.status === "credential-lost") return;
      const lostFrom = state.status.status === "ready" ? state.status.user : null;
      if (lostFrom !== null) storage.setItem(SESSION_KEY, JSON.stringify({ token: null, user: lostFrom }));
      else storage.removeItem(SESSION_KEY);
      const restoring = lostFrom?.email !== undefined;
      set({ status: { status: "credential-lost", lostFrom, restoring, error }, visitorId: visitor.visitorId });
      if (restoring && lostFrom?.email !== undefined) {
        void store.establish({ email: lostFrom.email });
      }
    },

    signOut() {
      establishGeneration += 1; // any in-flight selection no longer owns the store
      storage.removeItem(SESSION_KEY);
      set({ status: { status: "anonymous" }, visitorId: visitor.visitorId });
    },
  };
  if (state.status.status === "credential-lost" && state.status.lostFrom?.email !== undefined) {
    const email = state.status.lostFrom.email;
    state = { ...state, status: { ...state.status, restoring: true } };
    void store.establish({ email });
  }
  return store;
}
