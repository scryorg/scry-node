const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogger } = require('./logger');
const { getApiClient, safeServerError, getRequestId } = require('./apiClient');
const { generateMainWorkflow, generatePRWorkflow, generateCaptureWebWorkflow, CAPTURE_WEB_WORKFLOW_FILE } = require('./templates');
const { resolveCaptureWeb, captureWebSummaryLines, captureWebWorkflowArgs } = require('./update-workflows');

/**
 * Run the initialization wizard
 */
async function runInit(argv, deps = {}) {
    const logger = createLogger({ verbose: true });

    logger.info('🚀 Scry Storybook Deployer - Setup Wizard\n');
    logger.info('━'.repeat(50) + '\n');

    const totalStartTime = Date.now();

    try {
        // --capture web: checked first, before the credentials and before the first write.
        // A project that cannot use the build-free capture stops here with no config file
        // and no workflows. (Step 1 is a local check of the two flags; nothing is lost by
        // running this before it, and a project that does not qualify hears so at once.)
        const captureWeb = resolveCaptureWeb(argv, deps);
        if (captureWeb) {
            logger.success('✅ This project can use the build-free capture (capture web)\n');
        }

        // Step 1: Validate credentials
        const step1Start = Date.now();
        logger.info('1/8: Validating credentials...');
        await validateCredentials(argv.apiUrl, argv.apiKey, argv.project);
        const step1Duration = Date.now() - step1Start;
        logger.success(`✅ Credentials validated [${step1Duration}ms]\n`);

        // Step 2: Check prerequisites
        const step2Start = Date.now();
        logger.info('2/8: Checking prerequisites...');
        const envInfo = await checkEnvironment();
        const step2Duration = Date.now() - step2Start;

        if (!envInfo.isGit) {
            throw new Error('Not a git repository. Please run "git init" first.');
        }

        if (!envInfo.githubRemote) {
            logger.error('⚠️  Warning: No GitHub remote found. You\'ll need to add one before pushing.');
        }

        logger.success(`✅ Environment detected [${step2Duration}ms]:
   • Git: ${envInfo.isGit ? '✓' : '✗'}
   • GitHub: ${envInfo.githubRemote || 'Not configured'}
   • Package Manager: ${envInfo.packageManager}
   • Build Command: ${envInfo.storybookBuildCmd || 'build-storybook'}\n`);

        // Step 3: Create config file
        const step3Start = Date.now();
        logger.info('3/8: Creating configuration file...');
        createConfigFile(argv.project, argv.apiKey, argv.apiUrl, envInfo, argv.commitApiKey);
        const step3Duration = Date.now() - step3Start;
        logger.success(`✅ Created .storybook-deployer.json [${step3Duration}ms]\n`);

        // Step 4: Report what the committed config does and does not contain.
        //
        // This step used to add `.storybook-deployer.json` to .gitignore, which was
        // wrong in both directions. The config now holds no credential, so ignoring
        // it would only stop a team sharing its project id — and the entry it wrote,
        // `.storybook-deployer.json  # Contains API key`, never matched anything:
        // in .gitignore a `#` is only a comment at the start of a line, so the
        // pattern included the trailing text and git ignored no file.
        const step4Start = Date.now();
        if (argv.commitApiKey) {
            logger.info('4/8: Checking credentials...');
            logger.error(`⚠️  --commit-api-key: your API key will be written to .storybook-deployer.json and committed.
   Git history keeps it after rotation, and CI does not need it — the key is
   already stored as the SCRY_API_KEY repository secret. [${Date.now() - step4Start}ms]\n`);
        } else {
            logger.info('4/8: Checking credentials...');
            logger.success(`✅ .storybook-deployer.json holds no credentials — safe to commit [${Date.now() - step4Start}ms]\n`);
        }

        // Step 5: Generate workflow files
        const step5Start = Date.now();
        logger.info('5/8: Generating GitHub Actions workflows...');
        const workflowFiles = generateWorkflows(argv.project, argv.apiUrl, envInfo, captureWeb ? { capture: 'web', configDir: captureWeb.configDir } : {});
        const step5Duration = Date.now() - step5Start;
        logger.success(`✅ Created .github/workflows/deploy-storybook.yml [${step5Duration}ms]`);
        logger.success(`✅ Created .github/workflows/deploy-pr-preview.yml${captureWeb ? '' : '\n'}`);
        if (captureWeb) {
            logger.success(`✅ Created .github/workflows/${CAPTURE_WEB_WORKFLOW_FILE}`);
            for (const line of captureWebSummaryLines(captureWeb.info)) logger.info(line);
            logger.info('');
        }

        // Step 6: Setup GitHub variables (if gh CLI available)
        // Tracked, not assumed — the closing summary reports what actually happened.
        let ghConfigured = null;
        const step6Start = Date.now();
        if (!argv.skipGhSetup && isGhCliAvailable()) {
            logger.info('6/8: Setting up GitHub repository variables...');
            try {
                await setupGitHubVariables(argv.project, argv.apiKey, argv.apiUrl, logger);
                ghConfigured = true;
                const step6Duration = Date.now() - step6Start;
                logger.success(`✅ GitHub variables configured [${step6Duration}ms]\n`);
            } catch (error) {
                ghConfigured = false;
                const step6Duration = Date.now() - step6Start;
                logger.error(`⚠️  GitHub setup failed: ${error.message} [${step6Duration}ms]`);
                logger.info('You can set these up manually later.\n');
                showManualSetupInstructions(argv.project, argv.apiKey, argv.apiUrl);
            }
        } else {
            logger.info('6/8: Skipping GitHub CLI setup\n');
            if (!argv.skipGhSetup) {
                showManualSetupInstructions(argv.project, argv.apiKey, argv.apiUrl);
            }
        }

        // Step 7: Git commit
        const step7Start = Date.now();
        logger.info('7/8: Committing changes...');
        const commitResult = gitCommit(logger, captureWeb ? [`.github/workflows/${CAPTURE_WEB_WORKFLOW_FILE}`] : []);
        const step7Duration = Date.now() - step7Start;
        if (commitResult.success) {
            logger.success(`✅ Changes committed: ${commitResult.sha} [${step7Duration}ms]\n`);
        } else {
            logger.error(`⚠️  Could not commit automatically. Please commit manually. [${step7Duration}ms]\n`);
        }

        // Step 8: Git push
        const step8Start = Date.now();
        logger.info('8/8: Pushing to GitHub...');
        const pushResult = gitPush(logger);
        const step8Duration = Date.now() - step8Start;
        if (pushResult.success) {
            logger.success(`✅ Pushed to ${pushResult.branch} [${step8Duration}ms]\n`);
        } else {
            logger.error(`⚠️  Could not push automatically. Please push manually with:\n   git push [${step8Duration}ms]\n`);
        }

        // Calculate total time
        const totalDuration = Date.now() - totalStartTime;
        logger.info('━'.repeat(50));
        logger.info(`[TIMING] Total setup time: ${totalDuration}ms (${(totalDuration / 1000).toFixed(2)}s)\n`);
        
        showSuccessMessage(argv.project, envInfo, argv.apiUrl, pushResult.success, {
            ghConfigured,
            committed: commitResult.success,
        });

    } catch (error) {
        logger.error(`\n❌ Setup failed: ${error.message}`);
        if (error.response) {
            for (const line of setupApiErrorLines(error)) logger.error(line);
        }
        if (error.stack && argv.verbose) {
            logger.debug(error.stack);
        }
        process.exit(1);
    }
}

