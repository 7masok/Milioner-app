export async function pruneWarehouseBackups(client) {
  // Full warehouse snapshots can be large. Keep the newest 100 safety points
  // plus anything created during the last 90 days, and enforce this policy
  // after every code path that creates a backup.
  await client.query(`DELETE FROM warehouse_backups
    WHERE id NOT IN (SELECT id FROM warehouse_backups ORDER BY created_at DESC LIMIT 100)
      AND created_at < $1`, [Date.now() - 90 * 24 * 60 * 60 * 1000]);
}
