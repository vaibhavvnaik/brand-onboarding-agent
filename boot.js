// boot.js - Entry point that fixes encoding before starting the app
// Uses execSync to run fix-encoding.js as a child process
// This ensures all source files are cleaned before any require() calls
const { execSync } = require('child_process');
const path = require('path');

console.log('boot.js: Starting encoding fix...');
try {
  execSync('node ' + path.join(__dirname, 'fix-encoding.js'), {
    stdio: 'inherit',
    cwd: __dirname
  });
  console.log('boot.js: Encoding fix completed. Starting app...');
} catch (err) {
  console.error('boot.js: Encoding fix failed:', err.message);
  console.log('boot.js: Attempting to start app anyway...');
}

// Now require the main app (files should be fixed at this point)
require('./index');
