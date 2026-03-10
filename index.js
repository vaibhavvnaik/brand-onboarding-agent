/**
 * Brand Onboarding Agent - Railway Server Entry Point
 *
 * Runs as a pure web server (no CLI).
 * Visit /setup to connect Gmail via OAuth (no terminal needed).
 * Visit /dashboard for the admin UI.
 */

// Prevent unhandled promise rejections from crashing Node.js 15+
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection] Unhandled promise rejection:', reason);
  // Do NOT exit - keep server running
});

require('dotenv').config();
const express   = require('express');
const session   = require('express-session');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const { connectDB } = require('./config/database');
const { validateRequiredEnv } = require('./config/env');
const logger        = require('./utils/logger');
const WorkflowRun   = require('./models/WorkflowRun');
const { runJob }    = require('./jobs/runJob');
const { appendActivityLog } = require('./utils/activityLog');
const { ensurePlaywrightRuntimeReady } = require('./utils/runtimePreflight');
const apiRoutes     = require('./routes/api');
const adminRoutes   = require('./routes/admin');
const setupRoutes   = require('./routes/setup');

const app  = express();
const PORT = process.env.PORT || 3000;

let schedulerRunning = false;

async function runStepWithTracking(step, options = {}) {
  const startedAt = new Date();
  let runRow = null;
  try {
    runRow = await WorkflowRun.create({
      step,
      trigger: 'scheduler',
      status: 'running',
      startedAt,
      meta: { options }
    });
  } catch {
    // non-fatal
  }

  try {
    const result = await runJob(step, options);
    if (runRow) {
      runRow.status = 'success';
      runRow.completedAt = new Date();
      runRow.durationMs = runRow.completedAt.getTime() - startedAt.getTime();
      runRow.summary = result;
      await runRow.save();
    }
    return { step, status: 'success', result };
  } catch (err) {
    if (runRow) {
      runRow.status = 'failed';
      runRow.completedAt = new Date();
      runRow.durationMs = runRow.completedAt.getTime() - startedAt.getTime();
      runRow.error = err.message;
      await runRow.save();
    }
    return { step, status: 'failed', error: err.message };
  }
}

function startInternalScheduler() {
  const enabled = (process.env.INTERNAL_CRON_ENABLED || 'true').toLowerCase() !== 'false';
  const intervalMin = Number(process.env.INTERNAL_CRON_INTERVAL_MIN || 10);
  const intervalMs = Math.max(1, intervalMin) * 60 * 1000;
  const initialDelaySec = Number(process.env.INTERNAL_CRON_INITIAL_DELAY_SEC || 30);
  const options = {
    batchSize: Number(process.env.INTERNAL_CRON_BATCH_SIZE || process.env.BATCH_SIZE || 10),
    inboxHours: Number(process.env.INTERNAL_CRON_INBOX_HOURS || process.env.SCAN_HOURS || 24),
    maxInboxResults: Number(process.env.INTERNAL_CRON_MAX_INBOX_RESULTS || process.env.SCAN_MAX_RESULTS || 100),
    limit: Number(process.env.INTERNAL_CRON_STEP_LIMIT || 50)
  };

  if (!enabled) {
    logger.info('[scheduler] Internal scheduler disabled (INTERNAL_CRON_ENABLED=false)');
    return;
  }

  const tick = async () => {
    if (schedulerRunning) {
      logger.warn('[scheduler] Previous cycle still running; skipping this tick');
      return;
    }

    schedulerRunning = true;
    const startedAt = new Date();
    logger.info(`[scheduler] Starting internal cycle (every ${intervalMin} min)`);
    appendActivityLog({
      source: 'job',
      level: 'info',
      phase: 'scheduler',
      message: 'Internal scheduler cycle started',
      meta: { intervalMin, options, startedAt }
    });

    try {
      const results = [];
      results.push(await runStepWithTracking('discover_and_signup', options));
      results.push(await runStepWithTracking('scan_inbox', options));
      results.push(await runStepWithTracking('process_confirmations', options));
      results.push(await runStepWithTracking('ingest_newsletters', options));

      const hasFailure = results.some((r) => r.status !== 'success');
      const completedAt = new Date();
      appendActivityLog({
        source: 'job',
        level: hasFailure ? 'warn' : 'success',
        phase: 'scheduler',
        message: `Internal scheduler cycle ${hasFailure ? 'completed with failures' : 'completed successfully'}`,
        meta: {
          startedAt,
          completedAt,
          durationSec: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
          results
        }
      });
    } catch (err) {
      logger.error('[scheduler] Internal cycle failed', err);
      appendActivityLog({
        source: 'job',
        level: 'error',
        phase: 'scheduler',
        message: `Internal scheduler cycle crashed: ${err.message}`,
        meta: { startedAt }
      });
    } finally {
      schedulerRunning = false;
    }
  };

  logger.info(`[scheduler] Enabled internal scheduler: every ${intervalMin} min`);
  setTimeout(() => { tick().catch(() => {}); }, Math.max(5, initialDelaySec) * 1000);
  setInterval(() => { tick().catch(() => {}); }, intervalMs);
}

