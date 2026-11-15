---
name: scry-setup
description: Set up or troubleshoot Scry in a project, including Storybook deployment, GitHub Actions, component indexing, remote MCP connections, and optional Figma linking. Use for Scry onboarding or integration changes, not general UI development or operating Scry's backend infrastructure.
---

# Set up Scry

Make the requested Scry integration work in the user's repository. Inspect what
already exists, implement the missing configuration, and verify the requested
capability. Read only the reference for the path being configured.

## Choose the setup path

- **Deploy or index this project's Storybook:** read
  [project.md](references/project.md). This covers the CLI, CI, coverage, and
  screenshots needed for component search.
- **Capture stories without building Storybook, or move an existing Scry
  project to that:** read [capture-web.md](references/capture-web.md). It
  needs Storybook 10 on a Vite framework with React and deployer 0.14.0 or
  later. In a new setup, offer it when the project qualifies; otherwise use
  `project.md` and say which requirement was not met.
- **Connect an AI assistant to Scry:** read [mcp.md](references/mcp.md).
  An MCP-only request does not require installing the deployer or changing CI.
- **Connect Figma to Storybook:** read [figma.md](references/figma.md).
  Basic linking also works with Storybooks hosted outside Scry.
- **Self-host the platform:** explain that this skill covers client onboarding.
  Use the [self-hosting guide](https://docs.scrymore.com/self-hosting/) and the
  relevant service repositories for the user's infrastructure task. The basic
  hosting guide does not establish that search, MCP, or design review are set up.

For an unspecified "set up Scry" request, inspect the project and prepare its
Storybook integration plus the current assistant's MCP connection. If the repo
has no Storybook, identify whether the user wants to connect an existing Scry
project or add Storybook; make useful independent configuration progress while
that choice is pending. Do not scaffold a new framework just to satisfy a setup
assumption.

## Inspect before configuring

Find the package manager and lockfile, Node version, workspace boundaries,
Storybook config and build script, build output, Git remote/default branch,
existing workflows, and the assistant's existing MCP configuration.

Look for the Scry project ID in `.storybook-deployer.json` (`project`), existing
`.scry/config.json`, `SCRY_PROJECT_ID`/`SCRY_PROJECT`, or CI variables. Read only
needed fields; do not dump credential files. `.scry/config.json` can supply
project context but is not the deployer's configuration file. If IDs disagree,
resolve the intended project before uploading or searching. Reuse existing
configuration and merge changes without duplicating workflows or MCP servers.

The npm package is **`@scrymore/scry-deployer`**. Some Scry docs use older names
such as `@scry/scry` and `@scry/storybook-deployer`; do not copy those names.
Check the installed version and its help/source before relying on flags.
`project.md`, `mcp.md` and `figma.md` were checked against published deployer
**0.6.0** on 2026-09-12 and not re-checked since. `capture-web.md` was checked
on 2026-11-15 against the deployer source that becomes **0.14.0**; the newest
published version that day was 0.13.0, which does not have the command.

## Account and publication boundaries

Use the user's existing project or have them select/create one at
[Scry Dashboard](https://dashboard.scrymore.com). Account sign-in and OAuth
consent happen in the browser. A deployment API key, an MCP OAuth token, and a
Figma connection are different credentials; do not substitute one for another.

Keep deployment keys in the environment or the CI secret store. Do not ask for
keys in chat, print their values, or write them into committed configuration.

The deployer's `init` command writes files, configures GitHub secrets/variables,
commits, and pushes. `--skip-gh-setup` only skips GitHub variable/secret setup;
it does not stop the commit or push. Use the local preparation path in
`project.md` when these remote actions are outside the user's request. Where
publication is already authorized, proceed after preparing and checking the
changes; do not ask for the same authorization again.

## Verify and finish

Report the evidence for each requested capability separately:

- Local configuration: files changed and build/check results.
- Deployment: completed upload/CI run and the actual returned Storybook URL.
- Search: authenticated MCP account, project-filtered search, and a result from
  the expected build when available.
- Figma: connected Storybook and one working link, if that path was requested.

Configuration written is not authentication completed; upload success is not
indexing success. If browser interaction or a pending build prevents a check,
state exactly what remains and the next action. Do not report the whole setup
as complete on the strength of configuration files alone.
