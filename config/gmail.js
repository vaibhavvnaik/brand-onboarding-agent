/**
 * Gmail API - loads refresh token from env OR from MongoDB (set via /setup/gmail web flow).
 */
const { google } = require('googleapis');
const logger = require('../utils/logger');

let _gmailClient = null;

async function getRefreshToken() {
  if (process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_REFRESH_TOKEN !== 'FILL_IN_AFTER_RUNNING_SETUP') {
    return process.env.GMAIL_REFRESH_TOKEN;
  }
  try {
    const Config = require('../models/Config');
    const token = await Config.get('gmail_refresh_token');
    if (token) return token;
  } catch (_) {}
  return null;
}

async function saveRefreshToken(token) {
    // Cache in-memory immediately so this process can use it right away
    process.env.GMAIL_REFRESH_TOKEN = token;
    _gmailClient = null;
    // Try to persist to MongoDB; log token prominently if DB is unavailable
    try {
          const Config = require('../models/Config');
          await Config.set('gmail_refresh_token', token);
          logger.info('[OK] Gmail refresh token saved to database');
    } catch (dbErr) {
          logger.warn('[WARN] MongoDB unavailable  token NOT persisted to DB.');
          logger.warn('[ACTION REQUIRED] Set in Railway dashboard: GMAIL_REFRESH_TOKEN=' + token);
    }
}

function getOAuth2Client(refreshToken) {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  if (refreshToken) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

async function getGmailClient() {
  if (_gmailClient) return _gmailClient;
  const refreshToken = await getRefreshToken();
  if (!refreshToken) throw new Error('No Gmail token configured. Visit /setup/gmail to connect Gmail.');
  const auth  = getOAuth2Client(refreshToken);
  _gmailClient = google.gmail({ version: 'v1', auth });
  try {
    await _gmailClient.users.getProfile({ userId: 'me' });
    logger.info(`[OK] Gmail API connected for ${process.env.GMAIL_USER}`);
  } catch (err) {
    _gmailClient = null;
    logger.error('[ERR] Gmail API authentication failed:', err.message);
    throw err;
  }
  return _gmailClient;
}

async function searchMessages(query, maxResults = 20) {
  const gmail = await getGmailClient();
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
  return res.data.messages || [];
}

async function getMessage(messageId) {
  const gmail = await getGmailClient();
  const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  return res.data;
}

function parseMessage(msg) {
  const headers = {};
  (msg.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });
  const bodyParts = [];
  function extractParts(part) {
    if (!part) return;
    if (part.body?.data) bodyParts.push({ mimeType: part.mimeType || 'text/plain', content: Buffer.from(part.body.data, 'base64').toString('utf8') });
    (part.parts || []).forEach(extractParts);
  }
  extractParts(msg.payload);
  const htmlPart = bodyParts.find(p => p.mimeType === 'text/html');
  const links = [];
  if (htmlPart) {
    const hrefRegex = /href=["']([^"']+)["']/gi; let match;
    while ((match = hrefRegex.exec(htmlPart.content)) !== null) {
      const url = match[1].trim();
      if (url.startsWith('http') && !url.includes('unsubscribe') && !url.includes('mailto:') && url.length < 500) links.push(url);
    }
  }
  return {
    id: msg.id, threadId: msg.threadId, from: headers['from'] || '', to: headers['to'] || '',
    subject: headers['subject'] || '', date: headers['date'] || '',
    bodyText: bodyParts.find(p => p.mimeType === 'text/plain')?.content || '',
    bodyHtml: htmlPart?.content || '', links: [...new Set(links)],
    snippet: msg.snippet || '', internalDate: msg.internalDate
  };
}

function extractSenderEmail(fromHeader) {
  if (!fromHeader) return null;
  const match = fromHeader.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase().trim();
  const plain = fromHeader.trim().toLowerCase();
  return plain.includes('@') ? plain : null;
}

function extractDomainFromEmail(email) {
  if (!email) return null;
  const parts = email.split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

module.exports = { getGmailClient, getOAuth2Client, getRefreshToken, saveRefreshToken, searchMessages, getMessage, parseMessage, extractSenderEmail, extractDomainFromEmail };