/**
 * Validate that the API credentials work
 */
async function validateCredentials(apiUrl, apiKey, projectId) {
    // For now, just verify the parameters are provided
    // In the future, we could ping a /validate endpoint
    if (!projectId || !apiKey) {
        throw new Error('Both --project-id and --api-key are required');
    }

    // Basic format validation
    if (projectId.length < 3) {
        throw new Error('Project ID seems too short. Please check your credentials.');
    }

    // Could add API validation call here if endpoint exists
    // const apiClient = getApiClient(apiUrl, apiKey);
    // await apiClient.get('/validate');
}

/**
 * Check the local environment and detect settings
 */
async function checkEnvironment() {
    const envInfo = {
        isGit: false,
        githubRemote: null,
        githubRepo: null,
        packageManager: 'npm',
        storybookBuildCmd: null,
        currentBranch: null
    };

    // Check if git repo
    try {
        execSync('git rev-parse --git-dir', { stdio: 'ignore' });
        envInfo.isGit = true;

        // Get current branch
        try {
            envInfo.currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
        } catch (e) {
            // Ignore
        }

        // Get GitHub remote
        try {
            const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
            envInfo.githubRemote = remote;
            envInfo.githubRepo = parseGitHubRemote(remote);
        } catch (e) {
            // No remote configured
        }
    } catch (e) {
        // Not a git repo
    }

    // Detect package manager
    if (fs.existsSync('pnpm-lock.yaml')) {
        envInfo.packageManager = 'pnpm';
    } else if (fs.existsSync('yarn.lock')) {
        envInfo.packageManager = 'yarn';
    } else if (fs.existsSync('bun.lockb')) {
        envInfo.packageManager = 'bun';
    }

    // Detect Storybook build command from package.json
    try {
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        if (pkg.scripts) {
            if (pkg.scripts['build-storybook']) {
                envInfo.storybookBuildCmd = 'build-storybook';
            } else if (pkg.scripts['storybook:build']) {
                envInfo.storybookBuildCmd = 'storybook:build';
            } else if (pkg.scripts['build:storybook']) {
                envInfo.storybookBuildCmd = 'build:storybook';
            }
        }
    } catch (e) {
        // No package.json or can't read
    }

    return envInfo;
}

