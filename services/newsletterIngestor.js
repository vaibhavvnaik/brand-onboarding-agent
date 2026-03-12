const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const { chromium } = require('playwright');
const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const logger = require('../utils/logger');
const { markEmailActivity } = require('./gmailStatusLabels');
const { normalizeDomain, getRegistrableDomain } = require('../utils/domainIdentity');
const { scrubSensitiveContent } = require('../utils/contentScrubber');

const OUTPUT_DIR = path.join(__dirname, '../artifacts/newsletters');
const DEFAULT_CATEGORY_NAME = 'Uncategorized';
const DEFAULT_B2_BUCKET_NAME = 'urklist';

const PROMO_PATTERNS = [
  /(?:code|coupon|promo|voucher)[:\s]+([A-Z0-9_-]{3,20})/gi,
  /\b([A-Z]{3,}[0-9]{0,4})\b/g
];

const DISCOUNT_PATTERN = /\b(\d{1,2}%\s*(?:off|OFF|discount|DISCOUNT))\b/;

let b2Session = null;

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function slugifyText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120);
}

function extractDomainFromEmail(email = '') {
  if (!email.includes('@')) return '';
  return normalizeDomain(email.split('@').pop());
}

function formatBrandNameFromDomain(domain = '') {
  const registrable = getRegistrableDomain(domain) || domain;
  const label = (registrable || '').split('.')[0] || 'Brand';
  return label
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function extractPromoCodes(subject = '', body = '') {
  const text = `${subject || ''}\n${body || ''}`;
  const found = new Set();

  for (const pattern of PROMO_PATTERNS) {
    let match = pattern.exec(text);
    while (match) {
      const code = (match[1] || match[0] || '').trim().toUpperCase();
      if (code.length >= 3 && code.length <= 20 && /[A-Z]/.test(code) && /\d|[A-Z]{4,}/.test(code)) {
        if (!code.includes('HTTP') && !code.includes('HTML')) found.add(code);
      }
      match = pattern.exec(text);
    }
    pattern.lastIndex = 0;
  }

  return Array.from(found).slice(0, 10);
}

function extractDiscountText(subject = '') {
  const match = DISCOUNT_PATTERN.exec(subject || '');
  if (!match) return null;
  return match[1];
}

async function screenshotEmailMessage(message, { sharedBrowser } = {}) {
  ensureOutputDir();
  const safeId = String(message.gmailMessageId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(OUTPUT_DIR, `${safeId}.png`);

  const html = message.bodyHtml
    ? scrubSensitiveContent(message.bodyHtml)
    : `<html><body><pre style="white-space:pre-wrap;font-family:Arial,sans-serif;">${scrubSensitiveContent(message.bodyText || message.textBody || message.snippet || '')}</pre></body></html>`;

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || undefined;
  const viewportWidth = Number(process.env.NEWSLETTER_SCREENSHOT_VIEWPORT_WIDTH || 600);
  const viewportHeight = Number(process.env.NEWSLETTER_SCREENSHOT_VIEWPORT_HEIGHT || 1200);
  const ownBrowser = !sharedBrowser;
  const browser = sharedBrowser || await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  let page;
  try {
    page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight } });
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30000 });

    // Inject CSS to force email content to fill the viewport width.
    // Email HTML uses fixed-width tables; overriding them makes the
    // content stretch edge-to-edge so tile thumbnails have no side whitespace.
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = [
        'html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; width: 100% !important; }',
        'table { width: 100% !important; max-width: 100% !important; }',
        'td { max-width: 100% !important; }',
        'center { width: 100% !important; }',
        'img { max-width: 100% !important; height: auto !important; }',
        '.wrapper, .container, .email-body, .email-container { width: 100% !important; max-width: 100% !important; }'
      ].join('\n');
      document.head.appendChild(style);
      // Remove fixed width attributes on tables and wide tds
      document.querySelectorAll('table[width]').forEach(function(t) { t.removeAttribute('width'); });
      document.querySelectorAll('td[width]').forEach(function(td) {
        var w = parseInt(td.getAttribute('width'), 10);
        if (w > 300) td.removeAttribute('width');
      });
    });

    // CSS injection causes reflow which may trigger new network requests
    // (e.g. newly-visible images, background images). Wait for network to settle again.
    await page.waitForLoadState('networkidle').catch(() => {});

    // Wait for all <img> elements to finish loading so the screenshot captures
    // the fully-rendered newsletter, not a partially-loaded blank page.
    await page.evaluate(() => {
      return Promise.all(
        Array.from(document.querySelectorAll('img')).map(img => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 8000);
          });
        })
      );
    });

    // Wait for CSS background images to load (many newsletters use background-image for hero banners)
    await page.evaluate(() => {
      const bgElements = [];
      const allElements = document.querySelectorAll('*');
      for (let i = 0; i < allElements.length; i++) {
        const style = window.getComputedStyle(allElements[i]);
        const bgImage = style.backgroundImage;
        if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
          const urlMatch = bgImage.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
          if (urlMatch) bgElements.push(urlMatch[1]);
        }
      }
      if (bgElements.length === 0) return Promise.resolve();
      return Promise.all(bgElements.map(url => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = resolve;
          img.onerror = resolve;
          setTimeout(resolve, 8000);
          img.src = url;
        });
      }));
    });

    // Wait for web fonts to finish loading (prevents fallback font flash)
    await page.evaluate(() => {
      if (document.fonts && document.fonts.ready) {
        return document.fonts.ready;
      }
      return Promise.resolve();
    }).catch(() => {});

    // Stabilization delay for CSS reflows, font swaps, and late-rendering content.
    // 500ms was too short — some newsletters need time for final paint.
    await page.waitForTimeout(2000);

    await page.screenshot({ path: filePath });
    return filePath;
  } finally {
    if (page) await page.close().catch(() => {});
    if (ownBrowser) await browser.close().catch(() => {});
  }
}

