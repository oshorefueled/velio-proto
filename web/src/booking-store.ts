import { ApiError, VelioApi, type BookingView } from "./api.js";
import type { SessionStore } from "./session-store.js";

/**
 * Reusable booking operation controller (issue #15): one logical operation
 * per identity+activity with a stable persisted operationId, and explicit
 * idle/pending/checking/unknown/confirmed/refused phases so a pending
 * request can never be mistaken for a confirmation.
 *
 * Outcome rules (docs/client-contract.md §3, PLANS 2.5):
 * - Only a saved server booking confirms membership; a replay (created:false)
 *   is the same saved booking.
 * - After a lost response, 500 booking_outcome_unknown, or any transport
 *   failure, the saved booking is checked (bookings/me) BEFORE another POST
 *   may be offered. Found -> confirmed. Contractual 404 -> definitively
 *   absent. Unreachable/failed check -> unknown with explicit "check again".
 * - A retry retains the SAME operationId, so a request that is still in
 *   flight server-side replays to the same logical operation.
 * - Results are scoped to the identity and activity that issued them: an
 *   identity switch or selection switch abandons in-flight results, keeps
 *   the persisted operation context, and never replays mutations.
 */

export type BookingRefusalReason =
  /** Reconciliation found no saved booking — definitively nothing reserved. */
  | "absent"
  | "sold-out"
  | "started"
  | "completed"
  | "rate-limited"
  | "not-found"
  | "failed"
  /** Invited-claim refusals: definitive for this attempt, preview refreshes. */
  | "invite-expired"
  | "invite-unknown"
  | "invite-mismatch";

export type BookingPhase =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "checking"; quiet: boolean }
  | { kind: "unknown"; message: string }
  | { kind: "confirmed"; booking: BookingView }
  | {
      kind: "refused";
      reason: BookingRefusalReason;
      message: string;
      retryAfterSeconds?: number;
      retryAt?: number;
    };

export interface BookingState {
  activityId: string | null;
  phase: BookingPhase;
}

const OPERATIONS_KEY = "velio.booking-ops.v2";
/** Ticket-15 stored plain operation-id strings; read them, write the v2 shape. */
const LEGACY_OPERATIONS_KEY = "velio.booking-ops.v1";

