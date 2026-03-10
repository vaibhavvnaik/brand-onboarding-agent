require('dotenv').config();

const { connectDB } = require('../config/database');
const { run } = require('../agents/brandOnboardingAgent');
const { processInbox } = require('../services/inboxProcessor');
const { processPendingConfirmations } = require('../services/confirmationProcessor');
const { ingestPendingNewsletters } = require('../services/newsletterIngestor');

async function runJob(job, options = {}) {
  switch (job) {
    case 'discover_and_signup':
      return run({
        batchSize: Number(options.batchSize || process.env.BATCH_SIZE || 10),
        mode: 'full',
        onProgress: () => {},
        getStopFlag: () => false
      });
    case 'scan_inbox':
      return processInbox({
        hours: Number(options.inboxHours || options.hours || process.env.SCAN_HOURS || 24),
        maxResults: Number(options.maxInboxResults || options.maxResults || process.env.SCAN_MAX_RESULTS || 100)
      });
    case 'process_confirmations':
      return processPendingConfirmations({
        limit: Number(options.limit || process.env.CONFIRMATION_LIMIT || 50)
      });
    case 'ingest_newsletters':
      return ingestPendingNewsletters({
        limit: Number(options.limit || process.env.INGEST_LIMIT || 50)
      });
    default:
      throw new Error(`Unknown job: ${job}`);
  }
}

if (require.main === module) {
  const job = process.argv[2];
  if (!job) {
    console.error('Usage: node jobs/runJob.js <discover_and_signup|scan_inbox|process_confirmations|ingest_newsletters>');
    process.exit(1);
  }

  connectDB()
    .then(() => runJob(job))
    .then((result) => {
      console.log(JSON.stringify({ job, result }, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { runJob };
