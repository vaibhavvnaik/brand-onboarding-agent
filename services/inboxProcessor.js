const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const {
  searchMessages,
  getMessage,
  parseMessage,
  extractSenderEmail,
  extractDomainFromEmail
} = require('../config/gmail');
const { classifyEmailType } = require('./emailConfirmation');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeDomain(domain) {
  return (domain || '').replace(/^www\./i, '').toLowerCase().trim();
}

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getApexDomain(domain) {
  const normalized = normalizeDomain(domain);
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length < 2) return normalized;
  return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

async function resolveBrand(senderEmail, senderDomain) {
  if (!senderEmail && !senderDomain) return null;

  if (senderEmail) {
    const byExactSender = await Brand.findOne({
      currentSenderEmail: { $regex: new RegExp(`^${senderEmail}$`, 'i') }
    });
    if (byExactSender) return byExactSender;

    const byKnownSenders = await Brand.findOne({
      knownSenderEmails: { $regex: new RegExp(`^${senderEmail}$`, 'i') }
    });
    if (byKnownSenders) return byKnownSenders;

    const byHistory = await Brand.findOne({
      'senderEmailHistory.email': { $regex: new RegExp(`^${senderEmail}$`, 'i') }
    });
    if (byHistory) return byHistory;

    const byWelcomeSenders = await Brand.findOne({
      welcomeSenderEmails: { $regex: new RegExp(`^${senderEmail}$`, 'i') }
    });
    if (byWelcomeSenders) return byWelcomeSenders;
  }

  if (senderDomain) {
    const cleanDomain = normalizeDomain(senderDomain);
    const apex = getApexDomain(cleanDomain);
    const byExactDomain = await Brand.findOne({
      domain: { $regex: new RegExp(`^${escapeRegex(cleanDomain)}$`, 'i') }
    });
    if (byExactDomain) return byExactDomain;

    const byApexDomain = await Brand.findOne({
      domain: { $regex: new RegExp(`^${escapeRegex(apex)}$`, 'i') }
    });
    if (byApexDomain) return byApexDomain;
  }

  return null;
}

async function upsertEmailMessage(parsed) {
  const senderEmail = extractSenderEmail(parsed.from);
  const senderDomain = normalizeDomain(extractDomainFromEmail(senderEmail));
  const emailType = classifyEmailType(parsed.subject, parsed.bodyText, parsed.bodyHtml);
  const receivedAt = parsed.internalDate ? new Date(Number(parsed.internalDate)) : new Date();
  const headers = {
    messageId: parsed.messageId || null,
    from: parsed.from || '',
    to: parsed.to || '',
    subject: parsed.subject || '',
    date: parsed.date || ''
  };

  const emailMessage = await EmailMessage.findOneAndUpdate(
    { gmailMessageId: parsed.id },
    {
      $set: {
        threadId: parsed.threadId,
        from: parsed.from,
        fromEmail: senderEmail,
        fromDomain: senderDomain,
        to: parsed.to,
        subject: parsed.subject,
        snippet: parsed.snippet,
        receivedAt,
        textBody: parsed.bodyText,
        htmlBody: parsed.bodyHtml,
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        headers,
        links: parsed.links || [],
        emailType,
        state: 'parsed'
      },
      $setOnInsert: {
        processedBy: {
          identity_resolver: { done: false, status: 'pending', attempts: 0, version: 'v1' },
          confirmation_runner: { done: false, status: 'pending', attempts: 0, version: 'v1' },
          fnl_reader: { done: false, status: 'pending', attempts: 0, version: 'v1' }
        }
      }
    },
    { upsert: true, new: true }
  );

  return { emailMessage, senderEmail, senderDomain, emailType };
}

