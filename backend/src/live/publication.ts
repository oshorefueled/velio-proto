import type { Redis } from "ioredis";

/**
 * Live availability publication (PLANS.md 3.4). After a booking commits, the
 * API publishes the committed activity id, availability version, remaining
 * spots and the committed confirmation event's id to an environment-prefixed
 * Redis Pub/Sub channel with a finite budget. Publication never touches the
 * database: callers invoke it strictly after COMMIT, and a refusal, stall or
 * failure resolves within the budget and is only counted and logged — it can
 * never undo a booking or turn a saved success into a failure. There is no
 * outbox, queue or durable replay: missed notifications are recovered by
 * database snapshots.
 */

export interface AvailabilityUpdate {
  activityId: string;
  /** Monotonic availability version; string for safe bigint representation. */
  version: string;
  remainingSpots: number;
  /** The committed booking_confirmed event's id — committed identity, not an invented message id. */
  eventId: string | null;
}

export interface PublicationStats {
  attempts: number;
  published: number;
  failures: number;
}

export interface LivePublication {
  publishAvailability(update: AvailabilityUpdate): Promise<void>;
  stats: PublicationStats;
}

const AVAILABILITY_CHANNEL = "availability";

export function availabilityChannel(prefix: string): string {
  return `${prefix}:${AVAILABILITY_CHANNEL}`;
}

export function createLivePublication(
  redis: Redis,
  channelPrefix: string,
  publishTimeoutMs: number,
): LivePublication {
  const channel = availabilityChannel(channelPrefix);
  const stats: PublicationStats = { attempts: 0, published: 0, failures: 0 };

  return {
    stats,
    async publishAvailability(update: AvailabilityUpdate): Promise<void> {
      stats.attempts += 1;
      const payload = JSON.stringify({ type: "availability", ...update });
      const attempt = redis.publish(channel, payload).then((receivers) => {
        // No subscribers is still a successful publication: Redis carried it
        // as far as it can and snapshots recover everyone else.
        if (receivers === 0) {
          console.warn(`live: published ${channel} with no subscribers`);
        }
      });
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("live publication timed out")), publishTimeoutMs);
        // Do not hold the process open for a budget that lost the race.
        timer.unref();
      });
      try {
        await Promise.race([attempt, timeout]);
        stats.published += 1;
      } catch (err) {
        stats.failures += 1;
        console.warn(
          `live: publication failed for ${update.activityId} v${update.version}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Swallowed by design: a saved booking's outcome is never affected.
      }
    },
  };
}
