/** @type {import('@storybook/react-vite').StorybookConfig} */
export default {
  stories: ['../src/**/*.stories.@(js|jsx)'],
  addons: [],
  framework: { name: '@storybook/react-vite', options: {} },
  staticDirs: [{ from: '../static', to: '/assets' }],
  core: { disableTelemetry: true },
};
