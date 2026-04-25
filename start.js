const fs = require('fs');
const { execFileSync } = require('child_process');

// Write config.js from environment variable
const token = process.env.GITHUB_TOKEN || '';
fs.writeFileSync('config.js',
  `const CONFIG = { GITHUB_TOKEN: ${JSON.stringify(token)} };\n`
);

// Build JS bundle
execFileSync('npx', ['esbuild', 'js/main.js', '--bundle', '--outfile=dist/bundle.js', '--format=iife', '--minify'], { stdio: 'inherit' });

// Start static file server
const port = process.env.PORT || '3000';
execFileSync('npx', ['serve', '.', '--listen', port], { stdio: 'inherit' });
