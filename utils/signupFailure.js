function normalizeErrorText(err) {
  return String(err || '').trim();
}

function classifySignupFailure(errorMessage = '', strategy = null) {
  const msg = normalizeErrorText(errorMessage).toLowerCase();

  if (!msg) {
    return { category: 'unknown', code: 'unknown_failure' };
  }

  if (msg.includes('hard timeout') || msg.includes('exceeded 3 minutes')) {
    return { category: 'automation_timeout', code: 'hard_timeout' };
  }
  if (msg.includes('captcha')) {
    return { category: 'captcha_blocked', code: 'captcha_detected' };
  }
  if (msg.includes('no signup form found')) {
    return { category: 'no_form_detected', code: 'all_strategies_exhausted' };
  }
  if (msg.includes('page timeout') || msg.includes('navigation timeout')) {
    return { category: 'site_timeout', code: 'navigation_timeout' };
  }
  if (msg.includes('executable doesn\'t exist') || msg.includes('npx playwright install')) {
    return { category: 'environment_error', code: 'playwright_browser_missing' };
  }
  if (msg.includes('error while loading shared libraries') || msg.includes('libglib') || msg.includes('libnspr')) {
    return { category: 'environment_error', code: 'playwright_shared_lib_missing' };
  }
  if (msg.includes('target page, context or browser has been closed') || msg.includes('browsertype.launch')) {
    return { category: 'environment_error', code: 'playwright_launch_failed' };
  }
  if (msg.includes('403') || msg.includes('access denied') || msg.includes('forbidden') || msg.includes('blocked')) {
    return { category: 'bot_blocked', code: 'access_blocked' };
  }

  if (strategy && String(strategy).toLowerCase().includes('http_fallback')) {
    return { category: 'http_fallback_failed', code: 'http_fallback_failed' };
  }

  return { category: 'unknown', code: 'unknown_failure' };
}

module.exports = { classifySignupFailure };
