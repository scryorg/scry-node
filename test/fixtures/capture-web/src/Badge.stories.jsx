import { Badge } from './Badge';

// No title on purpose: Storybook derives "Badge" from the file path (auto-title).
export default { component: Badge };

export const Default = { args: { children: 'New' } };

export const Blank = { render: () => null };
