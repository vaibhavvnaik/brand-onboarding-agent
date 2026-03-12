require('dotenv').config();

const { connectDB } = require('../config/database');
const { run } = require('../agents/brandOnboardingAgent');
const { processInbox, processInboxFullHistory } = require('../services/inboxProcessor');
const { processPendingConfirmations } = require('../services/confirmationProcessor');
const {
  ingestPendingNewsletters,
  backfillListingsFromEmailMessages,
  retakeListingScreenshots,
  retryMissingScreenshotsForIngested
} = require('../services/newsletterIngestor');
const { runLinkLegacyListingsToEmails } = require('./linkLegacyListingsToEmails');
const { backfillGmailLabelsForExistingEmails } = require('../services/gmailStatusLabels');
let runScrubSensitiveContentBackfill = null;
try {
  ({ runScrubSensitiveContentBackfill } = require('./scrubSensitiveContentBackfill'));
} catch (err) {
  // Keep server bootable if this optional job module is absent in a deployment artifact.
  if (err?.code !== 'MODULE_NOT_FOUND') throw err;
}

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
        hours: Number(options.inboxHours ?? options.hours ?? process.env.SCAN_HOURS ?? 24),
        maxResults: Number(options.maxInboxResults ?? options.maxResults ?? process.env.SCAN_MAX_RESULTS ?? 0)
      });
    case 'scan_inbox_full_history':
      return processInboxFullHistory({
        maxResults: Number(options.maxResults || process.env.SCAN_FULL_MAX_RESULTS || 0),
        pageSize: Number(options.pageSize || process.env.SCAN_FULL_PAGE_SIZE || 500),
        query: options.query || process.env.SCAN_FULL_QUERY || null
      });
    case 'process_confirmations':
      return processPendingConfirmations({
        limit: Number(options.limit || process.env.CONFIRMATION_LIMIT || 50)
      });
    case 'ingest_newsletters':
      return ingestPendingNewsletters({
        limit: Number(options.limit || process.env.INGEST_LIMIT || 50)
      });
    case 'backfill_listings':
      return backfillListingsFromEmailMessages({
        limit: Number(options.limit || process.env.BACKFILL_LIMIT || 500),
        withScreenshots: String(options.withScreenshots ?? process.env.BACKFILL_WITH_SCREENSHOTS ?? 'false') === 'true',
        forceUpdate: String(options.forceUpdate ?? process.env.BACKFILL_FORCE_UPDATE ?? 'false') === 'true',
        missingScreenshotOnly: String(options.missingScreenshotOnly ?? process.env.BACKFILL_MISSING_SCREENSHOT_ONLY ?? 'false') === 'true',
        forceScreenshotRetake: String(options.forceScreenshotRetake ?? 'false') === 'true'
      });
    case 'link_legacy_listings_to_emails':
      return runLinkLegacyListingsToEmails({
        limit: Number(options.limit || process.env.LINK_LEGACY_LIMIT || 500),
        autoThreshold: Number(options.autoThreshold || process.env.LINK_LEGACY_AUTO_THRESHOLD || 0.95),
        minAmbiguousThreshold: Number(options.minAmbiguousThreshold || process.env.LINK_LEGACY_AMBIGUOUS_THRESHOLD || 0.6),
        ambiguousGap: Number(options.ambiguousGap || process.env.LINK_LEGACY_AMBIGUOUS_GAP || 0.15),
        dryRun: String(options.dryRun ?? process.env.LINK_LEGACY_DRY_RUN ?? 'false') === 'true'
      });
    case 'retake_screenshots':
      return retakeListingScreenshots({
        limit: Number(options.limit || 100),
        dryRun: String(options.dryRun ?? 'false') === 'true',
        skipAlreadyRetaken: String(options.skipAlreadyRetaken ?? 'true') === 'true'
      });
    case 'retry_missing_screenshots':
      return retryMissingScreenshotsForIngested({
        limit: Number(options.limit || process.env.RETRY_MISSING_SCREENSHOTS_LIMIT || 50)
      });
    case 'scrub_sensitive_content':
      if (typeof runScrubSensitiveContentBackfill !== 'function') {
        throw new Error('scrub_sensitive_content job unavailable: missing jobs/scrubSensitiveContentBackfill.js');
      }
      return runScrubSensitiveContentBackfill({
        dryRun: options.dryRun ?? process.env.SCRUB_SENSITIVE_DRY_RUN ?? 'false',
        emailBatchSize: Number(options.emailBatchSize ?? process.env.SCRUB_SENSITIVE_EMAIL_BATCH_SIZE ?? 200),
        listingBatchSize: Number(options.listingBatchSize ?? process.env.SCRUB_SENSITIVE_LISTING_BATCH_SIZE ?? 200),
        emailLimit: Number(options.emailLimit ?? process.env.SCRUB_SENSITIVE_EMAIL_LIMIT ?? 0),
        listingLimit: Number(options.listingLimit ?? process.env.SCRUB_SENSITIVE_LISTING_LIMIT ?? 0)
      });
    case 'backfill_gmail_labels':
      return backfillGmailLabelsForExistingEmails({
        limit: Number(options.limit ?? process.env.GMAIL_LABEL_BACKFILL_LIMIT ?? 2000),
        dryRun: String(options.dryRun ?? process.env.GMAIL_LABEL_BACKFILL_DRY_RUN ?? 'false') === 'true'
      });
    default:
      throw new Error(`Unknown job: ${job}`);
  }
}

if (require.main === module) {
  const job = process.argv[2];
  if (!job) {
    console.error('Usage: node jobs/runJob.js <discover_and_signup|scan_inbox|scan_inbox_full_history|process_confirmations|ingest_newsletters|retry_missing_screenshots|backfill_listings|link_legacy_listings_to_emails|scrub_sensitive_content|backfill_gmail_labels>');
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
