import 'dotenv/config';
import { startWorkerRuntime } from './worker';

async function main() {
  const rt = await startWorkerRuntime();
  console.log('[worker] BullMQ workers started (separate process)');
  const interval = setInterval(() => {
    void rt.publishOutboxOnce();
  }, 1000);
  const maint = setInterval(() => {
    void rt.reconcileOnce();
  }, 30_000);

  const stop = async (sig: string) => {
    console.log(`[worker] Received ${sig}; shutting down gracefully...`);
    clearInterval(interval);
    clearInterval(maint);
    await rt.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

if (require.main === module) void main();
