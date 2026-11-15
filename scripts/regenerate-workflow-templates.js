#!/usr/bin/env node
// Rewrites templates/workflows/*.yml from lib/templates.js (npm, build-storybook).
// These copies are documentation only (not shipped); test/templates.test.js
// fails when they drift from the generator, which is how they went stale
// before (ISSUES.md #50).
const fs = require('fs');
const path = require('path');
const { generateMainWorkflow, generatePRWorkflow, generateCaptureWebWorkflow } = require('../lib/templates.js');

const dir = path.join(__dirname, '..', 'templates', 'workflows');
const files = {
  'deploy-storybook.yml': generateMainWorkflow('', '', 'npm', 'build-storybook'),
  'deploy-pr-preview.yml': generatePRWorkflow('', '', 'npm', 'build-storybook'),
  // Written only by `init --capture web` / `update-workflows --capture web`.
  'scry-capture-web.yml': generateCaptureWebWorkflow('npm'),
};

if (require.main === module) {
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
    console.log(`wrote templates/workflows/${name}`);
  }
}

module.exports = { files, dir };
