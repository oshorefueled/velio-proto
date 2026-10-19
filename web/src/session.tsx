import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, VelioApi } from "./api.js";
import { createSessionStore, type SessionState, type SessionStore } from "./session-store.js";

/**
 * React binding for the session store: one provider, one hook. An
 * authorized API call that comes back 401 reports the loss to the store —
 * the workspace stays mounted (drafts and the selected activity survive),
 * the remembered email restores access, and authorized views reload after
 * recovery. The failed call is never replayed automatically.
 */

export interface SessionContextValue {
  api: VelioApi;
  state: SessionState;
  store: SessionStore;
  /** Wrapper for authorized calls: 401 -> credentialLost + rethrow. */
  authorized: <T>(call: (api: VelioApi, token: string) => Promise<T>) => Promise<T>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  children,
  transport,
  storage,
}: {
  children: ReactNode;
  transport?: ConstructorParameters<typeof VelioApi>[0];
  storage?: Parameters<typeof createSessionStore>[1];
}): ReactNode {
  const api = useMemo(() => new VelioApi(transport), [transport]);
  const store = useMemo(() => createSessionStore(api, storage), [api, storage]);
  const [state, setState] = useState<SessionState>(store.getState());
  useEffect(() => store.subscribe(setState), [store]);

  const value = useMemo<SessionContextValue>(() => {
    const authorized = async <T,>(call: (api: VelioApi, token: string) => Promise<T>): Promise<T> => {
      const current = store.getState();
      if (current.status.status !== "ready") {
        throw new ApiError(401, "session_required", "Select your identity first");
      }
      try {
        const result = await call(api, current.status.token);
        if (store.getState().status !== current.status) throw new DOMException("Identity changed", "AbortError");
        return result;
      } catch (err) {
        if (store.getState().status !== current.status) throw new DOMException("Account changed", "AbortError");
        if (
          store.getState().status === current.status &&
          err instanceof ApiError &&
          (err.status === 401 || err.code === "session_invalid" || err.code === "session_expired")
        ) {
          store.credentialLost(err.message);
        }
        throw err;
      }
    };
    return { api, state, store, authorized };
  }, [api, store, state]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession must be used inside SessionProvider");
  }
  return value;
}
