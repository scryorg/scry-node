import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

/** "Still loading… N s": shown once a wait has run for a second, counted from Date.now() like most elapsed clocks. */
function ElapsedTimer() {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - startedAt);
  return (
    <p>
      Loading…
      {elapsed >= 1000 && <span data-testid="elapsed"> {Math.floor(elapsed / 1000)} s</span>}
    </p>
  );
}

/** A filter box that is disabled while its list loads (a timer), then echoes what was typed. */
function FilterBox() {
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setLoading(false), 200);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div>
      <label htmlFor="filter">Filter</label>
      <input id="filter" type="search" value={text} disabled={loading} onChange={(e) => setText(e.target.value)} />
      <output data-testid="typed">typed: {text}</output>
    </div>
  );
}

export default { title: 'Widgets/Waits' };

/** The play function waits for the elapsed clock: it must see time pass. */
export const ElapsedClock = {
  render: () => <ElapsedTimer />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByTestId('elapsed', {}, { timeout: 4000 });
  },
};

/**
 * The page's timers must be the browser's own. A fake timer layer (Playwright's clock) stopped
 * `userEvent.type` from dispatching any event in a dashboard story, so this guards the cause.
 */
export const NativeTimers = {
  render: () => <p>Timers are the browser's own.</p>,
  play: async () => {
    const isNative = (fn) => /\[native code\]/.test(Function.prototype.toString.call(fn));
    await expect({
      setTimeout: isNative(window.setTimeout),
      setInterval: isNative(window.setInterval),
      requestAnimationFrame: isNative(window.requestAnimationFrame),
      performanceNow: isNative(window.performance.now),
    }).toEqual({ setTimeout: true, setInterval: true, requestAnimationFrame: true, performanceNow: true });
  },
};

/** The play function types into a box that becomes enabled after a timer. */
export const TypeAfterLoad = {
  render: () => <FilterBox />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByRole('searchbox', { name: 'Filter' });
    await waitFor(() => expect(box).toBeEnabled());
    await userEvent.type(box, 'a');
    await waitFor(() => expect(canvas.getByTestId('typed')).toHaveTextContent('typed: a'));
  },
};
