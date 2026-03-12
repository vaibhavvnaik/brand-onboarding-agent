const logger = require('../utils/logger');
const {
  getGmailClient,
  gmailCall,
  extractSenderEmail
} = require('../config/gmail');

const DEFAULT_TARGET_EMAIL = 'victor.fire1980@gmail.com';

const ACTIVITY_CONFIG = {
  metadata_stored: {
    labelName: 'BOA/01-Metadata-Stored',
    color: { textColor: '#ffffff', backgroundColor: '#039be5' }
  },
  processed: {
    labelName: 'BOA/02-Processed',
    color: { textColor: '#ffffff', backgroundColor: '#f4511e' }
  },
  screenshot_captured: {
    labelName: 'BOA/03-Screenshot-Captured',
    color: { textColor: '#ffffff', backgroundColor: '#8e24aa' }
  },
  ingested: {
    labelName: 'BOA/04-Ingested',
    color: { textColor: '#ffffff', backgroundColor: '#0b8043' },
    removeActivities: ['ingestion_skipped', 'error']
  },
  ingestion_skipped: {
    labelName: 'BOA/04-Ingestion-Skipped',
    color: { textColor: '#ffffff', backgroundColor: '#fb8c00' },
    removeActivities: ['ingested', 'error']
  },
  error: {
    labelName: 'BOA/05-Error',
    color: { textColor: '#ffffff', backgroundColor: '#d93025' }
  }
};

const state = {
  loaded: false,
  byName: new Map(),
  colorSynced: new Set()
};

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTargetEmail() {
  return normalizeEmail(process.env.GMAIL_DEBUG_LABEL_TARGET_EMAIL || DEFAULT_TARGET_EMAIL);
}

function extractEmails(headerValue = '') {
  const value = String(headerValue || '');
  const matched = value.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return Array.from(new Set(matched.map(normalizeEmail).filter(Boolean)));
}

function messageTouchesTargetAddress({ parsed = null, emailMessage = null } = {}) {
  const target = readTargetEmail();
  if (!target) return false;

  const fromCandidates = new Set();
  const toCandidates = new Set();

  const parsedFrom = normalizeEmail(extractSenderEmail(parsed?.from || ''));
  if (parsedFrom) fromCandidates.add(parsedFrom);
  const messageFrom = normalizeEmail(emailMessage?.fromEmail || extractSenderEmail(emailMessage?.from || ''));
  if (messageFrom) fromCandidates.add(messageFrom);

  for (const value of extractEmails(parsed?.to || '')) toCandidates.add(value);
  for (const value of extractEmails(emailMessage?.to || '')) toCandidates.add(value);
  for (const value of extractEmails(parsed?.rawHeaders?.['delivered-to'] || '')) toCandidates.add(value);
  for (const value of extractEmails(emailMessage?.headers?.['delivered-to'] || '')) toCandidates.add(value);

  if (fromCandidates.has(target)) return true;
  if (toCandidates.has(target)) return true;

  const targetRegex = new RegExp(`\\b${escapeRegex(target)}\\b`, 'i');
  return targetRegex.test(parsed?.to || '') ||
    targetRegex.test(emailMessage?.to || '') ||
    targetRegex.test(parsed?.from || '') ||
    targetRegex.test(emailMessage?.from || '');
}

async function ensureLoaded(gmail) {
  if (state.loaded) return;
  const res = await gmailCall(
    () => gmail.users.labels.list({ userId: 'me' }),
    { label: 'users.labels.list' }
  );
  const rows = res.data?.labels || [];
  for (const row of rows) {
    if (row?.name && row?.id) state.byName.set(row.name, row.id);
  }
  state.loaded = true;
}

async function ensureLabel(gmail, labelName, color) {
  await ensureLoaded(gmail);
  const existingId = state.byName.get(labelName);
  if (existingId) {
    if (!state.colorSynced.has(existingId)) {
      try {
        await gmailCall(
          () => gmail.users.labels.patch({
            userId: 'me',
            id: existingId,
            requestBody: {
              name: labelName,
              labelListVisibility: 'labelShow',
              messageListVisibility: 'show',
              color
            }
          }),
          { label: 'users.labels.patch' }
        );
        state.colorSynced.add(existingId);
      } catch (err) {
        logger.warn(`[gmail_labels] Failed to patch label "${labelName}": ${err.message}`);
      }
    }
    return existingId;
  }

  const createRes = await gmailCall(
    () => gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
        color
      }
    }),
    { label: 'users.labels.create' }
  );

  const createdId = createRes.data?.id;
  if (createdId) {
    state.byName.set(labelName, createdId);
    state.colorSynced.add(createdId);
  }
  return createdId || null;
}

async function applyActivityLabel({
  gmailMessageId,
  activity,
  parsed = null,
  emailMessage = null
}) {
  const target = readTargetEmail();
  if (!target || !gmailMessageId) return false;
  if (!messageTouchesTargetAddress({ parsed, emailMessage })) return false;

  const config = ACTIVITY_CONFIG[activity];
  if (!config) return false;

  const gmail = await getGmailClient();
  const addLabelId = await ensureLabel(gmail, config.labelName, config.color);
  if (!addLabelId) return false;

  const removeLabelIds = [];
  for (const removeActivity of config.removeActivities || []) {
    const removeCfg = ACTIVITY_CONFIG[removeActivity];
    if (!removeCfg) continue;
    const id = await ensureLabel(gmail, removeCfg.labelName, removeCfg.color);
    if (id) removeLabelIds.push(id);
  }

  await gmailCall(
    () => gmail.users.messages.modify({
      userId: 'me',
      id: String(gmailMessageId),
      requestBody: {
        addLabelIds: [addLabelId],
        removeLabelIds
      }
    }),
    { label: `users.messages.modify.${activity}` }
  );

  return true;
}

async function markEmailActivity({
  gmailMessageId,
  activity,
  parsed = null,
  emailMessage = null
}) {
  try {
    return await applyActivityLabel({
      gmailMessageId,
      activity,
      parsed,
      emailMessage
    });
  } catch (err) {
    logger.warn(`[gmail_labels] Failed to apply activity "${activity}" for ${gmailMessageId}: ${err.message}`);
    return false;
  }
}

module.exports = {
  markEmailActivity,
  messageTouchesTargetAddress
};
