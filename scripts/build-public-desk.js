#!/usr/bin/env node
'use strict';

/** Strip private scanner UI and emit a built desk HTML file. */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const src = path.join(__dirname, '../src/services/vol10s/public/advanced.html');
const outDir = path.join(__dirname, '../src/services/vol10s/public');
const cleaned = path.join(outDir, '_desk.clean.html');
const minOut = path.join(outDir, 'desk.min.html');

let html = fs.readFileSync(src, 'utf8');

function stripPage(html, id) {
  const re = new RegExp(`<div class="page[^"]*" id="${id}"[\\s\\S]*?(?=<div class="page\\b)`);
  return html.replace(re, '');
}

html = html.replace(/<button data-p="scanpath"[\s\S]*?<\/button>/, '');
html = html.replace(/<button data-p="scanner"[\s\S]*?<\/button>/, '');
html = stripPage(html, 'pg-scanpath');
html = stripPage(html, 'pg-scanner');

html = html.replace(/PULSE stock · VECTOR options/g, 'Alpaca paper options');
html = html.replace(/PULSE or VECTOR/g, 'options');
html = html.replace(/PULSE \/ VECTOR/g, 'options');
html = html.replace(/PULSE \+ VECTOR/g, 'options');
html = html.replace(/\bVECTOR\b/g, 'OPTIONS');
html = html.replace(/\bPULSE\b/g, 'STOCK');
html = html.replace(/ClickHouse/g, 'Alpaca');
html = html.replace(/CH loop/g, 'Alpaca scan');
html = html.replace(/CH hits/g, 'scan hits');
html = html.replace(/own CH loop/g, 'Alpaca');
html = html.replace(/CH momentum/g, 'tape momentum');
html = html.replace(/flip option picker/gi, 'setup ranker');
html = html.replace(/Option Scanner/g, 'Setup Ranker');
html = html.replace(/Flip reverse stop/g, 'Signal reverse stop');

html = html.replace(
  'AI scan → watchlist → OPTIONS or STOCK → risk gate',
  'XGBoost + NTSM → RiskGate → Alpaca paper',
);

fs.writeFileSync(cleaned, html);
try {
  execSync(
    `npx --yes html-minifier-terser --collapse-whitespace --minify-css --minify-js --remove-comments -o "${minOut}" "${cleaned}"`,
    { stdio: 'inherit', cwd: path.join(__dirname, '..') },
  );
  fs.unlinkSync(cleaned);
  console.log('wrote', minOut, fs.statSync(minOut).size, 'bytes');
} catch (err) {
  fs.copyFileSync(cleaned, minOut);
  fs.unlinkSync(cleaned);
  console.warn('minifier unavailable, copied cleaned HTML:', err.message);
}
