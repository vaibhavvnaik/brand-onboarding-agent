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

function stripCodeFences(text = '') {
  return String(text || '').replace(/^```(?:json)?\n?/im, '').replace(/\n?```$/im, '').trim();
}

function extractBalancedJson(text = '', open = '[', close = ']') {
  const src = String(text || '');
  const start = src.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  const last = src.lastIndexOf(close);
  return last > start ? src.slice(start, last + 1) : null;
}

function parseJsonFromModel(raw = '', mode = 'array') {
  const cleaned = stripCodeFences(raw);
  const candidates = [];

  if (mode === 'array') {
    const arr = extractBalancedJson(cleaned, '[', ']');
    if (arr) candidates.push(arr);
    candidates.push(cleaned);
  } else {
    const obj = extractBalancedJson(cleaned, '{', '}');
    if (obj) candidates.push(obj);
    candidates.push(cleaned);
  }

  let lastErr;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (err) {
      try {
        const repaired = candidate.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(repaired);
      } catch (repairErr) {
        lastErr = repairErr;
      }
    }
  }
  throw lastErr || new Error('Unable to parse model JSON');
}

function normalizeCategorizationPayload(brand, data = {}) {
  const base = getDefaultCategorization(brand);
  const merged = { ...base, ...(data || {}) };
  if (!Array.isArray(merged.categories)) merged.categories = base.categories;
  if (!Array.isArray(merged.productTypes)) merged.productTypes = base.productTypes;
  if (!Array.isArray(merged.tags)) merged.tags = base.tags;
  if (!Array.isArray(merged.lifestyleTags)) merged.lifestyleTags = base.lifestyleTags;
  if (!Array.isArray(merged.targetDemographic)) merged.targetDemographic = base.targetDemographic;
  if (!Array.isArray(merged.affiliateNetworks)) merged.affiliateNetworks = base.affiliateNetworks;
  if (!merged.primaryCategory) merged.primaryCategory = base.primaryCategory;
  if (!merged.description) merged.description = base.description;
  if (typeof merged.qualityScore !== 'number') merged.qualityScore = base.qualityScore;
  if (typeof merged.affiliatePotentialScore !== 'number') merged.affiliatePotentialScore = base.affiliatePotentialScore;
  return merged;
}

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
Output only required fields used by pipeline.

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
  "description":""
}

Constraints:
- categories: 1-3
- productTypes: 0-4
- tags: 3-8
- lifestyleTags: 0-3
- targetDemographic: 1-4
- affiliateNetworks: 0-3
- description max 12 words`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 360,
      messages:   [{ role: 'user', content: prompt }]
    });
    logger.info(`[llm] phase=categorize_single brand=${brand.name} req_id=${response?.id || 'unknown'} in=${response?.usage?.input_tokens ?? 'n/a'} out=${response?.usage?.output_tokens ?? 'n/a'} model=claude-haiku-4-5-20251001`);

    const raw = response.content[0].text.trim();
    const parsedData = parseJsonFromModel(raw, 'object');
    const data = normalizeCategorizationPayload(brand, parsedData);

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
    `${i + 1}|${brand.name}|${brand.domain}|${brand.websiteUrl || 'N/A'}|${(brand.description || 'N/A').slice(0, 120)}|${(brand.milledIndustrialTags || []).slice(0, 5).join(',') || 'none'}`
  ).join('\n');

  const prompt = `Analyze ${brands.length} D2C brands and return JSON array only. No markdown.
Be concise.

Brands format:
index|name|domain|website|description|tags
${brandsList}

Each array item must include:
index,primaryCategory,categories,productTypes,tags,lifestyleTags,targetDemographic,genderFocus,priceRange,brandTier,audienceSize,businessModel,affiliateNetworks,hasAffiliateProgram,estimatedRevShare,qualityScore,affiliatePotentialScore,description

Constraints:
- categories 1-3
- productTypes 0-4
- tags 3-8
- lifestyleTags 0-3
- targetDemographic 1-4
- affiliateNetworks 0-3
- description max 8 words
- index must match input index`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: Math.min(2200, 260 + brands.length * 230),
    messages: [{ role: 'user', content: prompt }]
  });
  logger.info(`[llm] phase=categorize_batch count=${brands.length} req_id=${response?.id || 'unknown'} in=${response?.usage?.input_tokens ?? 'n/a'} out=${response?.usage?.output_tokens ?? 'n/a'} model=claude-haiku-4-5-20251001`);

  const raw = response.content[0].text.trim();
  const dataArray = parseJsonFromModel(raw, 'array');

  if (!Array.isArray(dataArray) || !dataArray.length) {
    throw new Error(`Expected non-empty array, got ${Array.isArray(dataArray) ? dataArray.length : typeof dataArray}`);
  }

  const byIndex = new Map();
  dataArray.forEach((item, pos) => {
    const idx = Number(item?.index);
    const normalizedIdx = Number.isInteger(idx) && idx >= 1 && idx <= brands.length ? idx - 1 : pos;
    if (!byIndex.has(normalizedIdx)) byIndex.set(normalizedIdx, item);
  });

  return brands.map((brand, i) => {
    const data = byIndex.get(i) || dataArray[i];
    if (!data || !data.primaryCategory || typeof data.qualityScore !== 'number') {
      logger.warn(`    Incomplete data for ${brand.name}, using defaults`);
      return { success: false, data: getDefaultCategorization(brand), error: 'Missing required fields' };
    }
    logger.info(`    ${brand.name} -> ${data.primaryCategory} | Q:${data.qualityScore}/10 | A:${data.affiliatePotentialScore}/10`);
    return { success: true, data: normalizeCategorizationPayload(brand, data) };
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
  const BATCH_SIZE = Math.max(2, Math.min(12, parseInt(process.env.CATEGORIZER_BATCH_SIZE || '6', 10)));

  async function processBatch(batch, label) {
    try {
      const batchResults = await categorizeBrandBatch(batch);
      return batch.map((brand, idx) => ({ brand, ...batchResults[idx] }));
    } catch (err) {
      if (batch.length <= 2) {
        logger.warn(`  ${label} failed (${err.message}), falling back to individual calls...`);
        const fallback = [];
        for (const brand of batch) {
          const result = await categorizeBrand(brand);
          fallback.push({ brand, ...result });
          await sleep(250);
        }
        return fallback;
      }

      const mid = Math.ceil(batch.length / 2);
      const left = batch.slice(0, mid);
      const right = batch.slice(mid);
      logger.warn(`  ${label} failed (${err.message}), retrying split ${left.length}+${right.length}...`);
      const leftResults = await processBatch(left, `${label}A`);
      const rightResults = await processBatch(right, `${label}B`);
      return [...leftResults, ...rightResults];
    }
  }

  for (let i = 0; i < brands.length; i += BATCH_SIZE) {
    const batch = brands.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(brands.length / BATCH_SIZE);
    logger.info(`  Batch ${batchNum}/${totalBatches}: [${batch.map(b => b.name).join(', ')}]`);

    const batchResults = await processBatch(batch, `Batch ${batchNum}`);
    batchResults.forEach((row) => results.push(row));

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