function canUseB2() {
  return !!(process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY);
}

async function authorizeB2() {
  if (b2Session?.accountAuthToken && b2Session?.apiUrl && b2Session?.bucketId) {
    return b2Session;
  }

  const authBase = process.env.B2_AUTH_BASE_URL || 'https://api.backblazeb2.com';
  const bucketName = process.env.B2_BUCKET_NAME || DEFAULT_B2_BUCKET_NAME;

  const authRes = await axios.get(`${authBase}/b2api/v2/b2_authorize_account`, {
    auth: {
      username: process.env.B2_KEY_ID,
      password: process.env.B2_APPLICATION_KEY
    },
    timeout: 15000
  });

  const { accountId, authorizationToken, apiUrl, downloadUrl } = authRes.data;

  const bucketRes = await axios.post(
    `${apiUrl}/b2api/v2/b2_list_buckets`,
    { accountId, bucketName },
    {
      headers: { Authorization: authorizationToken },
      timeout: 15000
    }
  );

  const bucket = (bucketRes.data?.buckets || []).find((item) => item.bucketName === bucketName);
  if (!bucket?.bucketId) {
    throw new Error(`B2 bucket not found: ${bucketName}`);
  }

  const uploadRes = await axios.post(
    `${apiUrl}/b2api/v2/b2_get_upload_url`,
    { bucketId: bucket.bucketId },
    {
      headers: { Authorization: authorizationToken },
      timeout: 15000
    }
  );

  b2Session = {
    accountId,
    accountAuthToken: authorizationToken,
    apiUrl,
    downloadUrl,
    bucketId: bucket.bucketId,
    bucketName,
    uploadUrl: uploadRes.data.uploadUrl,
    uploadAuthToken: uploadRes.data.authorizationToken
  };

  return b2Session;
}

async function refreshUploadUrl() {
  const session = await authorizeB2();
  const uploadRes = await axios.post(
    `${session.apiUrl}/b2api/v2/b2_get_upload_url`,
    { bucketId: session.bucketId },
    {
      headers: { Authorization: session.accountAuthToken },
      timeout: 15000
    }
  );
  session.uploadUrl = uploadRes.data.uploadUrl;
  session.uploadAuthToken = uploadRes.data.authorizationToken;
  return session;
}

