import { describe, expect, it } from "vitest";
import { ApiError, VelioApi } from "./api.js";
import { createSessionStore } from "./session-store.js";

/**
 * Focused risk check: delayed responses must not restore an abandoned
 * identity (stale-response ownership), and losing a credential mid-flow
 * keeps the "credential-lost" context without fabricating a person.
 * The transport is a fake at the API boundary — no backend service is
 * mocked for this; the backend contract lives in its own suites.
 */

type Pending = {
  resolve: (value: { status: number; json: unknown }) => void;
  reject: (reason?: unknown) => void;
};

function fakeTransport(handlers: {
  onCall?: (call: number, url: string) => void;
  /** Default: immediate success; a queue makes specific calls hang. */
  hangCalls?: Set<number>;
  delayMs?: number;
}) {
  let call = 0;
  const pending = new Map<number, Pending>();
  const transport = (url: string) => {
    call += 1;
    const thisCall = call;
    handlers.onCall?.(thisCall, url);
    if (handlers.hangCalls?.has(thisCall)) {
      return new Promise<{ status: number; json: unknown }>((resolve, reject) => {
        pending.set(thisCall, { resolve, reject });
      });
    }
    const respond = () =>
      Promise.resolve({
        status: 200,
        json: {
          session: { token: `token-${thisCall}`, expiresAt: "2026-12-31T00:00:00Z" },
          user: { id: `user-${thisCall}`, email: `key-${thisCall}`, displayName: `User ${thisCall}`, signupSource: "direct", signupGeneration: 0 },
          created: true,
        },
      });
    return handlers.delayMs === undefined ? respond() : new Promise((resolve) => setTimeout(resolve, handlers.delayMs)).then(respond);
  };
  return { transport, settle: (n: number) => pending.get(n)!.resolve({ status: 200, json: { session: { token: "late", expiresAt: "x" }, user: { id: "late-user", email: "late", displayName: "Late", signupSource: "direct", signupGeneration: 0 }, created: true } }) };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function storageLike(map: Map<string, string>) {
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("session store", () => {
  it("discards a delayed establish once a newer attempt owns the store", async () => {
    const hang = new Set([1]);
    const fake = fakeTransport({ hangCalls: hang });
    const store = createSessionStore(new VelioApi(fake.transport), memoryStorage());

    const slow = store.establish({ email: "slow-identity" });
    const fast = store.establish({ email: "fast-identity" });
    await fast;
    // The slow response resolves late: it must not restore its person.
    fake.settle(1);
    await slow;

    const state = store.getState();
    expect(state.status.status).toBe("ready");
    expect(state.status.status === "ready" && state.status.user.id).toBe("user-2");
  });

  it("keeps credential-lost context on 401-style loss and never fabricates a person", async () => {
    const storageMap = new Map<string, string>();
    const store = createSessionStore(new VelioApi(fakeTransport({}).transport), storageLike(storageMap));
    await store.establish({ email: "someone" });
    expect(store.getState().status.status).toBe("ready");

    store.credentialLost("Session has expired");
    const state = store.getState();
    expect(state.status.status).toBe("credential-lost");
    expect(state.status.status === "credential-lost" && state.status.lostFrom?.id).toBe("user-1");
    // The stale credential is gone from storage.
    expect(storageMap.has("velio.session.v1")).toBe(false);
    // The visitor id stays (versioned storage, correlation continues).
    expect(state.visitorId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps one stable visitor id across identities", async () => {
    const storageMap = new Map<string, string>();
    const store = createSessionStore(new VelioApi(fakeTransport({}).transport), storageLike(storageMap));
    const first = store.getState().visitorId;
    await store.establish({ email: "a" });
    store.signOut();
    await store.establish({ email: "b" });
    expect(store.getState().visitorId).toBe(first);
  });

  it("surfaces machine-readable selection errors without dropping the form state owner", async () => {
    let failing = true;
    const transport = () =>
      failing
        ? Promise.resolve({ status: 400, json: { error: { code: "validation_error", message: "Select your identity again" } } })
        : Promise.resolve({
            status: 200,
            json: {
              session: { token: "t", expiresAt: "x" },
              user: { id: "u", email: "k", displayName: "U", signupSource: "direct", signupGeneration: 0 },
              created: true,
            },
          });
    const store = createSessionStore(new VelioApi(transport), memoryStorage());
    await store.establish({ email: "" });
    expect(store.getState().status.status).toBe("anonymous");
    const anonymousState = store.getState().status;
    expect(anonymousState.status === "anonymous" && anonymousState.error).toBe("Select your identity again");
    failing = false;
    await store.establish({ email: "fine" });
    expect(store.getState().status.status).toBe("ready");
    expect(new ApiError(1, "x", "y").code).toBe("x");
  });
});