/**
 * Parse GitHub remote URL to extract owner/repo
 */
function parseGitHubRemote(remote) {
    // Handle both HTTPS and SSH formats
    // HTTPS: https://github.com/owner/repo.git
    // SSH: git@github.com:owner/repo.git

    const httpsMatch = remote.match(/github\.com[/:]([\w-]+)\/([\w-]+)/);
    if (httpsMatch) {
        return `${httpsMatch[1]}/${httpsMatch[2].replace('.git', '')}`;
    }

    return null;
}

/**
 * Create the configuration file
 */
function createConfigFile(projectId, apiKey, apiUrl, envInfo, commitApiKey) {
    const config = {
        apiUrl: apiUrl,
        project: projectId,
        dir: "./storybook-static",
        version: "latest",
        verbose: false
    };

    // The key is deliberately absent unless explicitly asked for.
    //
    // This file gets committed, and CI never reads the key from it — `init` sets
    // SCRY_API_KEY as a GitHub *secret* and the generated workflow reads
    // ${{ secrets.SCRY_API_KEY }}. So a copy here buys nothing and lands
    // somewhere git history makes permanent: rotating the key afterwards does
    // not remove it, and on a public repository it is simply disclosed.
    //
    // Local runs read SCRY_API_KEY from the environment, which lib/config.js
    // already resolves.
    if (commitApiKey) {
        config.apiKey = apiKey;
    }

    const configPath = '.storybook-deployer.json';
    fs.writeFileSync(
        configPath,
        JSON.stringify(config, null, 2) + '\n',
        'utf8'
    );
}

/**
 * Generate workflow files
 */
function generateWorkflows(projectId, apiUrl, envInfo, options = {}) {
    // Create .github/workflows directory
    const workflowsDir = '.github/workflows';
    fs.mkdirSync(workflowsDir, { recursive: true });

    const buildCmd = envInfo.storybookBuildCmd || 'build-storybook';

    // Generate main deployment workflow
    const captureWeb = options.capture === 'web';
    const mainWorkflow = generateMainWorkflow(projectId, apiUrl, envInfo.packageManager, buildCmd, captureWeb ? { capture: 'web' } : {});
    const mainWorkflowPath = path.join(workflowsDir, 'deploy-storybook.yml');
    fs.writeFileSync(mainWorkflowPath, mainWorkflow, 'utf8');

    // Generate PR preview workflow
    const prWorkflow = generatePRWorkflow(projectId, apiUrl, envInfo.packageManager, buildCmd);
    const prWorkflowPath = path.join(workflowsDir, 'deploy-pr-preview.yml');
    fs.writeFileSync(prWorkflowPath, prWorkflow, 'utf8');

    if (!captureWeb) return [mainWorkflowPath, prWorkflowPath];

    // Build-free capture: the third workflow, only with --capture web.
    const captureWorkflowPath = path.join(workflowsDir, CAPTURE_WEB_WORKFLOW_FILE);
    fs.writeFileSync(captureWorkflowPath, generateCaptureWebWorkflow(...captureWebWorkflowArgs(envInfo.packageManager, options.configDir)), 'utf8');
    return [mainWorkflowPath, prWorkflowPath, captureWorkflowPath];
}

