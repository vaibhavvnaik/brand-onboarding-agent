/**
 * Brand Discovery Service
 * Sources high-quality D2C brands from milled.com and curated category searches.
 * Scores brands for affiliate potential and quality before returning recommendations.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../utils/logger');

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// -- Milled.com Category Mapping --------------------------------
// Maps our categories to milled.com's search terms
const MILLED_SEARCH_TERMS = [
  { category: 'Fashion & Apparel',        query: 'fashion clothing apparel',  priority: 1 },
  { category: 'Beauty & Skincare',        query: 'beauty skincare cosmetics', priority: 1 },
  { category: 'Health & Wellness',        query: 'health wellness vitamins',  priority: 1 },
  { category: 'Home & Living',            query: 'home decor furniture',      priority: 2 },
  { category: 'Food & Beverage',          query: 'food beverage snacks',      priority: 2 },
  { category: 'Fitness & Sports',         query: 'fitness sports activewear', priority: 1 },
  { category: 'Outdoor & Adventure',      query: 'outdoor adventure camping', priority: 2 },
  { category: 'Tech & Gadgets',           query: 'tech gadgets electronics',  priority: 2 },
  { category: 'Sustainable & Eco',        query: 'sustainable eco organic',   priority: 1 },
  { category: 'Baby & Kids',              query: 'baby kids children',        priority: 3 },
  { category: 'Pets',                     query: 'pet dog cat animals',       priority: 3 },
  { category: 'Travel & Luggage',         query: 'travel luggage bags',       priority: 3 },
  { category: 'Jewelry & Watches',        query: 'jewelry watches accessories',priority: 2 },
  { category: 'Personal Care & Grooming', query: 'grooming personal care men',priority: 2 },
  { category: 'Gifts & Novelty',          query: 'gifts novelty unique',      priority: 3 },
];

// -- Quality Scoring Heuristics ---------------------------------
const HIGH_VALUE_KEYWORDS = [
  'premium', 'luxury', 'sustainable', 'organic', 'handmade', 'artisan',
  'direct', 'brand', 'shop', 'store', 'collection', 'co', 'studio',
  'lab', 'supply', 'goods', 'craft', 'design', 'wear', 'living'
];

const LOW_VALUE_INDICATORS = [
  'aliexpress', 'dhgate', 'alibaba', 'wish', 'teemu', 'shein', 'fashion nova',
  'wholesale', 'dropship', 'cheap', 'discount', 'coupon', 'deal', 'outlet'
];

// Known high-quality D2C brands to seed the pipeline
const SEED_BRANDS = [
  // Fashion & Apparel
  { name: 'Allbirds',       domain: 'allbirds.com',       category: 'Fashion & Apparel',    tier: 'premium' },
  { name: 'Everlane',       domain: 'everlane.com',       category: 'Fashion & Apparel',    tier: 'premium' },
  { name: 'Reformation',    domain: 'thereformation.com', category: 'Sustainable & Eco',    tier: 'premium' },
  { name: 'Patagonia',      domain: 'patagonia.com',      category: 'Outdoor & Adventure',  tier: 'established' },
  { name: 'Vuori',          domain: 'vuoriclothing.com',  category: 'Fitness & Sports',     tier: 'premium' },
  { name: 'Cotopaxi',       domain: 'cotopaxi.com',       category: 'Outdoor & Adventure',  tier: 'emerging' },
  { name: 'Buck Mason',     domain: 'buckmason.com',      category: 'Fashion & Apparel',    tier: 'premium' },
  { name: 'Quince',         domain: 'quince.com',         category: 'Fashion & Apparel',    tier: 'established' },
  // Beauty & Skincare
  { name: 'Glossier',       domain: 'glossier.com',       category: 'Beauty & Skincare',    tier: 'established' },
  { name: 'ILIA Beauty',    domain: 'iliabeauty.com',     category: 'Beauty & Skincare',    tier: 'premium' },
  { name: 'Tatcha',         domain: 'tatcha.com',         category: 'Beauty & Skincare',    tier: 'luxury' },
  { name: 'Tower 28',       domain: 'tower28beauty.com',  category: 'Beauty & Skincare',    tier: 'emerging' },
  { name: 'Drunk Elephant', domain: 'drunkelephant.com',  category: 'Beauty & Skincare',    tier: 'premium' },
  { name: 'Necessaire',     domain: 'necessaire.com',     category: 'Personal Care & Grooming', tier: 'premium' },
  { name: 'Olaplex',        domain: 'olaplex.com',        category: 'Beauty & Skincare',    tier: 'established' },
  // Health & Wellness
  { name: 'Athletic Greens', domain: 'athleticgreens.com', category: 'Health & Wellness',   tier: 'established' },
  { name: 'Seed Health',    domain: 'seed.com',            category: 'Health & Wellness',   tier: 'emerging' },
  { name: 'Ritual',         domain: 'ritual.com',          category: 'Health & Wellness',   tier: 'established' },
  { name: 'Thrive Market',  domain: 'thrivemarket.com',    category: 'Food & Beverage',     tier: 'established' },
  { name: 'Magic Spoon',    domain: 'magicspoon.com',      category: 'Food & Beverage',     tier: 'emerging' },
  // Home & Living
  { name: 'Floyd Home',     domain: 'floydhome.com',      category: 'Home & Living',        tier: 'emerging' },
  { name: 'Parachute Home', domain: 'parachutehome.com',  category: 'Home & Living',        tier: 'established' },
  { name: 'Brooklinen',     domain: 'brooklinen.com',     category: 'Home & Living',        tier: 'established' },
  { name: 'Brightland',     domain: 'brightland.com',     category: 'Food & Beverage',      tier: 'premium' },
  { name: 'Year & Day',     domain: 'yearandday.com',     category: 'Home & Living',        tier: 'emerging' },
  // Tech & Gadgets
  { name: 'Oura Ring',      domain: 'ouraring.com',       category: 'Tech & Gadgets',       tier: 'premium' },
  { name: 'Whoop',          domain: 'whoop.com',          category: 'Fitness & Sports',     tier: 'established' },
  { name: 'Peak Design',    domain: 'peakdesign.com',     category: 'Tech & Gadgets',       tier: 'premium' },
  { name: 'Bellroy',        domain: 'bellroy.com',        category: 'Travel & Luggage',     tier: 'premium' },
  // Jewelry & Watches
  { name: 'Mejuri',         domain: 'mejuri.com',         category: 'Jewelry & Watches',    tier: 'premium' },
  { name: 'Studs',          domain: 'studs.com',          category: 'Jewelry & Watches',    tier: 'emerging' },
  { name: 'AUrate',         domain: 'auratenewyork.com',  category: 'Jewelry & Watches',    tier: 'premium' },
  // Sustainable
  { name: 'Girlfriend Collective', domain: 'girlfriend.com', category: 'Sustainable & Eco', tier: 'established' },
  { name: 'Pela Case',      domain: 'pelacase.com',       category: 'Sustainable & Eco',   tier: 'emerging' },
  { name: 'Tentree',        domain: 'tentree.com',        category: 'Sustainable & Eco',   tier: 'established' },
  // Pets
  { name: 'Wild One',       domain: 'wildone.com',        category: 'Pets',                 tier: 'emerging' },
  { name: 'BarkBox',        domain: 'barkbox.com',        category: 'Pets',                 tier: 'established' },
  // Gifts & Novelty
  { name: 'Uncommon Goods', domain: 'uncommongoods.com',  category: 'Gifts & Novelty',     tier: 'established' },
  { name: 'Greetabl',       domain: 'greetabl.com',       category: 'Gifts & Novelty',     tier: 'emerging' },
];

// -----------------------------------------------------------------

/**
 * Scrape milled.com for brands in a specific category/search.
 * Returns array of raw brand objects.
 */
