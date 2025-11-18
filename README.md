# LangSmith SDK Memory Leak Test

Replicates memory leak in LangSmith SDK v0.3.17 when service returns 502 errors.

## What It Does

- Mocks LangSmith API to return 502 Bad Gateway responses
- Creates 100 traces/second with large payloads (~50-100KB each)
- Monitors memory usage, queue size, and pending operations every 5 seconds
- Runs for 2 minutes

## Run

```bash
npx tsx index.ts
```

## What to Look For

**Memory leak present:**
- Queue size grows unbounded
- Heap memory increases without GC
- Potential crash: `TypeError: Cannot cancel a stream that already has a reader`

**Memory leak fixed:**
- Queue size stays bounded
- Memory stabilizes with regular GC
- No crashes
