const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const logger = require('../utils/logger');

const OUTPUT_DIR = path.join(__dirname, '../artifacts/newsletters');

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function screenshotEmailMessage(message) {
  ensureOutputDir();
  const safeId = String(message.gmailMessageId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(OUTPUT_DIR, `${safeId}.png`);

  const html = message.bodyHtml
    ? message.bodyHtml
    : `<html><body><pre style="white-space:pre-wrap;font-family:Arial,sans-serif;">${message.bodyText || message.textBody || message.snippet || ''}</pre></body></html>`;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function ingestPendingNewsletters({ limit = 50 } = {}) {
  const candidates = await EmailMessage.find({
    emailType: { $in: ['newsletter', 'welcome'] },
    'processedBy.fnl_reader.done': { $ne: true }
  }).sort({ receivedAt: -1 }).limit(limit);

  const stats = {
    scanned: candidates.length,
    ingested: 0,
    failed: 0,
    skipped: 0
  };

  for (const message of candidates) {
    if (!message.brandId) {
      message.processedBy.fnl_reader = {
        done: false,
        at: new Date(),
        version: 'v1',
        attempts: (message.processedBy?.fnl_reader?.attempts || 0) + 1,
        status: 'skipped',
        lastProcessedAt: new Date(),
        error: 'Missing brandId'
      };
      message.needsReview = true;
      await message.save();
      stats.skipped += 1;
      continue;
    }

    const brand = await Brand.findById(message.brandId);
    if (!brand) {
      message.processedBy.fnl_reader = {
        done: false,
        at: new Date(),
        version: 'v1',
        attempts: (message.processedBy?.fnl_reader?.attempts || 0) + 1,
        status: 'error',
        lastProcessedAt: new Date(),
        error: 'Brand not found'
      };
      message.needsReview = true;
      await message.save();
      stats.failed += 1;
      continue;
    }

    try {
      let screenshotPath = null;
      try {
        screenshotPath = await screenshotEmailMessage(message);
      } catch (screenshotErr) {
        logger.warn(`[ingest_newsletters] screenshot skipped for ${message.gmailMessageId}: ${screenshotErr.message}`);
      }
      message.screenshotPath = screenshotPath;
      message.ingestedAt = new Date();
      message.state = 'ingested';
      message.processedBy.fnl_reader = {
        done: true,
        at: new Date(),
        version: 'v1',
        attempts: (message.processedBy?.fnl_reader?.attempts || 0) + 1,
        status: 'done',
        lastProcessedAt: new Date(),
        error: null
      };
      await message.save();

      if (message.emailType === 'newsletter') {
        if (!brand.firstNewsletterAt) brand.firstNewsletterAt = message.receivedAt || new Date();
        brand.lastNewsletterAt = message.receivedAt || new Date();
      }
      await brand.save();

      stats.ingested += 1;
    } catch (err) {
      logger.warn(`[ingest_newsletters] ${message.gmailMessageId}: ${err.message}`);
      message.processedBy.fnl_reader = {
        done: false,
        at: new Date(),
        version: 'v1',
        attempts: (message.processedBy?.fnl_reader?.attempts || 0) + 1,
        status: 'error',
        lastProcessedAt: new Date(),
        error: err.message
      };
      message.state = 'error';
      message.needsReview = true;
      await message.save();
      stats.failed += 1;
    }
  }

  logger.info(`[ingest_newsletters] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = {
  ingestPendingNewsletters
};
