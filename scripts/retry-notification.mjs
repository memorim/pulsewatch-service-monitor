import { retryFailedNotification } from '../notifications.js';
process.env.NODE_ENV = 'test';
const { createDb } = await import('../server.js');
const id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id < 1 || process.argv.length !== 3) {
  console.error('Usage: node scripts/retry-notification.mjs EVENT_ID');
  process.exitCode = 1;
} else {
  const db = createDb();
  try {
    if (!retryFailedNotification(db, id)) {
      console.error('No failed, unleased event found; no changes made.');
      process.exitCode = 1;
    } else console.log(JSON.stringify({ event: 'notification_requeued', id }));
  } finally {
    db.close();
  }
}
