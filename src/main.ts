import {
  Controller,
  Get,
  Module,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import CircuitBreaker from "opossum";
import "reflect-metadata";

const PORTS = [4001, 4002, 4003];
const call = (port: number, signal?: AbortSignal) =>
  fetch(`http://localhost:${port}/`, { signal }).then((r) => r.json());

// Stand-in for DB connections: a request holds a slot for its whole lifetime.
class Pool {
  used = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.used >= this.max)
      throw new ServiceUnavailableException("pool exhausted");
    this.used++;
    try {
      return await fn();
    } finally {
      this.used--;
    }
  }
}

// ---- PROTECTED: timeout + circuit breaker + bulkhead (capacity) + fallback ----
const breakers = PORTS.map((port) => {
  const b = new CircuitBreaker(() => call(port), {
    timeout: 1000, // fail after 1 s, not 20 s
    errorThresholdPercentage: 50, // open when half the calls fail
    volumeThreshold: 5,
    resetTimeout: 5000, // probe again after 5 s
    capacity: 10, // bulkhead: max 10 in-flight per service
  });
  b.fallback(() => ({ service: port, degraded: true }));
  b.on("open", () => console.log(`[breaker] OPEN  :${port}`));
  b.on("halfOpen", () => console.log(`[breaker] HALF-OPEN :${port}`));
  b.on("close", () => console.log(`[breaker] CLOSED :${port}`));
  return b;
});

@Controller()
class AppController {
  private naivePool = new Pool(30);
  private protectedPool = new Pool(30);

  // Naive: no timeout, 3 retries, one failure fails the request.
  @Get("naive")
  naive() {
    const withRetry = async (port: number) => {
      for (let i = 0; ; i++) {
        try {
          return await call(port);
        } catch (e) {
          if (i >= 2) throw e;
        }
      }
    };
    const t = Date.now();
    return this.naivePool.run(() => Promise.all(PORTS.map(withRetry)));
    // .then((r) => {
    //   console.log(
    //     `naive took ${Date.now() - t}ms, pool used=${this.naivePool.used}`,
    //   );
    //   return r;
    // });
  }

  @Get("protected")
  protected() {
    return this.protectedPool.run(() =>
      Promise.all(breakers.map((b) => b.fire())),
    );
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

NestFactory.create(AppModule, { logger: ["error"] }).then((app) =>
  app.listen(3000).then(() => console.log("API on :3000")),
);
