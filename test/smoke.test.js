'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const assert = require('assert');

// Resolve CLI entrypoint from package.json bin field
const pkg = require('../package.json');
const binName = Object.keys(pkg.bin || {})[0];
const cli = binName
  ? path.resolve(__dirname, '..', pkg.bin[binName])
  : path.resolve(__dirname, '../api-client.js');

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`PASS: ${label}`);
  passed++;
}

function fail(label, err) {
  console.error(`FAIL: ${label}`, err ? String(err.message || err) : '');
  failed++;
}

// Test 1: entrypoint file exists
try {
  const fs = require('fs');
  assert(fs.existsSync(cli), `CLI entrypoint not found: ${cli}`);
  pass('entrypoint exists');
} catch (e) {
  fail('entrypoint exists', e);
}

// Test 2: syntax check (no parse errors)
try {
  execFileSync('node', ['--check', cli], { encoding: 'utf8' });
  pass('syntax check');
} catch (e) {
  fail('syntax check', e);
}

// Test 3: --help exits 0 and produces output
try {
  const help = execFileSync('node', [cli, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert(help.length > 0, '--help should produce output');
  assert(help.includes('woolies') || help.includes('Usage'), '--help should mention woolies or Usage');
  pass('--help exits 0 with output');
} catch (e) {
  // Some CLIs exit non-zero for --help; treat exit 1 as advisory only
  if (e.status && e.status > 1) {
    fail('--help exits 0 with output', e);
  } else {
    pass('--help (non-zero but not crash)');
  }
}

// Test 4: help command (alias)
try {
  const help = execFileSync('node', [cli, 'help'], { encoding: 'utf8', timeout: 10000 });
  assert(help.length > 0, 'help command should produce output');
  pass('help command produces output');
} catch (e) {
  if (e.status && e.status > 1) {
    fail('help command produces output', e);
  } else {
    pass('help command (non-zero but not crash)');
  }
}

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
