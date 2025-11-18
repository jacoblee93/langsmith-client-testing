import "dotenv/config";
import { v4 } from "uuid";
import { Client } from "langsmith";

/**
 * Test case to replicate LangSmith SDK memory leak when service is unavailable
 *
 * Reproduces the issue where:
 * 1. Multiple concurrent drainAutoBatchQueue() operations run simultaneously
 * 2. Operations don't complete when API is down (network timeouts)
 * 3. Memory grows unbounded until application crashes
 * 4. Eventually throws: TypeError: Cannot cancel a stream that already has a reader
 */

const TEST_DURATION_MS = 120000; // Run for 120 seconds (2 minutes)
const TRACE_INTERVAL_MS = 10; // Create traces VERY rapidly (100 per second)

// Mock fetch to simulate 502 Bad Gateway responses
global.fetch = async (input: any, init?: any) => {
  // Intercept requests to LangSmith API and return 502
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("api.smith.langchain")) {
    // Return a 502 Bad Gateway response
    return new Response(JSON.stringify({ error: "Bad Gateway" }), {
      status: 429,
      statusText: "Bad Gateway",
      headers: { "Content-Type": "application/json" },
    });
  }
  console.log(`Unexpected fetch call: ${url}`);
  throw new Error("Should never happen");
};

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
  };
}