async function uploadScreenshotToB2(filePath, key, maxRetries = 3) {
  const session = await authorizeB2();
  const fileBuffer = fs.readFileSync(filePath);
  const sha1 = crypto.createHash('sha1').update(fileBuffer).digest('hex');
  const encodedName = encodeURIComponent(key).replace(/%2F/g, '/');

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await axios.post(session.uploadUrl, fileBuffer, {
        headers: {
          Authorization: session.uploadAuthToken,
          'X-Bz-File-Name': encodedName,
          'Content-Type': 'image/png',
          'X-Bz-Content-Sha1': sha1
        },
        maxBodyLength: Infinity,
        timeout: 30000
      });
      return `${session.downloadUrl}/file/${session.bucketName}/${encodedName}`;
    } catch (err) {
      const status = err?.response?.status;
      if (status === 401) {
        await refreshUploadUrl();
      }
      if (attempt === maxRetries) throw err;
      const waitMs = 1000 * (2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return null;
}

async function getOrCreateDefaultCategoryId() {
  const db = mongoose.connection.db;
  const categoryCol = db.collection('Category');

  const existing = await categoryCol.findOne({ name: DEFAULT_CATEGORY_NAME });
  if (existing?._id) return existing._id;

  const now = new Date();
  const result = await categoryCol.insertOne({
    name: DEFAULT_CATEGORY_NAME,
    description: 'Auto-created category for brands discovered via onboarding agent',
    createdAt: now,
    updatedAt: now
  });

  return result.insertedId;
}

function buildSiteUrlCandidates(domain = '') {
  if (!domain) return [];
  const normalized = normalizeDomain(domain);
  const registrable = getRegistrableDomain(normalized) || normalized;
  const candidates = new Set([
    `https://${normalized}`,
    `http://${normalized}`,
    `https://${registrable}`,
    `http://${registrable}`
  ]);
  return Array.from(candidates);
}

async function resolveOrCreateUrkBrand({ message, agentBrand }) {
  const db = mongoose.connection.db;
  const urkBrandCol = db.collection('Brand');
  const senderEmail = String(message.fromEmail || '').toLowerCase().trim();
  const senderDomain = extractDomainFromEmail(senderEmail);
  const registrable = getRegistrableDomain(senderDomain) || senderDomain;
  const siteURL = registrable ? `https://${registrable}` : null;
  const baseSlug = slugifyText((registrable || '').split('.')[0] || agentBrand?.name || 'brand') || 'brand';

  const candidate = await urkBrandCol.findOne({
    $or: [
      senderEmail ? { email: senderEmail } : null,
      siteURL ? { siteURL: { $in: buildSiteUrlCandidates(registrable) } } : null,
      { slug: baseSlug }
    ].filter(Boolean)
  });
  if (candidate?._id) return candidate._id;

  const categoryId = await getOrCreateDefaultCategoryId();
  const brandName = agentBrand?.name || formatBrandNameFromDomain(registrable || senderDomain);
  const now = new Date();

  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
    const doc = {
      name: brandName,
      email: senderEmail || `${slug}@${registrable || 'example.com'}`,
      slug,
      category_id: categoryId,
      siteURL: siteURL || undefined,
      createdAt: now,
      updatedAt: now
    };
    try {
      const result = await urkBrandCol.insertOne(doc);
      return result.insertedId;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const existing = await urkBrandCol.findOne({
        $or: [
          senderEmail ? { email: senderEmail } : null,
          siteURL ? { siteURL: { $in: buildSiteUrlCandidates(registrable) } } : null,
          { slug }
        ].filter(Boolean)
      });
      if (existing?._id) return existing._id;
    }
  }

  throw new Error(`Unable to resolve/create urk Brand for sender: ${senderEmail}`);
}

