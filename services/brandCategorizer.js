/**
 * Brand Categorizer Service
 * Uses Claude AI to intelligently categorize brands and score them for
 * quality, affiliate potential, and audience fit.
 */
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

let anthropicClient = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Full AI categorization of a brand.
 * Returns categories, tags, scores, and demographic data.
 *
 * @param {Object} brand - { name, domain, description, milledIndustrialTags, websiteUrl }
 * @returns {Object} categorization result
 */
async function categorizeBrand(brand) {
  const client = getClient();
  if (!client) {
    return { success: false, data: getDefaultCategorization(brand), error: 'ANTHROPIC_API_KEY not configured' };
  }

  const prompt = `You are an expert D2C (direct-to-consumer) brand analyst helping to build a curated newsletter discovery platform called urklist.com. Your job is to categorize and score brands so their newsletters can be matched to end consumers and monetized through affiliate marketing.

Analyze this brand and return a JSON object with the categorization.

BRAND INFORMATION:
- Name: ${brand.name}
- Domain: ${brand.domain}
- Website: ${brand.websiteUrl || 'N/A'}
- Description: ${brand.description || 'Not available'}
- Industry tags from Milled.com: ${(brand.milledIndustrialTags || []).join(', ') || 'None'}

AVAILABLE PRIMARY CATEGORIES (pick the single most fitting one):
"Fashion & Apparel", "Beauty & Skincare", "Health & Wellness", "Home & Living",
"Food & Beverage", "Fitness & Sports", "Outdoor & Adventure", "Tech & Gadgets",
"Sustainable & Eco", "Baby & Kids", "Pets", "Travel & Luggage", "Jewelry & Watches",
"Personal Care & Grooming", "Gifts & Novelty", "Office & Stationery", "Art & Craft", "Other"

Return ONLY a valid JSON object (no markdown, no explanation) with exactly this structure:
{
  "primaryCategory": "string - single best category from the list above",
  "categories": ["array", "of 1-4 applicable categories"],
  "productTypes": ["array of specific product types, e.g. 'sneakers', 'serums', 'protein powder'"],
  "tags": ["array of 5-12 specific searchable tags"],
  "lifestyleTags": ["array of 2-5 lifestyle descriptors"],
  "targetDemographic": ["array of relevant segments: 'women', 'men', 'gen-z', 'millennial', 'gen-x', 'parents', 'athletes', 'professionals', 'students'"],
  "genderFocus": "one of: women | men | unisex | kids | all",
  "priceRange": "one of: budget | mid-range | premium | luxury | mixed",
  "brandTier": "one of: emerging | established | premium | luxury | niche",
  "audienceSize": "one of: niche | mid | large | mega",
  "businessModel": "one of: dtc | retail | marketplace | subscription | hybrid",
  "affiliateNetworks": ["likely affiliate networks this brand would use, e.g. 'ShareASale', 'CJ', 'Rakuten', 'Impact', 'AvantLink', 'Pepperjam'"],
  "hasAffiliateProgram": true or false,
  "estimatedRevShare": "estimated commission range, e.g. '5-10%' or 'unknown'",
  "qualityScore": number from 1-10 (10 = iconic brand with massive audience and premium positioning),
  "affiliatePotentialScore": number from 1-10 (10 = high-value affiliate with large audience + strong commission),
  "contentScore": null,
  "description": "1-2 sentence brand description if not provided, or enhance the existing one",
  "headquarters": "City, Country if inferable",
  "reasoning": "1 sentence explaining the quality and affiliate scores"
}

SCORING GUIDELINES:
- qualityScore: Consider brand recognition, product quality, audience loyalty, content quality of newsletters
  - 9-10: Iconic household names with millions of loyal customers (e.g. Patagonia, Glossier)
  - 7-8: Well-known in their niche with strong community (e.g. Allbirds, Mejuri)
  - 5-6: Solid established brands with growing audience
  - 3-4: Emerging brands or regional players
  - 1-2: Unknown or low-quality brands

- affiliatePotentialScore: Consider commission rates, average order value, conversion rates, audience size
  - 9-10: High AOV + generous commissions + massive audience (luxury, beauty, tech)
  - 7-8: Good commissions + established affiliate program
  - 5-6: Moderate affiliate potential
  - 3-4: Limited affiliate program or low AOV
  - 1-2: No affiliate program likely or very niche`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }]
    });

    const raw = response.content[0].text.trim();

    // Strip any markdown code fences if present
    const jsonStr = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

    const data = JSON.parse(jsonStr);

    // Validate required fields
    if (!data.primaryCategory || !data.qualityScore) {
      throw new Error('Missing required categorization fields');
    }

    logger.info(`     ${brand.name} -> ${data.primaryCategory} | Q:${data.qualityScore}/10 | A:${data.affiliatePotentialScore}/10`);
    return { success: true, data };

  } catch (err) {
    logger.warn(`     Categorization failed for ${brand.name}: ${err.message}`);
    return {
      success: false,
      data: getDefaultCategorization(brand),
      error: err.message
    };
  }
}

