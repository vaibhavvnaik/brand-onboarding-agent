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
const {
  normalizeDomain,
  getRegistrableDomain,
  domainsRelated,
  extractDomainFromUrl
} = require('../utils/domainIdentity');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMeaningfulLinkDomains(links = []) {
  const ignored = new Set([
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
    'youtube.com', 'tiktok.com', 'pinterest.com',
    'shopify.com', 'myshopify.com', 'shopifycdn.com',
    'mailchimp.com', 'klaviyomail.com', 'sendgrid.net', 'mandrillapp.com',
    'google.com', 'googleusercontent.com', 'doubleclick.net'
  ]);
  const domains = new Set();
  for (const link of links || []) {
    const d = extractDomainFromUrl(link);
    if (!d) continue;
    const reg = getRegistrableDomain(d);
    if (!reg || ignored.has(reg)) continue;
    domains.add(d);
    domains.add(reg);
  }
  return Array.from(domains);
}

function inferNewsletterLikeType(parsed, detectedType, brand) {
  const currentType = String(detectedType || 'unknown');
  if (['newsletter', 'welcome', 'confirmation', 'transactional'].includes(currentType)) return currentType;

  const onboardingStatus = String(brand?.onboardingStatus || '');
  const shouldAttemptInference = ['awaiting_confirmation', 'subscribing', 'submitted', 'discovered', 'failed', 'captcha_blocked'].includes(onboardingStatus);
  if (!shouldAttemptInference) return currentType;

  const subject = String(parsed?.subject || '').toLowerCase();
  const body = String(parsed?.bodyText || parsed?.bodyHtml || '').toLowerCase().slice(0, 4000);
  const links = Array.isArray(parsed?.links) ? parsed.links : [];
  const combined = `${subject} ${body}`;

  const strongNewsletterSignals = [
    'unsubscribe',
    'manage preferences',
    'email preferences',
    'view in browser',
    'why did i get this email',
    'you received this email',
    'update your preferences'
  ];
  const mediumSignals = [
    'new arrivals',
    'just dropped',
    'shop now',
    'shop the',
    'read more',
    'latest',
    'collection',
    'lookbook',
    'this week'
  ];

  const hasStrongSignal = strongNewsletterSignals.some((signal) => combined.includes(signal));
  const mediumSignalHits = mediumSignals.filter((signal) => combined.includes(signal)).length;
  const meaningfulLinkCount = links.filter((url) => /^https?:\/\//i.test(String(url))).length;

  if (hasStrongSignal && meaningfulLinkCount >= 1) return 'newsletter';
  if (mediumSignalHits >= 2 && meaningfulLinkCount >= 2) return 'newsletter';
  if (meaningfulLinkCount >= 5 && combined.includes('unsubscribe')) return 'newsletter';
  return currentType;
}

function normalizeNameForMatch(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildEmailReferenceText(parsed) {
  return [
    parsed?.subject || '',
    parsed?.snippet || '',
    parsed?.bodyText || '',
    parsed?.bodyHtml || ''
  ].join(' ').toLowerCase().slice(0, 8000);
}

async function resolveBrandByContentReference(parsed, senderDomain, emailType) {
  const text = buildEmailReferenceText(parsed);
  if (!text) return null;

  const pendingStatuses = ['failed', 'captcha_blocked', 'awaiting_confirmation', 'subscribing', 'submitted', 'discovered'];
  const domainMatches = new Set();
  const domainRegex = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/gi;
  let match;
  while ((match = domainRegex.exec(text)) !== null) {
    const rawDomain = normalizeDomain(match[1]);
    const root = getRegistrableDomain(rawDomain);
    if (root) domainMatches.add(root);
  }

  const linkDomains = extractMeaningfulLinkDomains(parsed?.links || []);
  for (const domain of linkDomains) domainMatches.add(getRegistrableDomain(domain));
  if (senderDomain) domainMatches.add(getRegistrableDomain(senderDomain));

  const candidateDomains = Array.from(domainMatches).filter(Boolean);
  if (candidateDomains.length) {
    const byDomain = await Brand.findOne({
      onboardingStatus: { $in: pendingStatuses },
      domain: { $in: candidateDomains }
    }).sort({ updatedAt: -1 });
    if (byDomain) {
      return { brand: byDomain, source: 'content_domain_match', confidence: 9 };
    }
  }

  if (!['welcome', 'newsletter'].includes(String(emailType || ''))) return null;

  const phrasePatterns = [
    /welcome to\s+([a-z0-9&' -]{2,40})/i,
    /thanks for (?:joining|subscribing(?: to)?|signing up(?: for)?)\s+([a-z0-9&' -]{2,40})/i,
    /you(?:'re| are) (?:now )?subscribed to\s+([a-z0-9&' -]{2,40})/i
  ];

  const phrases = new Set();
  for (const pattern of phrasePatterns) {
    const found = text.match(pattern);
    if (found && found[1]) phrases.add(normalizeNameForMatch(found[1]));
  }
  if (!phrases.size) return null;

  const candidates = await Brand.find({
    onboardingStatus: { $in: pendingStatuses }
  }).select('name domain onboardingStatus').limit(600);

  let best = null;
  let bestScore = 0;
  for (const brand of candidates) {
    const brandName = normalizeNameForMatch(brand.name);
    if (!brandName) continue;
    let score = 0;
    for (const phrase of phrases) {
      if (!phrase) continue;
      if (phrase === brandName) score += 8;
      else if (brandName.includes(phrase) || phrase.includes(brandName)) score += 5;
    }
    if (senderDomain && domainsRelated(senderDomain, brand.domain)) score += 4;
    if (text.includes(brandName)) score += 2;
    if (score > bestScore) {
      best = brand;
      bestScore = score;
    }
  }

  if (best && bestScore >= 8) {
    return { brand: best, source: 'content_brand_phrase', confidence: bestScore };
  }
  return null;
}

async function resolveBrand(senderEmail, senderDomain, links = []) {
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
    const apex = getRegistrableDomain(cleanDomain);
    const byExactDomain = await Brand.findOne({
      domain: { $regex: new RegExp(`^${escapeRegex(cleanDomain)}$`, 'i') }
    });
    if (byExactDomain) return byExactDomain;

    const byApexDomain = await Brand.findOne({
      domain: { $regex: new RegExp(`^${escapeRegex(apex)}$`, 'i') }
    });
    if (byApexDomain) return byApexDomain;

    const byKnownSenderDomain = await Brand.findOne({
      knownSenderDomains: { $regex: new RegExp(`^${escapeRegex(cleanDomain)}$`, 'i') }
    });
    if (byKnownSenderDomain) return byKnownSenderDomain;

    const byKnownSenderApex = await Brand.findOne({
      knownSenderDomains: { $regex: new RegExp(`^${escapeRegex(apex)}$`, 'i') }
    });
    if (byKnownSenderApex) return byKnownSenderApex;
  }

  const linkDomains = extractMeaningfulLinkDomains(links);
  if (linkDomains.length) {
    const roots = Array.from(new Set(linkDomains.map((domain) => getRegistrableDomain(domain)).filter(Boolean)));
    if (roots.length) {
      const byLinkRoots = await Brand.find({ domain: { $in: roots } }).limit(3);
      if (byLinkRoots.length === 1) return byLinkRoots[0];

      if (byLinkRoots.length > 1 && senderDomain) {
        const senderRoot = getRegistrableDomain(senderDomain);
        const related = byLinkRoots.find((brand) => domainsRelated(senderRoot, brand.domain));
        if (related) return related;
      }
    }
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

  let brand = await resolveBrand(senderEmail, senderDomain, parsed.links || []);
  let matchSource = 'direct';
  let matchConfidence = 10;
  if (!brand) {
    const inferred = await resolveBrandByContentReference(parsed, senderDomain, emailType);
    if (inferred?.brand) {
      brand = inferred.brand;
      matchSource = inferred.source || 'content_reference';
      matchConfidence = inferred.confidence || 0;
      logger.info(`[scan_inbox] Content-based brand match: "${parsed.subject || ''}" -> ${brand.name} (${matchSource}, confidence=${matchConfidence})`);
    }
  }

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

  const effectiveEmailType = inferNewsletterLikeType(parsed, emailType, brand);
  if (effectiveEmailType !== emailType) {
    emailMessage.emailType = effectiveEmailType;
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
  if (effectiveEmailType === 'newsletter' &&
      senderEmail &&
      (!brand.currentSenderEmail || brand.currentSenderEmail.toLowerCase() !== senderEmail.toLowerCase())) {
    await brand.recordSenderChange(senderEmail);
  } else if (senderDomain) {
    const senderDomainSet = new Set((brand.knownSenderDomains || []).map((domain) => String(domain).toLowerCase()));
    senderDomainSet.add(senderDomain.toLowerCase());
    senderDomainSet.add(getRegistrableDomain(senderDomain));
    brand.knownSenderDomains = Array.from(senderDomainSet).filter(Boolean);
    brand.currentSenderDomain = brand.currentSenderDomain || senderDomain.toLowerCase();
    brand.primarySenderDomain = brand.primarySenderDomain || senderDomain.toLowerCase();
  }

  brand.lastHealthCheckAt = new Date();
  brand.lastSeenEmailAt = emailMessage.receivedAt || new Date();
  brand.isStale = false;
  brand.totalEmailsReceived = (brand.totalEmailsReceived || 0) + 1;

  if (effectiveEmailType === 'welcome') {
    brand.welcomeEmailReceived = true;
    brand.welcomeEmailReceivedAt = emailMessage.receivedAt;
    brand.welcomeEmailMessageId = messageId;
    brand.confirmationRequired = false;
    const welcomeSet = new Set((brand.welcomeSenderEmails || []).map((email) => String(email).toLowerCase()));
    if (senderEmail) welcomeSet.add(senderEmail.toLowerCase());
    brand.welcomeSenderEmails = Array.from(welcomeSet);
    const trustedByDomain = !!(senderDomain && domainsRelated(senderDomain, brand.domain));
    const trustedByContent = matchSource !== 'direct' && matchConfidence >= 8;
    const shouldMarkSignedUp = trustedByDomain || trustedByContent;
    if (shouldMarkSignedUp) {
      await brand.updateStatus('active', 'Welcome email trusted as signup proof (manual/cowork normalized)');
    } else if (brand.onboardingStatus === 'awaiting_confirmation') {
      brand.statusHistory.push({
        status: brand.onboardingStatus,
        changedAt: new Date(),
        note: 'Welcome email received; waiting for first recurring newsletter sender'
      });
      await brand.save();
    } else if (['failed', 'captcha_blocked', 'discovered', 'submitted', 'subscribing'].includes(brand.onboardingStatus)) {
      await brand.updateStatus('awaiting_confirmation', 'Welcome email received after manual/cowork signup; re-entered workflow');
    } else {
      await brand.save();
    }
  }

  if (effectiveEmailType === 'confirmation') {
    brand.confirmationRequired = true;
    if (['failed', 'captcha_blocked', 'discovered', 'submitted', 'subscribing'].includes(brand.onboardingStatus)) {
      await brand.updateStatus('awaiting_confirmation', 'Confirmation email detected; queued for confirmation processor');
    } else {
      await brand.save();
    }
  }

  if (effectiveEmailType === 'newsletter') {
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
    if (!['welcome', 'confirmation'].includes(effectiveEmailType)) {
      await brand.save();
    }
  }

  await emailMessage.save();
  return { matched: true, emailType: effectiveEmailType, brandId: String(brand._id) };
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
