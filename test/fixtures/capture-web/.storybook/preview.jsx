import './preview.css';

/** @type {import('@storybook/react-vite').Preview} */
export default {
  parameters: { layout: 'padded' },
  initialGlobals: { theme: 'light' },
  decorators: [
    (Story, context) => (
      <div data-theme={context.globals.theme || 'light'} className="fixture-frame">
        <Story />
      </div>
    ),
  ],
};
