/** `capture web`: the declared story list (ids from Storybook's index, line and component from the file). */
const path = require('path');
const { scanStoryFile, buildDeclared, resolveComponentFile } = require('../lib/capture/web/csf-meta.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'capture-web');

const SOURCE = `import type { Meta, StoryObj } from '@storybook/react';
import { within } from 'storybook/test';
import { Button as Btn, type ButtonProps } from './Button';
import Card from "../card/Card";
import * as Icons from './icons';

// export const Commented = {};
const meta = {
  title: 'Components/Button',
  component: Btn,
} satisfies Meta<typeof Btn>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { label: 'Save' } };

export const WithCard = {
  render: () => <Card />,
};
export function Legacy() { return null; }
const Hidden: Story = {};
const Renamed: Story = {};
export { Hidden, Renamed as Public };
`;

describe('scanStoryFile', () => {
    const scan = scanStoryFile(SOURCE);

    test('finds the line of each story export (an export list points at the declaration)', () => {
        expect(scan.exports.Primary).toBe(16);
        expect(scan.exports.WithCard).toBe(18);
        expect(scan.exports.Legacy).toBe(21);
        expect(scan.exports.Hidden).toBe(22);
        expect(scan.exports.Public).toBe(23);
        expect(scan.exports.Commented).toBeUndefined();
    });

    test('finds the component and where it is imported from', () => {
        expect(scan.component).toBe('Button');
        expect(scan.componentImport).toBe('./Button');
    });

    test('default import and inline default export', () => {
        const s = scanStoryFile("import Card from '../card/Card';\nexport default { title: 'X', component: Card };\nexport const A = {};\n");
        expect(s.component).toBe('Card');
        expect(s.componentImport).toBe('../card/Card');
        expect(s.exports.A).toBe(3);
    });

    test('no component, member expression component, CRLF', () => {
        expect(scanStoryFile("export default { title: 'X' };\r\nexport const A = {};\r\n")).toMatchObject({ component: null, componentImport: null, exports: { A: 2 } });
        const s = scanStoryFile("import * as UI from './ui';\nexport default { component: UI.Button };\n");
        expect(s.component).toBe('Button');
        expect(s.componentImport).toBe('./ui');
    });
});

describe('resolveComponentFile', () => {
    test('relative import resolved against the story file, with the extension found on disk', () => {
        const story = path.join(FIXTURE, 'src', 'Button.stories.jsx');
        expect(resolveComponentFile(story, './Button', FIXTURE)).toBe('src/Button.jsx');
        expect(resolveComponentFile(story, './Missing', FIXTURE)).toBeNull();
        expect(resolveComponentFile(story, 'some-package', FIXTURE)).toBeNull();
        expect(resolveComponentFile(story, '../../../../package.json', FIXTURE)).toBeNull();
    });
});

describe('buildDeclared', () => {
    const entries = {
        'components-button--primary': { type: 'story', id: 'components-button--primary', title: 'Components/Button', name: 'Primary', importPath: './src/Button.stories.jsx', exportName: 'Primary', tags: ['dev', 'test', 'brand'] },
        'badge--default': { type: 'story', id: 'badge--default', title: 'Badge', name: 'Default', importPath: './src/Badge.stories.jsx', exportName: 'Default', componentPath: './src/Badge.jsx', tags: ['dev', 'test'] },
        'badge--docs': { type: 'docs', id: 'badge--docs', title: 'Badge', name: 'Docs', importPath: './src/Badge.stories.jsx', tags: ['autodocs'] },
        'components-skipped--hidden': { type: 'story', id: 'components-skipped--hidden', title: 'Components/Skipped', name: 'Hidden', importPath: './src/Skipped.stories.jsx', exportName: 'Hidden_', tags: [] },
    };
    const declared = buildDeclared(entries, { projectDir: FIXTURE });

    test('stories only, sorted by id, with file, line and component', () => {
        expect(declared.map((d) => d.id)).toEqual(['badge--default', 'components-button--primary', 'components-skipped--hidden']);
        expect(declared[1]).toEqual({
            id: 'components-button--primary',
            title: 'Components/Button',
            name: 'Primary',
            exportName: 'Primary',
            file: 'src/Button.stories.jsx',
            line: 11,
            component: 'Button',
            componentFile: 'src/Button.jsx',
            tags: ['dev', 'test', 'brand'],
        });
    });

    test("Storybook's componentPath wins; a missing export name falls back to the id's name", () => {
        expect(declared[0]).toMatchObject({ file: 'src/Badge.stories.jsx', componentFile: 'src/Badge.jsx', component: 'Badge', line: 6 });
        expect(declared[2]).toMatchObject({ exportName: 'Hidden_', line: 7, component: 'Hidden', componentFile: null });
    });

    test('an unreadable story file still yields an entry (no line, no component)', () => {
        const d = buildDeclared({ x: { type: 'story', id: 'x--y', title: 'X', name: 'Y', importPath: './gone.stories.jsx', exportName: 'Y' } }, { projectDir: FIXTURE });
        expect(d).toEqual([{ id: 'x--y', title: 'X', name: 'Y', exportName: 'Y', file: 'gone.stories.jsx', line: null, component: null, componentFile: null, tags: [] }]);
    });
});