interface StoredOperation {
  operationId: string;
  /** The invite code bound to this logical operation, if it was invited. */
  inviteCode?: string;
  definitiveFailure?: boolean;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike {
  return {
    getItem: (key) => globalThis.localStorage?.getItem(key) ?? null,
    setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
  };
}

export interface BookingStore {
  getState(): BookingState;
  subscribe(listener: (state: BookingState) => void): () => void;
  /**
   * Selection changed. With a credential, this checks the saved booking so
   * reopening/refreshing shows existing membership even if the activity is
   * now full or started.
   */
  viewActivity(activityId: string | null, token: string | null): void;
  /**
   * Explicit submit; the stable operationId is reused automatically. An
   * invited claim binds its code to the logical operation: retries keep the
   * original code until the operation is definitively resolved.
   */
  submit(activityId: string, token: string, inviteCode?: string): void;
  /** From unknown: check the saved booking again (never auto-POSTs). */
  checkAgain(activityId: string, token: string): void;
}

export function createBookingStore(
  api: VelioApi,
  session: SessionStore,
  storage: StorageLike = defaultStorage(),
): BookingStore {
  function normalizeOperation(entry: unknown): StoredOperation | null {
    if (typeof entry === "string") return { operationId: entry };
    if (typeof entry === "object" && entry !== null && typeof (entry as StoredOperation).operationId === "string") {
      const stored = entry as StoredOperation;
      return {
        operationId: stored.operationId,
        ...(typeof stored.inviteCode === "string" ? { inviteCode: stored.inviteCode } : {}),
        ...(stored.definitiveFailure === true ? { definitiveFailure: true } : {}),
      };
    }
    return null;
  }
  function loadOperations(): Record<string, StoredOperation> {
    const operations: Record<string, StoredOperation> = {};
    try {
      const legacy = storage.getItem(LEGACY_OPERATIONS_KEY);
      const legacyParsed =
        legacy === null ? null : (JSON.parse(legacy) as { operations?: Record<string, string> });
      for (const [key, value] of Object.entries(legacyParsed?.operations ?? {})) {
        const normalized = normalizeOperation(value);
        if (normalized !== null) operations[key] = normalized;
      }
    } catch {
      /* A broken legacy file is replaced by the v2 shape below. */
    }
    try {
      const raw = storage.getItem(OPERATIONS_KEY);
      const parsed = raw === null
        ? null
        : (JSON.parse(raw) as { operations?: Record<string, unknown> });
      for (const [key, value] of Object.entries(parsed?.operations ?? {})) {
        const normalized = normalizeOperation(value);
        if (normalized !== null) operations[key] = normalized;
      }
    } catch {
      /* Corrupt entries are ignored; the next submit re-persists. */
    }
    return operations;
  }
  let operations = loadOperations();
  function persistOperations(): void {
    storage.setItem(OPERATIONS_KEY, JSON.stringify({ operations }));
  }
  /**
   * Stable per identity+activity: a retry replays the same operation. An
   * invited operation keeps its code across retries of an unresolved
   * logical operation, including after departure or refresh. A saved operation
   * never silently adopts the code of a later landing.
   */
  function operationFor(userId: string, activityId: string, inviteCode?: string): StoredOperation {
    const key = `${userId}:${activityId}`;
    const existing = operations[key];
    if (existing === undefined || (existing.definitiveFailure && existing.inviteCode !== inviteCode)) {
      const created: StoredOperation =
        inviteCode === undefined ? { operationId: crypto.randomUUID() } : { operationId: crypto.randomUUID(), inviteCode };
      operations[key] = created;
      persistOperations();
      return created;
    }
    return existing;
  }

  let state: BookingState = { activityId: null, phase: { kind: "idle" } };
  const listeners = new Set<(state: BookingState) => void>();
  function set(next: BookingState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  /**
   * One monotonic run for result ownership: bumped on selection change and
   * on identity change, so a late response can never confirm or expire a
   * newer identity or another activity.
   */
  let run = 0;
  let lastIdentity = session.getState().status;

  function currentUserId(): string | null {
    const status = session.getState().status;
    return status.status === "ready" ? status.user.id : null;
  }

  session.subscribe(() => {
    const identity = session.getState().status;
    if (identity === lastIdentity) return;
    lastIdentity = identity;
    run += 1;
    // Identity changed: keep the selected activity and the persisted
    // operation context, drop the phase (and any receipt shown for the
    // previous person). No mutation is replayed; the boot check runs again
    // from viewActivity.
    set({ activityId: state.activityId, phase: { kind: "idle" } });
  });

  async function reconcile(activityId: string, token: string, quiet: boolean): Promise<void> {
    const currentRun = run;
    set({ activityId, phase: { kind: "checking", quiet } });
    try {
      const booking = await api.getMyBooking(token, activityId);
      if (run !== currentRun) return;
      if (booking.activityId !== activityId || booking.userId !== currentUserId()) {
        throw new Error("The booking receipt does not match your selected identity and activity.");
      }
      set({ activityId, phase: { kind: "confirmed", booking } });
    } catch (err) {
      if (run !== currentRun) return;
      if (err instanceof ApiError && err.status === 404 && err.code === "booking_not_found") {
        // Definitive absence. A quiet check (reopen/refresh) simply shows
        // no membership; a check after an unresolved POST enables the
        // explicit-retry path.
        set({
          activityId,
          phase: quiet
            ? { kind: "idle" }
            : {
                kind: "refused",
                reason: "absent",
                message: "No saved booking was found for this activity — nothing was reserved.",
              },
        });
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        session.credentialLost(err.message);
        return;
      }
      set({
        activityId,
        phase: {
          kind: "unknown",
          message:
            err instanceof Error
              ? `Could not check your booking: ${err.message}`
              : "Could not check your booking.",
        },
      });
    }
  }

  async function postBooking(activityId: string, token: string, inviteCode?: string): Promise<void> {
    const userId = currentUserId();
    if (userId === null) return;
    const currentRun = run;
    const operation = operationFor(userId, activityId, inviteCode);
    set({ activityId, phase: { kind: "pending" } });
    if (operation.inviteCode !== undefined) {
      void api.emitClaimStarted({
        eventId: crypto.randomUUID(),
        visitorId: session.getState().visitorId,
        inviteCode: operation.inviteCode,
        token,
      }).catch(() => {});
    }
    try {
      const result = await api.bookActivity(token, activityId, operation.operationId, undefined, operation.inviteCode);
      if (run !== currentRun) return;
      if (result.booking.activityId !== activityId || result.booking.userId !== userId) {
        throw new Error("The booking receipt does not match your selected identity and activity.");
      }
      set({ activityId, phase: { kind: "confirmed", booking: result.booking } });
    } catch (err) {
      if (run !== currentRun) return;
      if (!(err instanceof ApiError)) {
        // Transport/network failure: the request may still have committed.
        await reconcile(activityId, token, false);
        return;
      }
      if (["invite_expired", "invite_not_found", "invite_recipient_mismatch", "activity_sold_out", "activity_started", "activity_completed", "activity_not_found"].includes(err.code)) {
        operation.definitiveFailure = true;
        persistOperations();
      }
      switch (err.code) {
        case "activity_sold_out":
          set({
            activityId,
            phase: {
              kind: "refused",
              reason: "sold-out",
              message: "This activity just filled — your attempt was not reserved.",
            },
          });
          return;
        case "activity_started":
          set({
            activityId,
            phase: { kind: "refused", reason: "started", message: "This activity has already started." },
          });
          return;
        case "activity_completed":
          set({
            activityId,
            phase: {
              kind: "refused",
              reason: "completed",
              message: "This activity is already completed.",
            },
          });
          return;
        case "request_limit":
          set({
            activityId,
            phase: {
              kind: "refused",
              reason: "rate-limited",
              message: "Too many attempts. Please wait before trying again.",
              retryAfterSeconds: err.retryAfterSeconds,
              retryAt: Date.now() + (err.retryAfterSeconds ?? 0) * 1000,
            },
          });
          return;
        case "activity_not_found":
          set({
            activityId,
            phase: { kind: "refused", reason: "not-found", message: "This activity could not be found." },
          });
          return;
        case "invite_expired":
          set({
            activityId,
            phase: {
              kind: "refused",
              reason: "invite-expired",
              message: "This invitation has expired, so it cannot be claimed.",
            },
          });
          return;
        case "invite_not_found":
          set({
            activityId,
            phase: {
              kind: "refused",
              reason: "invite-unknown",
              message: "This invitation code is not recognized.",
            },
          });
          return;
        case "invite_recipient_mismatch":
          set({
            activityId,
            phase: {
              kind: "refused",
              reason: "invite-mismatch",
              message: "This invitation was vouched for a different contact — switch to the account that was invited to claim it.",
            },
          });
          return;
        case "session_required":
        case "session_invalid":
        case "session_expired":
          // Drop only the lost credential: the selection and the persisted
          // operation context stay, and nothing is replayed automatically.
          session.credentialLost(err.message);
          set({ activityId, phase: { kind: "idle" } });
          return;
        case "booking_outcome_unknown":
          await reconcile(activityId, token, false);
          return;
        default:
          // Any other server failure (including 503 lock_timeout, a rolled
          // back attempt) is definitive for THIS attempt, but the safe path
          // is still to check the saved booking before another POST.
          await reconcile(activityId, token, false);
          return;
      }
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    viewActivity(activityId, token) {
      run += 1;
      if (activityId === null) {
        set({ activityId: null, phase: { kind: "idle" } });
        return;
      }
      set({ activityId, phase: { kind: "idle" } });
      if (token !== null) void reconcile(activityId, token, true);
    },

    submit(activityId, token, inviteCode) {
      if (state.activityId !== activityId) return;
      if (state.phase.kind !== "idle" && state.phase.kind !== "refused") return;
      if (state.phase.kind === "refused" && (state.phase.retryAt ?? 0) > Date.now()) return;
      void postBooking(activityId, token, inviteCode);
    },

    checkAgain(activityId, token) {
      if (state.activityId !== activityId) return;
      if (state.phase.kind !== "unknown") return;
      void reconcile(activityId, token, false);
    },
  };
}
