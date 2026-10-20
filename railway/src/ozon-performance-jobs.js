// Persist each component report, not only the final combined period. A timeout
// must resume the UUID already issued by Ozon instead of consuming another job.
export function createPerformanceJobs({read, write, now = Date.now}) {
  const running = new Map();
  async function run(key, {submit, collect, ttl, retainUntilComplete = false}) {
    let entry = await read(key) || {};
    if (Array.isArray(entry.rows) && (retainUntilComplete && entry.complete !== true || now() - entry.at < ttl)) return entry.rows;
    if (!entry.uuid || now() - entry.createdAt >= 24 * 60 * 60 * 1000) {
      const uuid = await submit();
      if (!uuid) throw new Error('Ozon Performance: отчёт не поставлен в очередь');
      entry = {uuid, createdAt: now()};
      // Do not poll an unrecorded job: retries must be able to resume it.
      await write(key, entry);
    }
    try {
      const rows = await collect(entry.uuid);
      await write(key, {rows, at: now(), complete: !retainUntilComplete});
      return rows;
    } catch (error) {
      // A failed/missing job can be recreated. Timeouts, download errors and
      // rate limits retain its UUID, including across deploys and restarts.
      if (error.code === 'REPORT_FAILED' || error.status === 404) await write(key, {});
      throw error;
    }
  }
  return {
    async complete(keys) {
      for (const key of keys) {
        const entry = await read(key);
        if (Array.isArray(entry?.rows) && entry.complete !== true) await write(key, {...entry, complete: true, at: now()});
      }
    },
    get(key, options) {
      if (running.has(key)) return running.get(key);
      const task = run(key, options).finally(() => running.delete(key));
      running.set(key, task);
      return task;
    }
  };
}
