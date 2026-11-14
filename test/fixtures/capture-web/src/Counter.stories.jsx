import { expect, userEvent, within } from 'storybook/test';
import { Counter } from './Counter';

export default { title: 'Components/Counter', component: Counter };

export const Clicked = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Add one' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Add one' }));
    await expect(canvas.getByTestId('count')).toHaveTextContent('Count: 2');
  },
};
