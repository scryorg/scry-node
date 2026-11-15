---
"@scrymore/scry-deployer": minor
---

Build-free web capture. `scry-deployer capture web` captures the stories of a Storybook 10 project on a Vite framework with the React renderer into a Scry Capture Format bundle without building Storybook: it starts the project's own Vite dev server, renders each story in headless Chromium and writes one image and one structure tree per story. Upload the bundle with `scry-deployer upload .scry/capture`. It needs `storybook`, `vite` and `playwright` installed in the project and Node 20.19 or newer. See `docs/capture-web.md`.

`scry-deployer init --capture web` and `scry-deployer update-workflows --capture web` write `.github/workflows/scry-capture-web.yml`, which captures and uploads on a push to the default branch. The main `deploy-storybook.yml` then runs with `--no-analysis` (it still builds and hosts Storybook and reports coverage), and `deploy-pr-preview.yml` is unchanged. A project that does not qualify gets a message and no files. Without the option, both commands write what they wrote before.
