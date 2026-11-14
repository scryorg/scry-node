/** `capture web --changed-since`: which story files a change reaches (no browser, no git). */
const path = require('path');
const { isGlobalChange, selectAffected, changedFiles, toProjectRelative } = require('../lib/capture/web/affected.js');

const recorded = require('./fixtures/capture-web-affected/dashboard-f95219c5.json');

describe('selectAffected on a small graph', () => {
    const graph = {
        'src/Button.stories.tsx': ['src/Button.stories.tsx', 'src/Button.tsx', 'src/theme.ts'],
        'src/Card.stories.tsx': ['src/Card.stories.tsx', 'src/Card.tsx', 'src/Button.tsx', 'src/theme.ts'],
        'src/Icon.stories.tsx': ['src/Icon.stories.tsx', 'src/Icon.tsx', '../shared/icons.ts'],
    };
    const select = (changed, extra = {}) => selectAffected({ graph, previewInputs: ['.storybook/preview.tsx', 'src/globals.css'], changedFiles: changed, configDirRel: '.storybook', ...extra });

    test('a story file itself', () => {
        expect(select(['src/Card.stories.tsx'])).toEqual({ global: false, reason: null, files: ['src/Card.stories.tsx'] });
    });

    test('a module some stories import', () => {
        expect(select(['src/Button.tsx']).files).toEqual(['src/Button.stories.tsx', 'src/Card.stories.tsx']);
        expect(select(['src/Icon.tsx', 'README.md']).files).toEqual(['src/Icon.stories.tsx']);
    });

    test('a file outside the project that a story imports', () => {
        expect(select(['../shared/icons.ts']).files).toEqual(['src/Icon.stories.tsx']);
    });

    test('nothing relevant: nothing selected', () => {
        expect(select(['README.md', 'docs/x.md'])).toEqual({ global: false, reason: null, files: [] });
        expect(select([])).toEqual({ global: false, reason: null, files: [] });
    });

    test('a deleted file that no longer appears in the graph selects nothing by itself', () => {
        expect(select(['src/Gone.tsx']).files).toEqual([]);
    });

    test.each([
        ['.storybook/main.ts', /Storybook config/],
        ['.storybook/preview.tsx', /Storybook config/],
        ['src/globals.css', /preview/],
        ['package.json', /package\.json/],
        ['pnpm-lock.yaml', /pnpm-lock\.yaml/],
        ['../../pnpm-lock.yaml', /pnpm-lock\.yaml/],
        ['../../package.json', /package\.json/],
        ['yarn.lock', /yarn\.lock/],
        ['tsconfig.json', /tsconfig\.json/],
        ['tsconfig.app.json', /tsconfig\.app\.json/],
        ['vite.config.mts', /vite\.config\.mts/],
        ['tailwind.config.js', /tailwind\.config\.js/],
        ['postcss.config.cjs', /postcss\.config\.cjs/],
        ['next.config.mjs', /next\.config\.mjs/],
    ])('%s is a global change: every story file', (file, reason) => {
        const out = select(['src/Icon.tsx', file]);
        expect(out.global).toBe(true);
        expect(out.reason).toMatch(reason);
        expect(out.files).toEqual(Object.keys(graph).sort());
    });

    test('files that only look global are not', () => {
        expect(isGlobalChange('src/package.json.ts', { configDirRel: '.storybook', previewInputs: [] })).toBeNull();
        expect(isGlobalChange('docs/vite.config.md', { configDirRel: '.storybook', previewInputs: [] })).toBeNull();
        expect(isGlobalChange('.storybook-other/main.ts', { configDirRel: '.storybook', previewInputs: [] })).toBeNull();
        expect(isGlobalChange('packages/other/package.json', { configDirRel: '.storybook', previewInputs: [] })).toBeNull();
    });
});

describe('selectAffected on the recorded dashboard commits (plan row 10)', () => {
    test('the recording holds 171 story files', () => {
        expect(Object.keys(recorded.graph)).toHaveLength(171);
    });

    test.each(recorded.cases.map((c) => [c.commit, c.expectedFiles, c]))('commit %s reaches %i story files', (_commit, expected, c) => {
        const out = selectAffected({ graph: recorded.graph, previewInputs: recorded.previewInputs, changedFiles: c.changed, configDirRel: recorded.configDir });
        expect(out.files).toHaveLength(expected);
        expect(out.global).toBe(expected === 171);
        for (const f of out.files) expect(recorded.graph[f]).toBeDefined();
    });
});

describe('changedFiles', () => {
    const fakeGit = (answers) => {
        const calls = [];
        const exec = (args) => {
            calls.push(args.join(' '));
            const key = Object.keys(answers).find((k) => args.join(' ').startsWith(k));
            if (!key) throw new Error(`unexpected git ${args.join(' ')}`);
            if (answers[key] instanceof Error) throw answers[key];
            return answers[key];
        };
        return { exec, calls };
    };

    test('diff against the ref plus untracked files, repo-relative, deduped and sorted', () => {
        const git = fakeGit({
            'rev-parse --show-toplevel': '/repo\n',
            'diff --no-ext-diff --name-only -z origin/main --': 'apps/web/src/b.ts\0apps/web/src/a.ts\0',
            'ls-files --others --exclude-standard -z': 'apps/web/src/new.ts\0apps/web/src/a.ts\0',
        });
        expect(changedFiles('origin/main', { cwd: '/repo/apps/web', exec: git.exec })).toEqual({
            repoRoot: '/repo',
            files: ['apps/web/src/a.ts', 'apps/web/src/b.ts', 'apps/web/src/new.ts'],
        });
    });

    test('a range A..B is a diff between two commits: untracked files are not added', () => {
        const git = fakeGit({ 'rev-parse --show-toplevel': '/repo\n', 'diff --no-ext-diff --name-only -z abc..def --': 'x.ts\0' });
        expect(changedFiles('abc..def', { cwd: '/repo', exec: git.exec }).files).toEqual(['x.ts']);
        expect(git.calls.some((c) => c.startsWith('ls-files'))).toBe(false);
    });

    test('an unknown ref is a clear error; an option-looking ref never reaches git', () => {
        const git = fakeGit({ 'rev-parse --show-toplevel': '/repo\n', 'diff --no-ext-diff --name-only -z nope --': new Error('fatal: bad revision') });
        expect(() => changedFiles('nope', { cwd: '/repo', exec: git.exec })).toThrow(/--changed-since nope/);
        expect(() => changedFiles('--output=/tmp/x', { cwd: '/repo', exec: git.exec })).toThrow(/--changed-since/);
    });

    test('toProjectRelative', () => {
        expect(toProjectRelative('apps/web/src/a.ts', '/repo', '/repo/apps/web')).toBe('src/a.ts');
        expect(toProjectRelative('pnpm-lock.yaml', '/repo', '/repo/apps/web')).toBe('../../pnpm-lock.yaml');
        expect(toProjectRelative('a.ts', '/repo', '/repo')).toBe('a.ts');
        expect(toProjectRelative(path.join('packages', 'ui', 'b.ts'), '/repo', '/repo/apps/web')).toBe('../../packages/ui/b.ts');
    });
});
