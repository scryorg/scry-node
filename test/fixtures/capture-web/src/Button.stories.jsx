import { Button } from './Button';

export default {
  title: 'Components/Button',
  component: Button,
  tags: ['brand'],
  parameters: { scry: { fields: { team: 'core' } } },
};

/** Leaves storage and a cookie behind: the next story on the same page must not see them. */
export const Primary = {
  args: { label: 'Save changes' },
  play: async () => {
    window.localStorage.setItem('scry-fixture-leak', 'dirty');
    window.sessionStorage.setItem('scry-fixture-leak', 'dirty');
    document.cookie = 'scry_fixture_leak=dirty; path=/';
  },
};

export const Secondary = {
  args: { label: 'Cancel', variant: 'secondary' },
  globals: { theme: 'dark' },
};

export const Mobile = {
  args: { label: 'Tap me' },
  tags: ['phone'],
  parameters: { scry: { capture: { viewport: { width: 375, height: 667 } }, fields: { surface: 'mobile' } } },
};
