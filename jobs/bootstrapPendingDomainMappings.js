const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const { connectDB } = require('../config/database');
const { normalizeDomain, getRegistrableDomain } = require('../utils/domainIdentity');

const DOMAIN_BOOTSTRAP = [
  {
    senderDomain: 'mail.jcrew.com',
    brandName: 'J.Crew',
    brandDomain: 'jcrew.com',
    websiteUrl: 'https://www.jcrew.com'
  },
  {
    senderDomain: 'ayr.com',
    brandName: 'AYR',
    brandDomain: 'ayr.com',
    websiteUrl: 'https://www.ayr.com'
  },
  {
    senderDomain: 'news.anker.com',
    brandName: 'Anker',
    brandDomain: 'anker.com',
    websiteUrl: 'https://www.anker.com'
  }
];

function toLowerSet(values = []) {
  return Array.from(new Set(values.map((v) => String(v || '').toLowerCase().trim()).filter(Boolean)));
}

async function upsertBrandMapping(mapping) {
  const senderDomain = normalizeDomain(mapping.senderDomain);
  const brandDomain = normalizeDomain(mapping.brandDomain);
  const senderApex = getRegistrableDomain(senderDomain) || senderDomain;
  const knownDomains = toLowerSet([senderDomain, senderApex, brandDomain]);

  const brand = await Brand.findOneAndUpdate(
    { domain: brandDomain },
    {
      $setOnInsert: {
        name: mapping.brandName,
        domain: brandDomain,
        websiteUrl: mapping.websiteUrl,
        source: 'manual',
        discoveredAt: new Date()
      },
      $set: {
        onboardingStatus: 'active',
        statusUpdatedAt: new Date()
      },
      $addToSet: {
        knownSenderDomains: { $each: knownDomains }
      }
    },
    { upsert: true, new: true }
  );

  const senderEmails = await EmailMessage.distinct('fromEmail', {
    fromDomain: senderDomain,
    fromEmail: { $type: 'string', $ne: '' }
  });
  const cleanedEmails = toLowerSet(senderEmails);
  if (cleanedEmails.length) {
    brand.knownSenderEmails = toLowerSet([...(brand.knownSenderEmails || []), ...cleanedEmails]);
    await brand.save();
  }

  return { brand, senderDomain };
}

async function resolvePendingForDomain(senderDomain, brandId) {
  const now = new Date();
  const emailResult = await EmailMessage.updateMany(
    {
      fromDomain: senderDomain,
      state: 'brand_unresolved'
    },
    {
      $set: {
        brandId,
        state: 'brand_resolved',
        needsReview: false,
        classificationConfidence: 10,
        classificationReason: 'manual_domain_bootstrap',
        'processedBy.identity_resolver.done': true,
        'processedBy.identity_resolver.at': now,
        'processedBy.identity_resolver.status': 'done',
        'processedBy.identity_resolver.lastProcessedAt': now,
        'processedBy.identity_resolver.error': null,
        'processingTrace.resolve': {
          at: now,
          status: 'resolved',
          reason: 'manual_domain_bootstrap',
          confidence: 10
        }
      },
      $inc: {
        'processedBy.identity_resolver.attempts': 1
      }
    }
  );

  const queue = mongoose.connection.db.collection('manual_review_queue');
  const queueResult = await queue.updateMany(
    {
      fromDomain: senderDomain,
      status: 'pending'
    },
    {
      $set: {
        status: 'resolved_auto',
        resolution: 'domain_bootstrap',
        resolvedAt: now,
        resolvedBrandId: brandId
      }
    }
  );

  return {
    emailResolved: emailResult.modifiedCount || 0,
    queueResolved: queueResult.modifiedCount || 0
  };
}

async function run() {
  await connectDB();
  const summary = [];
  for (const mapping of DOMAIN_BOOTSTRAP) {
    const { brand, senderDomain } = await upsertBrandMapping(mapping);
    const resolved = await resolvePendingForDomain(senderDomain, brand._id);
    summary.push({
      senderDomain,
      brandId: String(brand._id),
      brandName: brand.name,
      brandDomain: brand.domain,
      ...resolved
    });
  }

  const post = {
    manualReviewPending: await mongoose.connection.db.collection('manual_review_queue').countDocuments({ status: 'pending' }),
    brandUnresolved: await mongoose.connection.db.collection('email_messages').countDocuments({ state: 'brand_unresolved' })
  };

  console.log(JSON.stringify({ ok: true, summary, post }, null, 2));
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

