/**
 * Brand Onboarding Agent - Main Orchestrator
 * Now accepts onProgress callback for live web streaming.
 */
const Brand = require('../models/Brand');
const { discoverBrands } = require('../services/brandDiscovery');
const { signUpForNewsletter } = require('../services/newsletterSignup');
const { categorizeBrand } = require('../services/brandCategorizer');
const { filterDuplicates } = require('../services/duplicateChecker');
const { scanRecentEmails, detectStaleBrands } = require('../services/emailChangeDetector');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SIGNUP_DELAY = parseInt(process.env.SIGNUP_DELAY_MS || '4000');

// -- Programmatic entry point -----------------------------------
async function run({ batchSize = 10, mode = 'full', onProgress = () => {}, getStopFlag = () => false } = {}) {
  const emit = (level, phase, message, extra = {}) => {
    onProgress({ level, phase, message, ...extra });
    logger.info(`[${phase}] ${message}`);
  };
  switch (mode) {
    case 'full':
    case 'discover_and_signup':
      return runFullOnboarding(batchSize, emit, getStopFlag);
    case 'discover':    return runDiscoveryOnly(batchSize, emit);
    case 'scan_emails': return runEmailScan(emit);
    case 'stale_check': return runStaleCheck(emit);
    default:            return runFullOnboarding(batchSize, emit, getStopFlag);
  }
}

