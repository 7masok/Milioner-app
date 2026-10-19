// Persist each component report, not only the final combined period. A timeout
// must resume the UUID already issued by Ozon instead of consuming another job.
export function createPerformanceJobs({read, write, now = Date.now}) {
  const running = new Map();
  async function run(key, {submit, collect, ttl}) {
    let entry = await read(key) || {};
    if (Array.isArray(entry.rows) && now() - entry.at < ttl) return entry.rows;
    if (!entry.uuid || now() - entry.createdAt >= 24 * 60 * 60 * 1000) {
      const uuid = await submit();
      if (!uuid) throw new Error('Ozon Performance: отчёт не поставлен в очередь');
      entry = {uuid, createdAt: now()};
      // Do not poll an unrecorded job: retries must be able to resume it.
      await write(key, entry);
    }
    try {
      const rows = await collect(entry.uuid);
      await write(key, {rows, at: now()});
      return rows;
    } catch (error) {
      // A failed/missing job can be recreated. Timeouts, download errors and
      // rate limits retain its UUID, including across deploys and restarts.
      if (error.code === 'REPORT_FAILED' || error.status === 404) await write(key, {});
      throw error;
    }
  }
  return {
    get(key, options) {
      if (running.has(key)) return running.get(key);
      const task = run(key, options).finally(() => running.delete(key));
      running.set(key, task);
      return task;
    }
  };
}
