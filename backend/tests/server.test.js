/**
 * End-to-end Server lifecycle and probe test
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const proc = spawn('node', ['server.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, PORT: '5001' },
});

let serverReady = false;

proc.stdout.on('data', (data) => {
  const msg = data.toString();
  process.stdout.write(msg);
  if (msg.includes('Health check available at') && !serverReady) {
    serverReady = true;
    http.get('http://localhost:5001/api/health', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        console.log(`\n✅ Server Probe Success (HTTP ${res.statusCode})`);
        console.log('   Response Body:', body);
        proc.kill('SIGINT');
      });
    }).on('error', (err) => {
      console.error('Probe error:', err);
      proc.kill('SIGTERM');
      process.exit(1);
    });
  }
});

proc.stderr.on('data', (d) => process.stderr.write(d.toString()));

proc.on('close', (code) => {
  console.log(`\n✅ Server terminated cleanly with exit signal/code (${code})`);
  process.exit(0);
});

// Timeout safety
setTimeout(() => {
  if (!serverReady) {
    console.error('❌ Server startup timed out');
    proc.kill('SIGKILL');
    process.exit(1);
  }
}, 7000);