function logDiscoveryRuntimeConfig() {
  const source = String(process.env.DISCOVERY_SOURCE || 'claude').toLowerCase();
  const strictClaude = String(process.env.DISCOVERY_STRICT_CLAUDE || 'false').toLowerCase() === 'true';
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  logger.info(`[discovery] source=${source} anthropic_key=${hasAnthropicKey ? 'present' : 'missing'} strict_claude=${strictClaude}`);
  if (!hasAnthropicKey && source !== 'legacy') {
    logger.warn('[discovery] Claude discovery not available (missing ANTHROPIC_API_KEY). Fallback sources will be used.');
  }
}

// -- Main --------------------------------------------------------
(async () => {
  try {
    validateRequiredEnv();

    // Security middleware
    app.use(helmet({ contentSecurityPolicy: false }));

    // CORS
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);

    app.use(cors({
      origin: allowedOrigins.length
        ? (origin, cb) => {
            // Do not throw on disallowed origins; just omit CORS headers.
            // Throwing here bubbles into 500 responses for normal browser flows.
            if (!origin || origin === 'null' || allowedOrigins.includes(origin)) return cb(null, true);
            logger.warn(`CORS blocked origin: ${origin}`);
            return cb(null, false);
          }
        : true,
      credentials: true
    }));

    // Body parsing
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    // Session (in-memory store - safe when MongoDB is unavailable)
    app.use(session({
      secret: process.env.SESSION_SECRET || 'brand-agent-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
      }
    }));

// Trust Railway's proxy headers (fixes express-rate-limit ValidationError)
    app.set('trust proxy', 1);
    
    // Rate limiting
    app.use('/api/', rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: { error: 'Too many requests' }
    }));

    // Routes
    app.use('/api',   apiRoutes);
    // Primary dashboard routes (login/session-protected pages)
    app.use('/dashboard', adminRoutes);
    // Backwards-compatible alias
    app.use('/admin', adminRoutes);
    app.use('/setup', setupRoutes);

    // Health check
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        service: 'brand-onboarding-agent',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // Root
    app.get('/', (req, res) => {
      res.json({
        service: 'Brand Onboarding Agent',
        version: '1.0.0',
        endpoints: {
          health:    '/health',
          api:       '/api',
          dashboard: '/dashboard',
          setup:     '/setup'
        }
      });
    });

    // Error handler
    app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    });

    // Start server FIRST - healthcheck will pass regardless of DB state
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Brand Agent server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info('Dashboard: /dashboard');
      logger.info('Setup:     /setup');
    });

    // Connect to MongoDB asynchronously (non-fatal)
    connectDB()
      .then(() => {
        logger.info('MongoDB connected successfully');
        logDiscoveryRuntimeConfig();
        ensurePlaywrightRuntimeReady({ autoInstall: true }).then((runtime) => {
          logger.info(`[runtime] Playwright ready=${runtime.ready} reason=${runtime.reason}`);
        }).catch((err) => {
          logger.error(`[runtime] Playwright preflight call failed: ${err.message}`);
        });
        startInternalScheduler();
      })
      .catch(err => logger.error('MongoDB connection failed (server still running):', err.message));

  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGINT',  () => { logger.info('SIGINT received, shutting down'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down'); process.exit(0); });
