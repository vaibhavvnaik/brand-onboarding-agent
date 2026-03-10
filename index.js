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
const apiRoutes     = require('./routes/api');
const adminRoutes   = require('./routes/admin');
const setupRoutes   = require('./routes/setup');

const app  = express();
const PORT = process.env.PORT || 3000;

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
      .then(() => logger.info('MongoDB connected successfully'))
      .catch(err => logger.error('MongoDB connection failed (server still running):', err.message));

  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGINT',  () => { logger.info('SIGINT received, shutting down'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down'); process.exit(0); });