// -- Full pipeline ----------------------------------------------
async function runFullOnboarding(batchSize, emit, getStopFlag) {
  const startTime = Date.now();
  const stats = { discovered: 0, duplicatesSkipped: 0, signupSuccess: 0, signupFailed: 0, confirmed: 0, categorized: 0 };

  emit('info', 'discovery', ` Phase 1: Discovering brands (target: ${batchSize})...`);
  const existingBrands  = await Brand.find({}, 'domain').lean();
  const existingDomains = new Set(existingBrands.map(b => b.domain.toLowerCase()));
  const discovered = await discoverBrands(batchSize, existingDomains);
  stats.discovered = discovered.length;
  emit('info', 'discovery', ` Scraped ${discovered.length} candidates from sources`);

  const { unique, duplicates } = await filterDuplicates(discovered);
  stats.duplicatesSkipped = duplicates.length;
  emit('success', 'discovery', `[OK] ${unique.length} unique brands ready (${duplicates.length} duplicates skipped)`);
  const toOnboard = unique;
  emit('info', 'categorization', ` Phase 2: AI categorizing ${toOnboard.length} brands...`);
  const categorizationResults = new Map();
  for (const brand of toOnboard) {
    if (getStopFlag()) { emit('warn', 'stop', ' Stopped by user'); return stats; }
    const result = await categorizeBrand(brand);
    if (result.success) {
      categorizationResults.set(brand.domain, result.data);
      stats.categorized++;
      emit('info', 'categorization', `    ${brand.name} -> ${result.data.primaryCategory || 'uncategorized'}`);
    }
    await sleep(300);
  }
  emit('success', 'categorization', `[OK] Categorized ${stats.categorized} brands`);
  emit('info', 'signup', ` Phase 3: Signing up for ${toOnboard.length} newsletters...`);
  for (let i = 0; i < toOnboard.length; i++) {
    if (getStopFlag()) { emit('warn', 'stop', ' Stopped by user'); break; }
    const brand   = toOnboard[i];
    const catData = categorizationResults.get(brand.domain) || {};
    emit('info', 'signup', `[${i + 1}/${toOnboard.length}]  ${brand.name} (${brand.domain})`);
    let brandDoc = await Brand.findOne({ domain: brand.domain });
    if (!brandDoc) {
      brandDoc = new Brand({
        name: brand.name, domain: brand.domain, websiteUrl: brand.websiteUrl,
        source: brand.source || 'curated_seed', sourceUrl: brand.sourceUrl,
        description: catData.description || brand.description,
        primaryCategory: catData.primaryCategory, categories: catData.categories || [],
        tags: catData.tags || [], lifestyleTags: catData.lifestyleTags || [],
        targetDemographic: catData.targetDemographic || [], productTypes: catData.productTypes || [],
        priceRange: catData.priceRange, brandTier: catData.brandTier,
        audienceSize: catData.audienceSize, genderFocus: catData.genderFocus,
        businessModel: catData.businessModel,
        qualityScore: catData.qualityScore, affiliatePotentialScore: catData.affiliatePotentialScore,
        affiliateNetworks: catData.affiliateNetworks || [], hasAffiliateProgram: catData.hasAffiliateProgram || false,
        estimatedRevShare: catData.estimatedRevShare,
        milledFrequency: brand.milledFrequency, milledIndustrialTags: brand.milledIndustrialTags || [],
        onboardingStatus: 'subscribing',
        statusHistory: [{ status: 'discovered', note: 'Agent' }, { status: 'subscribing', note: 'Starting signup' }]
      });
    } else {
      brandDoc.onboardingStatus = 'subscribing';
    }
    await brandDoc.save();
    const signupResult = await signUpForNewsletter(brand.websiteUrl, brand.name);
    brandDoc.signupAttempts      = (brandDoc.signupAttempts || 0) + 1;
    brandDoc.lastSignupAttempt   = new Date();
    brandDoc.signupAttemptLog    = brandDoc.signupAttemptLog || [];
    brandDoc.signupAttemptLog.push({
      attemptedAt: new Date(), formUrl: signupResult.formUrl || brand.websiteUrl,
      espDetected: signupResult.espProvider, strategy: signupResult.strategy,
      outcome: signupResult.success ? 'success' : 'failed', errorMessage: signupResult.error
    });
    if (signupResult.espProvider && signupResult.espProvider !== 'unknown') brandDoc.espProvider = signupResult.espProvider;
    if (signupResult.formUrl) brandDoc.signupFormUrl = signupResult.formUrl;
    if (!signupResult.success) {
      stats.signupFailed++;
      const reason = signupResult.error || 'Unknown';
      const status = reason.toLowerCase().includes('captcha') ? 'captcha_blocked' : 'failed';
      brandDoc.signupError = reason;
      await brandDoc.updateStatus(status, `Signup failed: ${reason}`);
      emit('warn', 'signup', `  [ERR] ${brand.name}: ${reason}`);
      await sleep(SIGNUP_DELAY);
      continue;
    }
    stats.signupSuccess++;
    emit('success', 'signup', `  [OK] ${brand.name}: submitted (${signupResult.strategy})`);
    await brandDoc.updateStatus('awaiting_confirmation', 'Waiting for async inbox worker');

    emit('info', 'confirmation', `  [...] ${brand.name}: queued for async confirmation processing`);
    if (i < toOnboard.length - 1) await sleep(SIGNUP_DELAY + Math.floor(Math.random() * 2000));
  }
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  emit('success', 'summary',
    ` Finished in ${duration}min - [OK] ${stats.signupSuccess} signups, [OK] ${stats.confirmed} confirmed, [ERR] ${stats.signupFailed} failed`,
    { stats }
  );
  return stats;
}

async function runDiscoveryOnly(batchSize, emit) {
  emit('info', 'discovery', ` Discovery only - ${batchSize} brands`);
  const existingDomains = new Set((await Brand.find({}, 'domain').lean()).map(b => b.domain));
  const brands = await discoverBrands(batchSize, existingDomains);
  const { unique } = await filterDuplicates(brands);
  unique.forEach((b, i) => emit('info', 'discovery', `  ${i + 1}. ${b.name} - ${b.domain}`));
  emit('success', 'discovery', `[OK] ${unique.length} unique brands found`);
  return unique;
}

async function runEmailScan(emit) {
  emit('info', 'email_scan', ' Scanning last 24h of emails...');
  const result = await scanRecentEmails(24);
  emit('success', 'email_scan', `[OK] ${result.processed} brand emails, ${result.senderChanges} sender changes`);
  return result;
}

async function runStaleCheck(emit) {
  emit('info', 'stale_check', '  Checking for stale brands (no emails in 60d)...');
  const count = await detectStaleBrands(60);
  emit('success', 'stale_check', `[OK] Marked ${count} brands as stale`);
  return { staleCount: count };
}

module.exports = { run };
