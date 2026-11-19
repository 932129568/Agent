'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const outfile = path.join(root, 'libs', 'ui-schema.bundle.js');
const notice = [
  'Harbor UiSchema adapter',
  'Source map: frontend/vendor/ui-schema-entry.js -> libs/ui-schema.bundle.js',
  'Runtime: zod@4.6.7 (MIT, zero external dependencies).',
  'Build-only: esbuild@0.28.2 (MIT). esbuild and platform packages are not bundled.',
  'No CDN, framework, renderer, or runtime network dependency.',
  '',
].join('\n');

async function main() {
  await esbuild.build({
    entryPoints: [path.join(root, 'frontend', 'vendor', 'ui-schema-entry.js')],
    outfile,
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    platform: 'browser',
  });
  const zodLicense = path.join(root, 'node_modules', 'zod', 'LICENSE');
  fs.copyFileSync(zodLicense, path.join(root, 'libs', 'ui-schema.LICENSE.txt'));
  fs.writeFileSync(path.join(root, 'libs', 'ui-schema.NOTICE.txt'), notice, 'utf8');
  const bytes = fs.readFileSync(outfile);
  const report = {
    file: 'libs/ui-schema.bundle.js',
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    gzipBytes: zlib.gzipSync(bytes, { level: 9, mtime: 0 }).length,
    environment: {
      node: process.version, platform: process.platform, arch: process.arch,
      zod: '4.6.7', esbuild: '0.28.2', format: 'iife', minify: true,
    },
  };
  const reportDir = path.join(root, 'outputs', 'generative-g1');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'bundle-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
