import { expect, within } from 'storybook/test';

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Sent N d ago" for a date written into the story, like the dashboard's invite and activity rows. */
function SentCue({ sentAt }) {
  const ago = Date.now() - Date.parse(sentAt);
  return <p data-testid="sent">{ago >= 0 ? `Sent ${Math.floor(ago / DAY_MS)} d ago` : 'Not sent yet'}</p>;
}

/** "Sent N min ago", for args a story computes from `Date.now()` when its file loads. */
function SentMinutes({ sentAt }) {
  return <p data-testid="sent">Sent {Math.floor((Date.now() - Date.parse(sentAt)) / 60000)} min ago</p>;
}

export default { title: 'Widgets/Dates', component: SentCue };

/** Args from `Date.now()` at import: the clock must not step back between import and render. */
export const SentFourMinutesAgo = {
  args: { sentAt: new Date(Date.now() - 4 * 60_000).toISOString() },
  render: (args) => <SentMinutes {...args} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('sent')).toHaveTextContent('Sent 4 min ago');
  },
};

/** A story whose own dates are from 2026: the capture's "now" must not be older than them. */
export const SentLastMonth = {
  render: () => <SentCue sentAt="2026-10-01T12:00:00.000Z" />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('sent')).toHaveTextContent(/^Sent \d+ d ago$/);
  },
};