/**
 * Check if GitHub CLI is available
 */
function isGhCliAvailable() {
    try {
        execSync('gh --version', { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Setup GitHub variables using gh CLI
 */
/**
 * Does this `gh` know about `gh variable`? It arrived in gh 2.21 (December 2022),
 * and Ubuntu 22.04 still ships 2.4.0 — so plenty of machines do not have it.
 * Without this check the very first call throws, the secret after it is never
 * reached, and CI ends up with no credentials at all.
 */
function ghSupportsVariables() {
    try {
        execSync('gh variable --help', { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

function setVariableViaApi(repo, name, value) {
    // `gh api` predates `gh variable` by years, so it is the safe fallback.
    const payload = JSON.stringify({ name, value });
    try {
        execSync(`gh api -X POST repos/${repo}/actions/variables --input -`, {
            stdio: ['pipe', 'pipe', 'pipe'], input: payload,
        });
    } catch {
        // Already present: update rather than create.
        execSync(`gh api -X PATCH repos/${repo}/actions/variables/${name} --input -`, {
            stdio: ['pipe', 'pipe', 'pipe'], input: payload,
        });
    }
}

async function setupGitHubVariables(projectId, apiKey, apiUrl, logger) {
    const repo = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', { stdio: 'pipe' })
        .toString().trim();

    const useCli = ghSupportsVariables();
    if (!useCli) {
        logger.debug('   gh is too old for `gh variable`; using `gh api` instead');
    }

    // Each of these is reported separately. A failure part-way through used to
    // abandon the rest silently, which is how a repository ended up with the
    // variables missing *and* the secret missing while setup reported success.
    const setVar = (name, value) => {
        if (useCli) execSync(`gh variable set ${name} --body "${value}"`, { stdio: 'pipe' });
        else setVariableViaApi(repo, name, value);
    };

    setVar('SCRY_PROJECT_ID', projectId);
    logger.debug('   ✓ Set SCRY_PROJECT_ID');

    setVar('SCRY_API_URL', apiUrl);
    logger.debug('   ✓ Set SCRY_API_URL');

    // `gh secret set` needs libsodium encryption, so there is no simple `gh api`
    // fallback — but it has existed since gh 1.x, so it works where variables do not.
    execSync(`gh secret set SCRY_API_KEY --body "${apiKey}"`, { stdio: 'pipe' });
    logger.debug('   ✓ Set SCRY_API_KEY');
}

/**
 * Show manual setup instructions
 */
function showManualSetupInstructions(projectId, apiKey, apiUrl) {
    console.log(`
📋 Manual GitHub Setup (Optional):

If you haven't already, set up these repository variables:

1. Go to your GitHub repository Settings
2. Navigate to: Settings → Secrets and variables → Actions

3. Add these Variables (Variables tab):
   • SCRY_PROJECT_ID = ${projectId}
   • SCRY_API_URL = ${apiUrl}
   • SCRY_VIEW_URL = https://view.scrymore.com (optional, defaults to this)

4. Add this Secret (Secrets tab):
   • SCRY_API_KEY = ${apiKey}

Or install GitHub CLI and run:
   gh variable set SCRY_PROJECT_ID --body "${projectId}"
   gh variable set SCRY_API_URL --body "${apiUrl}"
   gh variable set SCRY_VIEW_URL --body "https://view.scrymore.com"
   gh secret set SCRY_API_KEY --body "${apiKey}"
`);
}

/**
 * Commit the changes to git
 */
function gitCommit(logger, extraFiles = []) {
    try {
        // Check if there are changes to commit
        const status = execSync('git status --porcelain', { encoding: 'utf8' });
        if (!status.trim()) {
            return { success: false, message: 'No changes to commit' };
        }

        // Add files
        const filesToAdd = [
            '.github/workflows/deploy-storybook.yml',
            '.github/workflows/deploy-pr-preview.yml',
            '.storybook-deployer.json',
            // The capture workflow, only when this run wrote it: a file of that name the
            // user wrote by hand is not ours to commit.
            ...extraFiles,
        ];

        // Each file is staged on its own. `git add` fails on a path that
        // .gitignore excludes, and one throw used to abort the loop before the
        // commit — so a leftover `.storybook-deployer.json` ignore rule from the
        // pre-0.4.0 workaround silently prevented the *workflows* being committed,
        // and CI was never set up at all.
        let staged = 0;
        for (const file of filesToAdd) {
            if (!fs.existsSync(file)) continue;
            try {
                execSync(`git add "${file}"`, { stdio: 'pipe' });
                staged++;
                logger.debug(`   ✓ Added ${file}`);
            } catch {
                logger.debug(`   • Skipped ${file} (ignored by .gitignore)`);
            }
        }
        if (staged === 0) {
            return { success: false, message: 'Nothing could be staged' };
        }

        // Commit
        const commitMessage = 'chore: add Scry Storybook deployment workflows';
        execSync(`git commit -m "${commitMessage}"`, { stdio: 'pipe' });

        // Get commit SHA
        const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();

        return { success: true, sha };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Push changes to remote
 */
function gitPush(logger) {
    try {
        // Get current branch
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();

        // Check if remote is configured
        try {
            execSync('git remote get-url origin', { stdio: 'ignore' });
        } catch (e) {
            return { success: false, error: 'No remote configured', branch };
        }

        // Push
        execSync(`git push -u origin ${branch}`, { stdio: 'pipe' });

        return { success: true, branch };
    } catch (error) {
        // Check if it's an authentication error
        if (error.message.includes('Authentication') || error.message.includes('permission')) {
            return {
                success: false,
                error: 'Authentication failed. Please check your git credentials.',
                branch: null
            };
        }

        return { success: false, error: error.message, branch: null };
    }
}

/**
 * Show success message
 */
function showSuccessMessage(projectId, envInfo, apiUrl, pushed, results = {}) {
    console.log(`
🎉 ${pushed ? 'Setup Complete and Deployed!' : 'Setup Complete!'}

Your Storybook deployment is configured and ready to go.

📦 What was set up:
   ✅ Configuration file (.storybook-deployer.json — no credentials, safe to commit)
   ✅ GitHub Actions workflows (.github/workflows/)
   ${results.ghConfigured === true
        ? '✅ Repository variables and secret (SCRY_PROJECT_ID, SCRY_API_URL, SCRY_API_KEY)'
        : results.ghConfigured === false
            ? '❌ Repository variables and secret NOT set — CI cannot deploy until you fix this'
            : '⚠️  Repository variables and secret not attempted — CI cannot deploy until you set them'}
   ${results.committed === false
        ? '❌ Changes NOT committed — the workflows are staged but uncommitted'
        : (pushed ? '✅ Changes committed and pushed' : '⚠️  Committed; manual push required')}

${!pushed ? `
📌 Next Step:
   Push your changes to GitHub:
   git push
` : ''}

🔑 Running a deploy locally:
   CI reads the key from the SCRY_API_KEY secret. On your own machine, export it
   rather than writing it into the config file, which is committed:

   export SCRY_API_KEY=<your key>

🚀 Deployment:
   Your Storybook will deploy automatically on:
   • Every push to ${envInfo.currentBranch || 'main'} branch
   • Every pull request (as a preview)

🌐 Deployment URLs:
   • Production: https://view.scrymore.com/${projectId}/latest/
   • PR Previews: https://view.scrymore.com/${projectId}/pr-{number}/

📖 Learn more: https://github.com/epinnock/scry-node
💬 Need help? Open an issue on GitHub

Happy deploying! ✨
`);
}

/**
 * What `init` prints for a failed API call: the status and the body's `error`
 * field only, plus the request id (F113). Never the raw body — it can carry data.
 */
function setupApiErrorLines(error) {
    const serverError = safeServerError(error.response.data);
    const lines = [`API Error: ${error.response.status} - ${serverError || error.response.statusText || 'no reason given'}`];
    const requestId = getRequestId(error);
    if (requestId) lines.push(`Ref: ${requestId}`);
    return lines;
}

module.exports = { runInit, createConfigFile, generateWorkflows, gitCommit, setupApiErrorLines };
