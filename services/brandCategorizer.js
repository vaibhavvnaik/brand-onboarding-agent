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

  const prompt = `Classify this D2C brand and return compact JSON only (no markdown, no prose).
Keep arrays short and strings concise.

Brand:
name=${brand.name}
domain=${brand.domain}
website=${brand.websiteUrl || 'N/A'}
description=${brand.description || 'N/A'}
tags=${(brand.milledIndustrialTags || []).join(', ') || 'none'}

Allowed primaryCategory:
Fashion & Apparel|Beauty & Skincare|Health & Wellness|Home & Living|Food & Beverage|Fitness & Sports|Outdoor & Adventure|Tech & Gadgets|Sustainable & Eco|Baby & Kids|Pets|Travel & Luggage|Jewelry & Watches|Personal Care & Grooming|Gifts & Novelty|Office & Stationery|Art & Craft|Other

Return exactly:
{
  "primaryCategory":"",
  "categories":[],
  "productTypes":[],
  "tags":[],
  "lifestyleTags":[],
  "targetDemographic":[],
  "genderFocus":"women|men|unisex|kids|all",
  "priceRange":"budget|mid-range|premium|luxury|mixed",
  "brandTier":"emerging|established|premium|luxury|niche",
  "audienceSize":"niche|mid|large|mega",
  "businessModel":"dtc|retail|marketplace|subscription|hybrid",
  "affiliateNetworks":[],
  "hasAffiliateProgram":false,
  "estimatedRevShare":"unknown",
  "qualityScore":5,
  "affiliatePotentialScore":5,
  "contentScore":null,
  "description":"",
  "headquarters":"unknown",
  "reasoning":""
}

Constraints:
- categories: 1-3
- productTypes: 0-4
- tags: 3-8
- lifestyleTags: 0-3
- targetDemographic: 1-4
- affiliateNetworks: 0-3
- description max 16 words
- reasoning max 10 words`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 560,
      messages:   [{ role: 'user', content: prompt }]
    });
    logger.info(`[llm] phase=categorize_single brand=${brand.name} req_id=${response?.id || 'unknown'} in=${response?.usage?.input_tokens ?? 'n/a'} out=${response?.usage?.output_tokens ?? 'n/a'} model=claude-haiku-4-5-20251001`);

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

  const prompt = `Analyze ${brands.length} D2C brands and return JSON array only. No markdown.
Be concise: short arrays, short strings.

Brands:
${brandsList}

Each array item must include:
primaryCategory,categories,productTypes,tags,lifestyleTags,targetDemographic,genderFocus,priceRange,brandTier,audienceSize,businessModel,affiliateNetworks,hasAffiliateProgram,estimatedRevShare,qualityScore,affiliatePotentialScore,contentScore,description,headquarters,reasoning

Constraints:
- categories 1-3
- productTypes 0-4
- tags 3-8
- lifestyleTags 0-3
- targetDemographic 1-4
- affiliateNetworks 0-3
- description max 16 words
- reasoning max 10 words`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: Math.min(2200, 280 + brands.length * 190),
    messages: [{ role: 'user', content: prompt }]
  });
  logger.info(`[llm] phase=categorize_batch count=${brands.length} req_id=${response?.id || 'unknown'} in=${response?.usage?.input_tokens ?? 'n/a'} out=${response?.usage?.output_tokens ?? 'n/a'} model=claude-haiku-4-5-20251001`);

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