async function upsertUrkListing({ message, agentBrand, screenshotUrl }) {
  const db = mongoose.connection.db;
  const listingCol = db.collection('Listing');
  const urkBrandId = await resolveOrCreateUrkBrand({ message, agentBrand });
  const userIdRaw = process.env.URKLIST_USER_ID;

  if (!mongoose.Types.ObjectId.isValid(userIdRaw)) {
    throw new Error('URKLIST_USER_ID missing or invalid');
  }

  const title = scrubSensitiveContent(message.subject || '(no subject)');
  const htmlContent = scrubSensitiveContent(message.bodyHtml || '') || null;
  const bodyText = scrubSensitiveContent(message.bodyText || message.textBody || message.snippet || '');
  const nextPromoCodes = extractPromoCodes(title, `${htmlContent || ''}\n${bodyText}`);
  const nextDiscountText = extractDiscountText(title);
  const now = new Date();
  const existing = await listingCol.findOne({ messageId: message.gmailMessageId });

  // Non-destructive merge: keep existing persisted values if new run does not provide them.
  const mergedPromoCodes = Array.from(new Set([...(existing?.promoCodes || []), ...nextPromoCodes])).slice(0, 25);
  const mergedContent = screenshotUrl || existing?.content || '';
  const mergedHtmlContent = htmlContent || existing?.htmlContent || null;
  const mergedDiscountText = nextDiscountText || existing?.discountText || null;

  await listingCol.updateOne(
    { messageId: message.gmailMessageId },
    {
      $set: {
        title,
        slugifyTitle: slugifyText(title) || null,
        brandEmail: message.fromEmail || '',
        receivedAt: message.receivedAt || now,
        messageId: message.gmailMessageId,
        content: mergedContent,
        htmlContent: mergedHtmlContent,
        promoCodes: mergedPromoCodes,
        discountText: mergedDiscountText,
        ingestionSource: 'brand-onboarding-agent',
        pipelineVersion: 'boa-v2',
        sourceEmailMessageId: message.gmailMessageId,
        sourceRfc822MessageId: message.rfc822MessageId || null,
        sourceThreadId: message.threadId || null,
        sourceFromDomain: message.fromDomain || null,
        sourceSenderApexDomain: message.senderApexDomain || null,
        sourceEmailType: message.emailType || 'unknown',
        lastIngestedAt: now,
        brandId: urkBrandId,
        userId: new mongoose.Types.ObjectId(userIdRaw),
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );
}

async function materializeListingForMessage({ message, brand, withScreenshots = true, forceScreenshotRetake = false, context = 'ingest_newsletters' }) {
  let screenshotPath = null;
  let screenshotUrl = null;

  // Reuse existing URL if already uploaded (unless force retake requested).
  if (!forceScreenshotRetake) {
    const existingPath = String(message.screenshotPath || '');
    if (/^https?:\/\//i.test(existingPath)) {
      screenshotUrl = existingPath;
    }
  }

  // Safety: never persist ephemeral local file paths into Listing.content.
  // If B2 is not configured, skip screenshot generation in automated runs.
  const b2Enabled = canUseB2();
  if (withScreenshots && !screenshotUrl && b2Enabled) {
    try {
      screenshotPath = await screenshotEmailMessage(message);
      if (screenshotPath) {
        const fileName = `${slugifyText(message.subject || 'newsletter') || 'newsletter'}-${message.gmailMessageId}.png`;
        screenshotUrl = await uploadScreenshotToB2(screenshotPath, fileName);
        if (screenshotUrl) {
          await markEmailActivity({
            gmailMessageId: message.gmailMessageId,
            activity: 'screenshot_captured',
            emailMessage: message
          });
        }
      }
    } catch (screenshotErr) {
      logger.warn(`[${context}] screenshot/upload skipped for ${message.gmailMessageId}: ${screenshotErr.message}`);
    }
  } else if (withScreenshots && !b2Enabled) {
    logger.warn(`[${context}] B2 not configured; skipping screenshot generation for ${message.gmailMessageId}`);
  }

  await upsertUrkListing({ message, agentBrand: brand, screenshotUrl });

  if (screenshotPath && fs.existsSync(screenshotPath)) {
    fs.unlinkSync(screenshotPath);
  }

  return {
    screenshotUrl: screenshotUrl || null
  };
}

async function markMessageIngestResult({ message, success, error = null, version = 'v2' }) {
  message.processedBy = message.processedBy || {};
  message.processedBy.ingestion_runner = {
    done: success,
    at: new Date(),
    version,
    attempts: (message.processedBy?.ingestion_runner?.attempts || 0) + 1,
    status: success ? 'done' : 'error',
    lastProcessedAt: new Date(),
    error
  };
  if (success) {
    message.ingestedAt = new Date();
    message.state = 'finalized';
    message.needsReview = false;
    message.processingTrace = {
      ...(message.processingTrace || {}),
      listing_upsert: {
        at: new Date(),
        status: 'done'
      },
      ingest: {
        at: new Date(),
        status: 'done'
      }
    };
  } else {
    message.state = 'error';
    message.needsReview = true;
    message.processingTrace = {
      ...(message.processingTrace || {}),
      ingest: {
        at: new Date(),
        status: 'error',
        error
      }
    };
  }
}

async function ingestPendingNewsletters({ limit = 50 } = {}) {
  const candidates = await EmailMessage.find({
    emailType: { $in: ['newsletter', 'welcome'] },
    $or: [
      { ingestedAt: { $exists: false } },
      { ingestedAt: null }
    ],
    state: { $nin: ['ingested', 'finalized'] },
    'processedBy.ingestion_runner.done': { $ne: true }
  }).sort({ receivedAt: -1 }).limit(limit);

  const stats = {
    scanned: candidates.length,
    ingested: 0,
    failed: 0,
    skipped: 0
  };

  for (const message of candidates) {
    message.processedBy = message.processedBy || {};
    if (!message.brandId) {
      message.processedBy.ingestion_runner = {
        done: false,
        at: new Date(),
        version: 'v2',
        attempts: (message.processedBy?.ingestion_runner?.attempts || 0) + 1,
        status: 'skipped',
        lastProcessedAt: new Date(),
        error: 'Missing brandId'
      };
      message.needsReview = true;
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'ingestion_skipped',
        emailMessage: message
      });
      stats.skipped += 1;
      continue;
    }

    const brand = await Brand.findById(message.brandId);
    if (!brand) {
      message.processedBy.ingestion_runner = {
        done: false,
        at: new Date(),
        version: 'v2',
        attempts: (message.processedBy?.ingestion_runner?.attempts || 0) + 1,
        status: 'error',
        lastProcessedAt: new Date(),
        error: 'Brand not found'
      };
      message.needsReview = true;
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'error',
        emailMessage: message
      });
      stats.failed += 1;
      continue;
    }

    try {
      const materialized = await materializeListingForMessage({
        message,
        brand,
        withScreenshots: true,
        context: 'ingest_newsletters'
      });
      message.screenshotPath = materialized.screenshotUrl;
      await markMessageIngestResult({ message, success: true, version: 'v2' });
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'ingested',
        emailMessage: message
      });

      if (message.emailType === 'newsletter') {
        if (!brand.firstNewsletterAt) brand.firstNewsletterAt = message.receivedAt || new Date();
        brand.lastNewsletterAt = message.receivedAt || new Date();
      }
      await brand.save();

      stats.ingested += 1;
    } catch (err) {
      logger.warn(`[ingest_newsletters] ${message.gmailMessageId}: ${err.message}`);
      await markMessageIngestResult({ message, success: false, error: err.message, version: 'v2' });
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'error',
        emailMessage: message
      });
      stats.failed += 1;
    }
  }

  logger.info(`[ingest_newsletters] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

async function backfillListingsFromEmailMessages({
  limit = 500,
  withScreenshots = false,
  forceUpdate = false,
  missingScreenshotOnly = false,
  forceScreenshotRetake = false
} = {}) {
  const db = mongoose.connection.db;
  const listingCol = db.collection('Listing');

  const candidates = await EmailMessage.find({
    emailType: { $in: ['newsletter', 'welcome'] },
    brandId: { $exists: true, $ne: null },
    gmailMessageId: { $exists: true, $ne: null }
  }).sort({ receivedAt: 1 }).limit(limit);

  const stats = {
    scanned: candidates.length,
    backfilled: 0,
    screenshotUploaded: 0,
    screenshotMissing: 0,
    alreadyPresent: 0,
    skippedHasScreenshot: 0,
    skippedNoBrand: 0,
    failed: 0
  };

  for (const message of candidates) {
    try {
      const existing = await listingCol.findOne(
        { messageId: message.gmailMessageId },
        { projection: { _id: 1, content: 1 } }
      );

      if (missingScreenshotOnly) {
        const hasListingScreenshot = /^https?:\/\//i.test(String(existing?.content || ''));
        // In missing-screenshot mode, only skip when Listing already has a screenshot URL.
        // If message has screenshotPath URL but Listing.content is empty, we should still
        // materialize to copy that URL onto the listing row.
        if (hasListingScreenshot) {
          stats.skippedHasScreenshot += 1;
          continue;
        }
      }

      const allowUpdatingExistingForMissingScreenshot = missingScreenshotOnly && existing;
      if (existing && !forceUpdate && !allowUpdatingExistingForMissingScreenshot) {
        stats.alreadyPresent += 1;
        continue;
      }

      const brand = await Brand.findById(message.brandId);
      if (!brand) {
        stats.skippedNoBrand += 1;
        continue;
      }

      const materialized = await materializeListingForMessage({
        message,
        brand,
        withScreenshots,
        forceScreenshotRetake,
        context: 'backfill_listings'
      });
      if (materialized?.screenshotUrl) stats.screenshotUploaded += 1;
      else if (withScreenshots) stats.screenshotMissing += 1;
      message.screenshotPath = materialized.screenshotUrl || message.screenshotPath || null;
      await markMessageIngestResult({ message, success: true, version: 'v2' });
      await message.save();
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'ingested',
        emailMessage: message
      });

      if (message.emailType === 'newsletter') {
        if (!brand.firstNewsletterAt) brand.firstNewsletterAt = message.receivedAt || new Date();
        brand.lastNewsletterAt = message.receivedAt || new Date();
        await brand.save();
      }

      stats.backfilled += 1;
    } catch (err) {
      logger.warn(`[backfill_listings] ${message.gmailMessageId}: ${err.message}`);
      await markEmailActivity({
        gmailMessageId: message.gmailMessageId,
        activity: 'error',
        emailMessage: message
      });
      stats.failed += 1;
    }
  }

  logger.info(`[backfill_listings] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

/**
 * Re-take screenshots for existing Listing records using correct 600px viewport.
 * Works by iterating directly over the Listing collection (not EmailMessage),
 * finding the HTML content either from the Listing.htmlContent field or from
 * the linked EmailMessage.bodyHtml, then re-rendering and uploading to B2.
 */
async function retakeListingScreenshots({
  limit = 100,
  dryRun = false,
  skipAlreadyRetaken = true
} = {}) {
  const db = mongoose.connection.db;
  const listingCol = db.collection('Listing');

  // Find listings that have a screenshot URL in content
  // AND have either htmlContent on the listing or a linked messageId
  const query = {
    content: { $regex: '^https?://', $options: 'i' }
  };

  if (skipAlreadyRetaken) {
    query.screenshotRetakenAt = { $exists: false };
  }

  const listings = await listingCol.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  const stats = {
    scanned: listings.length,
    retaken: 0,
    skippedNoHtml: 0,
    skippedB2Disabled: 0,
    failed: 0
  };

  const b2Enabled = canUseB2();
  if (!b2Enabled) {
    logger.warn('[retake_screenshots] B2 not configured; aborting.');
    stats.skippedB2Disabled = stats.scanned;
    return stats;
  }

  // Launch a single shared browser for all retakes
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || undefined;
  let sharedBrowser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  logger.info('[retake_screenshots] Shared browser launched successfully');

  try {
  for (const listing of listings) {
    try {
      // Get HTML: prefer listing.htmlContent, fallback to linked EmailMessage.bodyHtml
      let html = listing.htmlContent || null;

      if (!html && listing.messageId) {
        const email = await EmailMessage.findOne({ gmailMessageId: listing.messageId });
        html = email?.bodyHtml || null;
      }

      if (!html) {
        stats.skippedNoHtml += 1;
        continue;
      }

      if (dryRun) {
        stats.retaken += 1;
        continue;
      }

      // Build a minimal message object for screenshotEmailMessage
      const pseudoMessage = {
        bodyHtml: html,
        gmailMessageId: listing.messageId || String(listing._id)
      };

      const screenshotPath = await screenshotEmailMessage(pseudoMessage, { sharedBrowser });
      if (!screenshotPath) {
        stats.skippedNoHtml += 1;
        continue;
      }

      // Upload to B2
      const safeTitle = slugifyText(listing.title || 'newsletter') || 'newsletter';
      const fileName = safeTitle + '-' + pseudoMessage.gmailMessageId + '-retake.png';
      const screenshotUrl = await uploadScreenshotToB2(screenshotPath, fileName);

      // Update Listing.content with new screenshot URL
      await listingCol.updateOne(
        { _id: listing._id },
        { $set: { content: screenshotUrl, screenshotRetakenAt: new Date() } }
      );

      // Also update linked EmailMessage if it exists
      if (listing.messageId) {
        await EmailMessage.updateOne(
          { gmailMessageId: listing.messageId },
          { $set: { screenshotPath: screenshotUrl } }
        );
      }

      // Clean up temp file
      if (screenshotPath && fs.existsSync(screenshotPath)) {
        fs.unlinkSync(screenshotPath);
      }

      stats.retaken += 1;
      if (stats.retaken % 10 === 0) {
        logger.info('[retake_screenshots] Progress: ' + JSON.stringify(stats));
        // Recycle browser every 10 successful screenshots to prevent memory buildup
        try {
          await sharedBrowser.close().catch(() => {});
          sharedBrowser = await chromium.launch({
            headless: true,
            executablePath,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
          });
          logger.info('[retake_screenshots] Browser recycled after ' + stats.retaken + ' screenshots');
        } catch (recycleErr) {
          logger.warn('[retake_screenshots] Browser recycle failed: ' + recycleErr.message);
        }
      }
    } catch (err) {
      logger.warn('[retake_screenshots] ' + (listing._id) + ': ' + err.message);
      stats.failed += 1;
    }
  }

  } finally {
    await sharedBrowser.close().catch(() => {});
    logger.info('[retake_screenshots] Shared browser closed');
  }

  logger.info('[retake_screenshots] Completed: ' + JSON.stringify(stats));
  return stats;
}


module.exports = {
  ingestPendingNewsletters,
  backfillListingsFromEmailMessages,
  retakeListingScreenshots
};