/**
 * Batch AI categorization - processes multiple brands in ONE API call.
 * Saves ~60% tokens vs individual calls by amortizing system prompt overhead.
 */
async function categorizeBrandBatch(brands) {
  const client = getClient();
  if (!client) {
    return brands.map((brand) => ({
      success: false,
      data: getDefaultCategorization(brand),
      error: 'ANTHROPIC_API_KEY not configured'
    }));
  }
  const brandsList = brands.map((brand, i) =>
    `Brand ${i + 1}:\n- Name: ${brand.name}\n- Domain: ${brand.domain}\n- Website: ${brand.websiteUrl || 'N/A'}\n- Description: ${brand.description || 'Not available'}\n- Industry tags: ${(brand.milledIndustrialTags || []).join(', ') || 'None'}`
  ).join('\n\n');

  const prompt = `You are an expert D2C (direct-to-consumer) brand analyst for urklist.com. Analyze these ${brands.length} brands and return a JSON ARRAY with ${brands.length} categorization objects.

BRANDS TO ANALYZE:
${brandsList}

AVAILABLE PRIMARY CATEGORIES (pick the single most fitting one):
"Fashion & Apparel", "Beauty & Skincare", "Health & Wellness", "Home & Living",
"Food & Beverage", "Fitness & Sports", "Outdoor & Adventure", "Tech & Gadgets",
"Sustainable & Eco", "Baby & Kids", "Pets", "Travel & Luggage", "Jewelry & Watches",
"Personal Care & Grooming", "Gifts & Novelty", "Office & Stationery", "Art & Craft", "Other"

Return ONLY a valid JSON array of ${brands.length} objects (no markdown, no explanation), each with exactly this structure:
{
  "primaryCategory": "string - single best category from the list above",
  "categories": ["array", "of 1-4 applicable categories"],
  "productTypes": ["array of specific product types, e.g. 'sneakers', 'serums', 'protein powder'"],
  "tags": ["array of 5-12 specific searchable tags"],
  "lifestyleTags": ["array of 2-5 lifestyle descriptors"],
  "targetDemographic": ["array of relevant segments: 'women', 'men', 'gen-z', 'millennial'"],
  "genderFocus": "one of: women | men | unisex | kids | all",
  "priceRange": "one of: budget | mid-range | premium | luxury | mixed",
  "brandTier": "one of: emerging | established | premium | luxury | niche",
  "audienceSize": "one of: niche | mid | large | mega",
  "businessModel": "one of: dtc | retail | marketplace | subscription | hybrid",
  "affiliateNetworks": ["likely affiliate networks this brand would use"],
  "hasAffiliateProgram": true or false,
  "estimatedRevShare": "estimated commission range, e.g. '5-10%' or 'unknown'",
  "qualityScore": number from 1-10,
  "affiliatePotentialScore": number from 1-10,
  "contentScore": null,
  "description": "1-2 sentence brand description if not provided, or enhance the existing one",
  "headquarters": "City, Country if inferable",
  "reasoning": "1 sentence explaining the quality and affiliate scores"
}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: Math.min(4096, 600 + brands.length * 420),
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content[0].text.trim();
  // Strip any markdown code fences if present
  const jsonStr = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  const dataArray = JSON.parse(jsonStr);

  if (!Array.isArray(dataArray) || dataArray.length !== brands.length) {
    throw new Error(`Expected array of ${brands.length}, got ${Array.isArray(dataArray) ? dataArray.length : typeof dataArray}`);
  }

  return dataArray.map((data, i) => {
    if (!data.primaryCategory || !data.qualityScore) {
      logger.warn(`    Incomplete data for ${brands[i].name}, using defaults`);
      return { success: false, data: getDefaultCategorization(brands[i]), error: 'Missing required fields' };
    }
    logger.info(`    ${brands[i].name} -> ${data.primaryCategory} | Q:${data.qualityScore}/10 | A:${data.affiliatePotentialScore}/10`);
    return { success: true, data };
  });
}

/**
 * Categorize multiple brands with AI - OPTIMIZED: batch processing.
 * Sends 5 brands per API call (~60% token savings vs individual calls).
 * Falls back to individual calls if a batch fails.
 */
async function categorizeBrands(brands) {
  logger.info(`\n  Categorizing ${brands.length} brands with AI...`);
  const results = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < brands.length; i += BATCH_SIZE) {
    const batch = brands.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(brands.length / BATCH_SIZE);
    logger.info(`  Batch ${batchNum}/${totalBatches}: [${batch.map(b => b.name).join(', ')}]`);

    try {
      const batchResults = await categorizeBrandBatch(batch);
      batchResults.forEach((result, j) => results.push({ brand: batch[j], ...result }));
    } catch (err) {
      logger.warn(`  Batch ${batchNum} failed (${err.message}), falling back to individual calls...`);
      for (const brand of batch) {
        const result = await categorizeBrand(brand);
        results.push({ brand, ...result });
        await sleep(300);
      }
    }

    if (i + BATCH_SIZE < brands.length) await sleep(500);
  }

  const succeeded = results.filter(r => r.success).length;
  logger.info(`  [OK] Categorized ${succeeded}/${brands.length} brands successfully`);
  return results;
}


/**
 * Fallback categorization based on domain name heuristics.
 * Used when AI categorization fails.
 */
function getDefaultCategorization(brand) {
  const name   = (brand.name || '').toLowerCase();
  const domain = (brand.domain || '').toLowerCase();
  const tags   = (brand.milledIndustrialTags || []).map(t => t.toLowerCase());
  const all    = [name, domain, ...tags].join(' ');

  let primaryCategory = 'Other';
  if (/beauty|skin|care|cosmetic|makeup|hair/.test(all))    primaryCategory = 'Beauty & Skincare';
  else if (/fashion|cloth|wear|apparel|style|dress/.test(all)) primaryCategory = 'Fashion & Apparel';
  else if (/health|wellness|vitamin|supplement|organic/.test(all)) primaryCategory = 'Health & Wellness';
  else if (/home|decor|furniture|kitchen|bed|bath/.test(all))  primaryCategory = 'Home & Living';
  else if (/food|drink|snack|meal|beverage|coffee|tea/.test(all)) primaryCategory = 'Food & Beverage';
  else if (/fit|sport|gym|athletics|workout|yoga/.test(all))     primaryCategory = 'Fitness & Sports';
  else if (/outdoor|camp|hike|adventure|trek/.test(all))        primaryCategory = 'Outdoor & Adventure';
  else if (/tech|gadget|electronic|device/.test(all))          primaryCategory = 'Tech & Gadgets';
  else if (/eco|green|sustain|recycl/.test(all))               primaryCategory = 'Sustainable & Eco';
  else if (/jewel|ring|necklace|watch/.test(all))              primaryCategory = 'Jewelry & Watches';
  else if (/pet|dog|cat|animal/.test(all))                     primaryCategory = 'Pets';

  return {
    primaryCategory,
    categories:            [primaryCategory],
    productTypes:          [],
    tags:                  brand.milledIndustrialTags || [],
    lifestyleTags:         [],
    targetDemographic:     ['millennial'],
    genderFocus:          'all',
    priceRange:           'mid-range',
    brandTier:            'established',
    audienceSize:          'mid',
    businessModel:        'dtc',
    affiliateNetworks:     ['ShareASale', 'CJ'],
    hasAffiliateProgram:   false,
    estimatedRevShare:     'unknown',
    qualityScore:          5,
    affiliatePotentialScore: 5,
    contentScore:          null,
    description:           brand.description || `${brand.name} is a ${primaryCategory.toLowerCase()} brand.`,
    headquarters:          'USA',
    reasoning:            'Default scoring - AI categorization unavailable'
  };
}

module.exports = { categorizeBrand, categorizeBrands };
