# Cascade lab

Reproduces a cascading failure in a NestJS API (one slow microservice takes
everything down), then shows how timeout + circuit breaker + bulkhead + fallback
stop it.

- `GET /naive`: no timeout, 3 retries, any failure fails the request
- `GET /protected`: 1 s timeout, circuit breaker per service, bulkhead, fallback

## Setup

```bash
npm install
```

Requires Node 18+.

## Start the lab (restart the API before every experiment)

Terminal 1, the fake services (ports 4001-4003, ~200 ms each):

```bash
npm run mocks
```

Terminal 2, the API (port 3000):

```bash
npm run api
```

Use Terminal 3 for all commands below. Restarting the API gives you a clean
breaker (closed) and an empty pool.

---

## Part 1: Simple tests (curl only)

### Test 1: healthy baseline

```bash
curl -s -w "  -> %{time_total}s\n" localhost:3000/naive
curl -s -w "  -> %{time_total}s\n" localhost:3000/protected
```

Expect: both ~0.2 s.

### Test 2: make one service slow

```bash
curl "localhost:4002/slow?ms=20000"
```

### Test 3: naive endpoint

```bash
curl -s -w "  -> %{time_total}s\n" localhost:3000/naive
```

Expect: hangs ~20 s, waiting on the slow service.

### Test 4: protected endpoint, breaker opening

Run one call per line (do not paste several curls on one line):

```bash
for i in $(seq 1 8); do curl -s -w "  -> %{time_total}s\n" localhost:3000/protected; done
```

Expect:

- Calls 1-5: ~1.0 s each, with `"degraded":true` for 4002. The 1 s timeout cuts
  off the slow service, and the breaker needs 5 calls (`volumeThreshold: 5`)
  before it can trip.
- Terminal 2 prints `[breaker] OPEN :4002` after the 5th.
- Calls 6-8: ~0.2 s. The breaker is open, so 4002 is not called at all.

### Test 5: breaker reopen cycle (keep 4002 slow)

```bash
for i in $(seq 1 25); do echo -n "$(date +%T)  "; curl -s -o /dev/null -w "-> %{time_total}s\n" localhost:3000/protected; sleep 1; done
```

Expect: mostly ~0.2 s calls, with one ~1 s call every ~7 s. That slow call is
the probe: after `resetTimeout` (5 s) the breaker goes half-open and lets one
call through to 4002. The service is still slow, so the probe times out and the
breaker reopens. The spacing is ~7 s, not 5 s, because the probe itself takes
1 s and the loop adds up to ~1 s.

Terminal 2 (with the optional log line) shows, each cycle:

```
[breaker] HALF-OPEN :4002
[breaker] OPEN      :4002
```

### Test 6: recovery

Run the Test 5 loop again, and while it runs, in another terminal:

```bash
curl "localhost:4002/slow?ms=0"
```

Expect: the next probe returns in ~0.2 s, the breaker closes
(`[breaker] CLOSED :4002`), and `degraded` disappears from the response:

```bash
curl localhost:3000/protected
```

---

## Part 2: Load tests (autocannon)

Do these after Part 1. Restart the API first, and make 4002 slow again.

### Why `-R` and not just `-c`

`-c` alone keeps that many requests in flight, which exceeds the 20-slot pool
even when everything is healthy. `-R 50` sends a fixed 50 requests per second.
Healthy requests take ~200 ms, so only ~10 are in flight at a time.

### Baseline (healthy)

```bash
npx autocannon -c 100 -R 50 -d 15 http://localhost:3000/naive
```

Expect: ~200 ms latency, no errors.

### Naive under failure

```bash
curl "localhost:4002/slow?ms=20000"
npx autocannon -c 100 -R 50 -d 30 http://localhost:3000/naive
```

Expect: 0 successful responses, many non-2xx (503 "pool exhausted") and
timeouts, even though 4001 and 4003 are healthy. That is the cascade.
Warning: low latency numbers here are misleading, since 503s are returned
instantly. Always check the success count.

### Protected under failure

Restart the API, then:

```bash
curl "localhost:4002/slow?ms=20000"
npx autocannon -c 100 -R 50 -d 30 http://localhost:3000/protected
```

Expect: all 2xx, max latency ~1 s (the first second, before the breaker
opens), `[breaker] OPEN :4002` in Terminal 2.

### Bulkhead sizing lesson

`capacity` (per-service bulkhead) must be smaller than the shared pool (20
slots here). With `capacity: 50` and a pool of 20, the bulkhead no longer
protects the pool, and the protected endpoint also started returning 503s.
With `capacity: 10` the pool never filled. If the median latency looks lower
than ~200 ms, check whether the healthy services are also returning fallbacks.

---

## Reading autocannon output

- Latency table: compare 50% and 99% between runs.
- `2xx` / `non 2xx` lines: successes versus errors (the 503s).
- `errors` / `timeouts`: requests that got no answer.

## Troubleshooting

- Windows PowerShell: use `curl.exe` instead of `curl`.
- Port in use: stop the old process with Ctrl+C.
- Naive test looks too healthy: restart the API (hung 20 s requests from the
  previous run still hold pool slots) and do step 2 before the test.
- `TimeoutNegativeWarning` from autocannon is harmless.