async function scrapeMilledSearch(searchTerm, maxResults = 30) {
  const brands = [];
  try {
    const url = `https://milled.com/search?q=${encodeURIComponent(searchTerm)}&type=senders`;
    logger.info(`Scraping milled.com: "${searchTerm}"`);

    const res = await axios.get(url, { headers: BASE_HEADERS, timeout: 15000 });
    const $ = cheerio.load(res.data);

    // Milled.com brand result cards
    $('div.content-list-item, .sender-item, article[data-sender]').each((i, el) => {
      if (brands.length >= maxResults) return false;

      const $el = $(el);

      const name = $el.find('.content-list-item-name, .sender-name, h3').first().text().trim();
      const profileLink = $el.find('a[href*="/"]').first().attr('href');
      const domain = profileLink
        ? profileLink.replace(/^\//, '').split('/')[0]
        : null;

      const frequency = $el.find('.frequency, .send-frequency').text().trim();
      const tags = [];
      $el.find('.tag, .category-tag, .label').each((_, t) => tags.push($(t).text().trim()));

      if (name && name.length > 1) {
        brands.push({
          name,
          milledSlug: profileLink ? profileLink.replace(/^\//, '') : null,
          milledFrequency: frequency || null,
          milledIndustrialTags: tags,
          source: 'milled.com',
          sourceUrl: url
        });
      }
    });

    // Alternative scraping for different milled.com page structure
    if (brands.length === 0) {
      $('a[href^="/"]').each((i, el) => {
        if (brands.length >= maxResults) return false;
        const $el = $(el);
        const href = $el.attr('href') || '';
        const text = $el.text().trim();

        // Milled brand pages are /{brand-slug}
        if (href.split('/').length === 2 && text.length > 2 && text.length < 60 &&
            !href.includes('search') && !href.includes('page') && !href.includes('.')) {
          brands.push({
            name: text,
            milledSlug: href.replace('/', ''),
            source: 'milled.com',
            sourceUrl: url
          });
        }
      });
    }

    logger.info(`Found ${brands.length} brands for "${searchTerm}"`);
  } catch (err) {
    logger.warn(`Milled.com scrape failed for "${searchTerm}": ${err.message}`);
  }
  return brands;
}

/**
 * Get detailed brand info from milled.com brand page.
 * Enriches a brand with domain, website, frequency, etc.
 */
async function scrapeMilledBrandPage(milledSlug) {
  try {
    const url = `https://milled.com/${milledSlug}`;
    const res = await axios.get(url, { headers: BASE_HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);

    // Extract website link
    const websiteLink = $('a[href*="://"]').filter((_, el) => {
      const href = $(el).attr('href') || '';
      return !href.includes('milled.com') && href.startsWith('http');
    }).first().attr('href');

    let domain = null;
    if (websiteLink) {
      try {
        domain = new URL(websiteLink).hostname.replace(/^www\./, '');
      } catch { /* ignore */ }
    }

    const description = $('meta[name="description"]').attr('content') ||
                        $('.sender-description, .brand-description').first().text().trim();

    const frequency = $('.frequency-count, .send-count').first().text().trim();
    const tags = [];
    $('.industry-tag, .category-badge').each((_, el) => tags.push($(el).text().trim()));

    return { domain, websiteUrl: websiteLink, description, milledFrequency: frequency, milledIndustrialTags: tags };
  } catch {
    return {};
  }
}

/**
 * Check if a brand has a real website we can sign up to.
 */
async function validateBrandWebsite(websiteUrl) {
  try {
    const res = await axios.get(websiteUrl, {
      headers: BASE_HEADERS,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (s) => s < 500
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

/**
 * Score a brand for quality and affiliate potential.
 * Returns a score 1-10 based on heuristics (AI scoring happens in brandCategorizer).
 */
function scoreBrand(brand) {
  let score = 5; // Base score

  const nameLower = (brand.name || '').toLowerCase();
  const descLower = (brand.description || '').toLowerCase();
  const combined  = nameLower + ' ' + descLower;

  // Downgrade low-quality indicators
  if (LOW_VALUE_INDICATORS.some(kw => combined.includes(kw))) score -= 3;

  // Upgrade for known quality signals
  if (HIGH_VALUE_KEYWORDS.some(kw => combined.includes(kw))) score += 1;

  // Frequency signals: brands that send regularly are more engaged
  const freq = (brand.milledFrequency || '').toLowerCase();
  if (freq.includes('week')) score += 1;
  if (freq.includes('daily')) score += 0.5;
  if (freq.includes('month')) score += 0;

  // Tier from seed data
  const tier = brand.tier;
  if (tier === 'luxury')      score += 2;
  if (tier === 'premium')     score += 1.5;
  if (tier === 'established') score += 1;
  if (tier === 'emerging')    score += 0.5;

  // Has tags from milled = more data = more established brand
  if ((brand.milledIndustrialTags || []).length > 2) score += 0.5;

  return Math.min(10, Math.max(1, Math.round(score)));
}

/**
 * Main discovery function - returns up to `limit` scored, unique brands.
 * @param {number} limit - Max number of brands to discover
 * @param {Object} existingDomains - Set of already-onboarded domains to skip
 */
async function discoverBrands(limit = 20, existingDomains = new Set()) {
  logger.info(`\n Starting brand discovery - target: ${limit} brands`);
  const discovered = new Map(); // domain -> brand object, to deduplicate

  // -- 1. Start with curated seed brands ------------------------
  logger.info('Loading curated seed brands...');
  for (const brand of SEED_BRANDS) {
    const cleanDomain = brand.domain.replace(/^www\./, '').toLowerCase();
    if (!existingDomains.has(cleanDomain) && !discovered.has(cleanDomain)) {
      discovered.set(cleanDomain, {
        ...brand,
        websiteUrl: `https://www.${brand.domain}`,
        source: 'curated_seed',
        qualityScore: scoreBrand(brand),
        affiliatePotentialScore: brand.tier === 'luxury' ? 8 :
                                  brand.tier === 'premium' ? 7 :
                                  brand.tier === 'established' ? 6 : 5
      });
    }
  }
  logger.info(`Loaded ${discovered.size} seed brands`);

  // -- 2. Scrape milled.com by category -------------------------
  // Sort by priority - do high-priority categories first
  const sortedTerms = [...MILLED_SEARCH_TERMS].sort((a, b) => a.priority - b.priority);

  for (const { category, query, priority } of sortedTerms) {
    if (discovered.size >= limit * 3) break; // We have enough to filter from

    try {
      const milledBrands = await scrapeMilledSearch(query, 20);
      await sleep(1500); // Be polite to milled.com

      for (const brand of milledBrands) {
        if (!brand.name) continue;

        // If we got a milled slug, try to get the actual domain
        let domain = brand.domain;
        if (!domain && brand.milledSlug) {
          const detail = await scrapeMilledBrandPage(brand.milledSlug);
          await sleep(800);
          if (detail.domain) {
            domain = detail.domain;
            Object.assign(brand, detail);
          }
        }

        if (!domain) domain = brand.milledSlug + '.com'; // Best guess

        const cleanDomain = domain.replace(/^www\./, '').toLowerCase();
        if (existingDomains.has(cleanDomain) || discovered.has(cleanDomain)) continue;

        // Basic quality filter
        const qualityScore = scoreBrand({ ...brand, category });
        if (qualityScore < 4) continue;

        discovered.set(cleanDomain, {
          name:         brand.name,
          domain:       cleanDomain,
          websiteUrl:   brand.websiteUrl || `https://www.${cleanDomain}`,
          description:  brand.description || '',
          source:       'milled.com',
          sourceUrl:    brand.sourceUrl,
          milledFrequency:     brand.milledFrequency,
          milledIndustrialTags: brand.milledIndustrialTags || [],
          qualityScore,
          affiliatePotentialScore: qualityScore >= 7 ? 7 : qualityScore >= 5 ? 5 : 4
        });
      }
    } catch (err) {
      logger.warn(`Category scrape failed for ${category}: ${err.message}`);
    }
  }

  // -- 3. Sort by quality score and return top N -----------------
  const all = Array.from(discovered.values());
  all.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));

  const result = all.slice(0, limit);
  logger.info(`[OK] Discovery complete: returning ${result.length} brands`);
  return result;
}

module.exports = { discoverBrands, scrapeMilledBrandPage, validateBrandWebsite };