async function replicateMemoryLeak() {
  console.log("=== LangSmith Memory Leak Replication Test ===\n");
  console.log("Simulating LangSmith 502 Bad Gateway responses...");
  console.log(`Test will run for ${TEST_DURATION_MS / 1000} seconds\n`);

  // Initialize client with real LangSmith API URL (will be intercepted by our mock)
  const client = new Client({
    apiUrl: "https://api.smith.langchain.com",
    apiKey: "test-api-key",
  });

  // Mock _getServerInfo to return server info but let actual requests fail
  // This simulates the scenario where initial connection works but subsequent requests fail
  const mockServerInfo = {
    version: "0.12.44",
    instance_flags: {
      blob_storage_enabled: true,
      blob_storage_engine: "S3",
      dataset_examples_multipart_enabled: true,
      examples_multipart_enabled: true,
      experimental_search_enabled: false,
      generate_ai_query_enabled: true,
      gzip_body_enabled: true,
      org_creation_disabled: false,
      payment_enabled: true,
      personal_orgs_disabled: false,
      playground_auth_bypass_enabled: false,
      s3_storage_enabled: true,
      search_enabled: true,
      self_hosted_jit_provisioning_enabled: true,
      show_ttl_ui: true,
      trace_tier_duration_days: { longlived: 400, shortlived: 14 },
      workspace_scope_org_invites: false,
      zstd_compression_enabled: true,
    },
    batch_ingest_config: {
      use_multipart_endpoint: true,
      scale_up_qsize_trigger: 1000,
      scale_up_nthreads_limit: 16,
      scale_down_nempty_trigger: 4,
      size_limit: 100,
      size_limit_bytes: 20971520,
    },
  };

  // Override _getServerInfo method
  (client as any)._getServerInfo = async () => mockServerInfo;

  const initialMemory = getMemoryUsage();
  console.log("Initial Memory Usage:");
  console.log(`  RSS: ${formatBytes(initialMemory.rss)}`);
  console.log(`  Heap Used: ${formatBytes(initialMemory.heapUsed)}`);
  console.log(`  Heap Total: ${formatBytes(initialMemory.heapTotal)}\n`);

  let traceCount = 0;
  const startTime = Date.now();

  // Generate large payload data that won't compress easily
  const generateRandomText = (length: number) => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };

  const largeInput = {
    query: generateRandomText(5000),
    context: Array.from({ length: 50 }, (_, i) => ({
      id: Math.random().toString(36),
      content: generateRandomText(200),
      timestamp: Date.now() + i,
      metadata: { section: i, relevance: Math.random() },
    })),
    user_info: {
      user_id: Math.random().toString(36),
      session_id: Math.random().toString(36),
      preferences: generateRandomText(500),
    },
    metadata: {
      request_id: Math.random().toString(36),
      timestamp: Date.now(),
      version: "1.0.0",
    },
  };

  const largeOutput = {
    result: generateRandomText(10000),
    intermediate_steps: Array.from({ length: 100 }, (_, i) => ({
      step: i,
      action: generateRandomText(150),
      observation: generateRandomText(150),
      thought: generateRandomText(100),
      score: Math.random(),
    })),
    metadata: {
      processing_time_ms: Math.random() * 1000,
      model_version: "gpt-4",
      tokens_used: Math.floor(Math.random() * 10000),
    },
    confidence: Math.random(),
  };

  // Monitor memory every 5 seconds
  const memoryMonitor = setInterval(() => {
    const currentMemory = getMemoryUsage();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const heapGrowth = currentMemory.heapUsed - initialMemory.heapUsed;

    // Access internal queue to get queue size
    const queueSize = (client as any).autoBatchQueue?.items?.length || 0;
    const pendingItems = (client as any).pendingAutoBatchedRunLimit || 0;

    console.log(`[${elapsed}s] Traces created: ${traceCount} | Queue size: ${queueSize} | Pending: ${pendingItems}`);
    console.log(`  Heap Used: ${formatBytes(currentMemory.heapUsed)} (+${formatBytes(heapGrowth)})`);
    console.log(`  RSS: ${formatBytes(currentMemory.rss)}`);
  }, 5000);

  // Rapidly create traces to trigger multiple concurrent drainAutoBatchQueue() calls
  const traceInterval = setInterval(() => {
    try {
      const traceId = v4();
      // Create runs with large payloads that will fail to send
      const runPromise = client.createRun({
        name: `test-run-${traceCount}`,
        run_type: "chain",
        inputs: { ...largeInput, iteration: traceCount },
        outputs: largeOutput,
        project_name: "memory-leak-test",
        trace_id: traceId,
        dotted_order: `20241013T070535809001Z${traceId}`,
      });

      // Catch errors to prevent unhandled rejections from crashing the test
      runPromise.catch((error) => {
        // Silently ignore errors - we expect these to fail
        // In production, these errors might not be properly handled either
      });

      traceCount++;
    } catch (error) {
      console.error(`\n!!! Synchronous error creating run: ${error}`);
    }
  }, TRACE_INTERVAL_MS);

  // Run test for specified duration
  await new Promise((resolve) => setTimeout(resolve, TEST_DURATION_MS));

  clearInterval(traceInterval);
  clearInterval(memoryMonitor);

  // Final memory report
  const finalMemory = getMemoryUsage();
  const heapGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
  const rssGrowth = finalMemory.rss - initialMemory.rss;

  console.log("\n=== Final Memory Report ===");
  console.log(`Total traces attempted: ${traceCount}`);
  console.log(`\nInitial Heap Used: ${formatBytes(initialMemory.heapUsed)}`);
  console.log(`Final Heap Used: ${formatBytes(finalMemory.heapUsed)}`);
  console.log(`Heap Growth: ${formatBytes(heapGrowth)}`);
  console.log(`\nInitial RSS: ${formatBytes(initialMemory.rss)}`);
  console.log(`Final RSS: ${formatBytes(finalMemory.rss)}`);
  console.log(`RSS Growth: ${formatBytes(rssGrowth)}`);

  // Wait a bit to see if memory cleanup happens
  console.log("\nWaiting 10 seconds to observe if memory is released...");
  await new Promise((resolve) => setTimeout(resolve, 10000));

  const afterWaitMemory = getMemoryUsage();
  console.log(`Heap after wait: ${formatBytes(afterWaitMemory.heapUsed)}`);

  if (heapGrowth > 50 * 1024 * 1024) {
    // 50MB growth
    console.log("\n⚠️  MEMORY LEAK DETECTED: Heap grew by more than 50MB");
  } else {
    console.log("\n✓ Memory growth appears normal");
  }
}

// Run the test
replicateMemoryLeak().catch((error) => {
  console.error("\n!!! Test crashed with error:", error);
  process.exit(1);
});
