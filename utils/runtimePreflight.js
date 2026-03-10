const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

let runtimeState = {
  checkedAt: null,
  ready: false,
  reason: 'not_checked',
  autoInstallAttempted: false
};

let checkingPromise = null;

function withLibraryPaths() {
  const libPaths = [
    path.join(__dirname, '../.local-libs/usr/lib/x86_64-linux-gnu'),
    path.join(__dirname, '../.local-libs/lib/x86_64-linux-gnu')
  ].map((p) => path.resolve(p)).filter((p) => fs.existsSync(p));

  const existing = process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(':') : [];
  process.env.LD_LIBRARY_PATH = Array.from(new Set([...libPaths, ...existing.filter(Boolean)])).join(':');
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}

function getExecutablePathSafe() {
  try {
    const { chromium } = require('playwright');
    return chromium.executablePath();
  } catch {
    return null;
  }
}

function tryInstallChromium() {
  runtimeState.autoInstallAttempted = true;
  const installCmd = `${process.execPath} ./node_modules/playwright/cli.js install chromium`;
  logger.warn(`[runtime] Playwright browser missing; attempting auto-install: ${installCmd}`);
  execSync(installCmd, {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env
  });
}

async function launchSmokeTest() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await browser.close();
}

async function ensurePlaywrightRuntimeReady({ autoInstall = true } = {}) {
  if (checkingPromise) return checkingPromise;

  checkingPromise = (async () => {
    withLibraryPaths();
    runtimeState.checkedAt = new Date();

    try {
      let execPath = getExecutablePathSafe();
      if (!execPath || !fs.existsSync(execPath)) {
        if (autoInstall) {
          tryInstallChromium();
          execPath = getExecutablePathSafe();
        }
      }

      if (!execPath || !fs.existsSync(execPath)) {
        runtimeState.ready = false;
        runtimeState.reason = 'playwright_executable_missing';
        logger.error('[runtime] Playwright executable missing after preflight.');
        return runtimeState;
      }

      try {
        await launchSmokeTest();
        runtimeState.ready = true;
        runtimeState.reason = 'ok';
        logger.info('[runtime] Playwright preflight passed (launch smoke test succeeded).');
      } catch (err) {
        runtimeState.ready = false;
        runtimeState.reason = err.message;
        logger.error(`[runtime] Playwright preflight failed: ${err.message}`);
      }
      return runtimeState;
    } catch (err) {
      runtimeState.ready = false;
      runtimeState.reason = err.message;
      logger.error(`[runtime] Playwright preflight crashed: ${err.message}`);
      return runtimeState;
    } finally {
      checkingPromise = null;
    }
  })();

  return checkingPromise;
}

function getPlaywrightRuntimeStatus() {
  return { ...runtimeState };
}

module.exports = { ensurePlaywrightRuntimeReady, getPlaywrightRuntimeStatus };
