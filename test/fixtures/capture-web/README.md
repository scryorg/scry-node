# capture-web fixture

A tiny React + Vite + Storybook 10 project used by `test/capture-web-integration.test.js`.

    cd test/fixtures/capture-web && npm install

The integration test skips with a message when `node_modules` here or a Playwright Chromium
is missing. Nothing in this folder is installed by scry-node's own `npm install`.
