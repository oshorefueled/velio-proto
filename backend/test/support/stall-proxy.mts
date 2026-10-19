import net from "node:net";

/**
 * Test-only TCP proxy in front of Redis with three modes:
 *  - forward: byte-pipe between client and the real Redis (default)
 *  - stall:   accept and read but never respond — commands hang until the
 *             caller's own command/publication timeout fires
 *  - reset:   destroy every connected socket once, then return to forward —
 *             forces ioredis to see a dropped connection and reconnect
 * Used to prove real refused/stalled Redis behaviour with no production
 * fault-injection hooks.
 */
export class RedisStallProxy {
  private server: net.Server;
  private mode: "forward" | "stall" = "forward";
  private upstreams = new Set<net.Socket>();
  private downstreams = new Set<net.Socket>();
  private publicationHeld?: () => void;
  readonly port: number;

  constructor(port: number, private upstreamPort: number) {
    this.port = port;
    this.server = net.createServer((downstream) => {
      this.downstreams.add(downstream);
      downstream.on("close", () => this.downstreams.delete(downstream));
      if (this.mode === "stall") {
        downstream.on("data", () => {});
        return;
      }
      const upstream = net.connect(upstreamPort);
      this.upstreams.add(upstream);
      // Parse complete RESP request frames so a PUBLISH can be held before
      // Redis receives it, while handshake/quota/subscription traffic flows.
      let pending = Buffer.alloc(0);
      downstream.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length > 0) {
          const headerEnd = pending.indexOf("\r\n");
          if (headerEnd < 0) return;
          const count = Number(pending.subarray(1, headerEnd).toString());
          let offset = headerEnd + 2;
          let command = "";
          for (let i = 0; i < count; i += 1) {
            const lengthEnd = pending.indexOf("\r\n", offset);
            if (lengthEnd < 0) return;
            const length = Number(pending.subarray(offset + 1, lengthEnd).toString());
            const next = lengthEnd + 2 + length + 2;
            if (pending.length < next) return;
            if (i === 0) command = pending.subarray(lengthEnd + 2, next - 2).toString().toLowerCase();
            offset = next;
          }
          const frame = pending.subarray(0, offset);
          pending = pending.subarray(offset);
          if (command === "publish" && this.publicationHeld) {
            this.publicationHeld();
          } else {
            upstream.write(frame);
          }
        }
      });
      upstream.pipe(downstream);
      upstream.on("error", () => downstream.destroy());
      downstream.on("error", () => upstream.destroy());
      downstream.on("close", () => {
        upstream.destroy();
        this.upstreams.delete(upstream);
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, "127.0.0.1", resolve));
  }

  stall(): void {
    this.mode = "stall";
    // Existing forwarded connections keep working until the connection
    // itself is dropped — a real Redis outage drops them, and only then does
    // the client notice. Drop them now so reconnects land in the stall.
    for (const upstream of this.upstreams) {
      upstream.destroy();
    }
    for (const downstream of this.downstreams) {
      downstream.destroy();
    }
  }

  holdPublications(): Promise<void> {
    return new Promise((resolve) => { this.publicationHeld = resolve; });
  }

  forward(): void {
    this.publicationHeld = undefined;
    this.mode = "forward";
  }

  /** Destroy every proxied connection once: ioredis reconnects through the proxy. */
  resetConnections(): void {
    for (const upstream of this.upstreams) {
      upstream.destroy();
    }
    this.upstreams.clear();
  }

  close(): Promise<void> {
    for (const downstream of this.downstreams) {
      downstream.destroy();
    }
    for (const upstream of this.upstreams) {
      upstream.destroy();
    }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