async function processSingleMessage(messageId) {
  const msg = await getMessage(messageId);
  const parsed = parseMessage(msg);
  const { emailMessage, senderEmail, senderDomain, emailType } = await upsertEmailMessage(parsed);
  emailMessage.state = 'typed';

  const brand = await resolveBrand(senderEmail, senderDomain);
  if (!brand) {
    emailMessage.state = 'brand_unresolved';
    emailMessage.needsReview = true;
    emailMessage.processedBy.identity_resolver = {
      done: false,
      at: new Date(),
      version: 'v1',
      attempts: (emailMessage.processedBy?.identity_resolver?.attempts || 0) + 1,
      status: 'skipped',
      lastProcessedAt: new Date(),
      error: 'No brand match found'
    };
    await emailMessage.save();
    return { matched: false, emailType };
  }

  emailMessage.brandId = brand._id;
  emailMessage.state = 'brand_resolved';
  emailMessage.processedBy.identity_resolver = {
    done: true,
    at: new Date(),
    version: 'v1',
    attempts: (emailMessage.processedBy?.identity_resolver?.attempts || 0) + 1,
    status: 'done',
    lastProcessedAt: new Date(),
    error: null
  };

  // Only newsletter emails define the "true" sender identity for a brand.
  if (emailType === 'newsletter' &&
      senderEmail &&
      (!brand.currentSenderEmail || brand.currentSenderEmail.toLowerCase() !== senderEmail.toLowerCase())) {
    await brand.recordSenderChange(senderEmail);
  }

  brand.lastHealthCheckAt = new Date();
  brand.lastSeenEmailAt = emailMessage.receivedAt || new Date();
  brand.isStale = false;
  brand.totalEmailsReceived = (brand.totalEmailsReceived || 0) + 1;

  if (emailType === 'welcome') {
    brand.welcomeEmailReceived = true;
    brand.welcomeEmailReceivedAt = emailMessage.receivedAt;
    brand.welcomeEmailMessageId = messageId;
    brand.confirmationRequired = false;
    const welcomeSet = new Set((brand.welcomeSenderEmails || []).map((email) => String(email).toLowerCase()));
    if (senderEmail) welcomeSet.add(senderEmail.toLowerCase());
    brand.welcomeSenderEmails = Array.from(welcomeSet);
    if (brand.onboardingStatus === 'awaiting_confirmation') {
      brand.statusHistory.push({
        status: brand.onboardingStatus,
        changedAt: new Date(),
        note: 'Welcome email received; waiting for first recurring newsletter sender'
      });
    } else if (['failed', 'captcha_blocked', 'discovered', 'submitted', 'subscribing'].includes(brand.onboardingStatus)) {
      await brand.updateStatus('awaiting_confirmation', 'Welcome email received after manual/cowork signup; re-entered workflow');
    } else {
      await brand.save();
    }
  }

  if (emailType === 'confirmation') {
    brand.confirmationRequired = true;
    if (['failed', 'captcha_blocked', 'discovered', 'submitted', 'subscribing'].includes(brand.onboardingStatus)) {
      await brand.updateStatus('awaiting_confirmation', 'Confirmation email detected; queued for confirmation processor');
    } else {
      await brand.save();
    }
  }

  if (emailType === 'newsletter') {
    if (!brand.firstNewsletterAt) brand.firstNewsletterAt = emailMessage.receivedAt;
    brand.lastNewsletterAt = emailMessage.receivedAt;
    brand.confirmationRequired = false;

    if (brand.onboardingStatus === 'awaiting_confirmation') {
      if (brand.welcomeEmailReceived) {
        await brand.updateStatus('active', 'Newsletter received after welcome; inferred no separate confirmation required');
      } else {
        await brand.updateStatus('active', 'Direct newsletter received without prior welcome/confirmation; inferred subscription is active');
      }
    } else if (brand.onboardingStatus === 'subscribing' || brand.onboardingStatus === 'submitted' || brand.onboardingStatus === 'discovered' || brand.onboardingStatus === 'failed' || brand.onboardingStatus === 'captcha_blocked') {
      await brand.updateStatus('active', 'Direct newsletter received; activated without explicit confirmation step');
    } else {
      await brand.save();
    }
  } else {
    if (!['welcome', 'confirmation'].includes(emailType)) {
      await brand.save();
    }
  }

  await emailMessage.save();
  return { matched: true, emailType, brandId: String(brand._id) };
}

async function processInbox({ hours = 24, maxResults = 100 } = {}) {
  const since = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
  const query = `to:${process.env.GMAIL_USER} after:${since} in:inbox`;

  logger.info(`[scan_inbox] Querying Gmail: ${query}`);
  const refs = await searchMessages(query, maxResults);

  const stats = {
    fetched: refs.length,
    processed: 0,
    skippedAlreadyFinalized: 0,
    matched: 0,
    unmatched: 0,
    byType: {
      confirmation: 0,
      welcome: 0,
      newsletter: 0,
      transactional: 0,
      other: 0,
      unknown: 0
    }
  };

  for (const ref of refs) {
    try {
      const existing = await EmailMessage.findOne({ gmailMessageId: ref.id })
        .select('processedBy state')
        .lean();
      if (existing?.processedBy?.fnl_reader?.done && existing?.processedBy?.confirmation_runner?.done) {
        stats.skippedAlreadyFinalized += 1;
        continue;
      }
      const result = await processSingleMessage(ref.id);
      stats.processed += 1;
      if (result.matched) stats.matched += 1;
      else stats.unmatched += 1;
      stats.byType[result.emailType] = (stats.byType[result.emailType] || 0) + 1;
      await sleep(120);
    } catch (err) {
      logger.warn(`[scan_inbox] Failed to process message ${ref.id}: ${err.message}`);
    }
  }

  logger.info(`[scan_inbox] Completed: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = {
  processInbox,
  processSingleMessage
};
