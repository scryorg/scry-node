import { within } from 'storybook/test';

/** Taller than the viewport; the play function scrolls to the bottom, focuses the field there and leaves page state behind. */
function Bigpage() {
  return (
    <div style={{ width: 600 }}>
      <h1>Top of a long page</h1>
      <div style={{ height: 2400, background: 'linear-gradient(#dbeafe, #1e3a8a)' }} />
      <input aria-label="Bottom field" placeholder="bottom field" />
    </div>
  );
}

export default { title: 'Screens/Bigpage', component: Bigpage, parameters: { layout: 'fullscreen' } };

export const Scrolled = {
  play: async ({ canvasElement }) => {
    const field = within(canvasElement).getByLabelText('Bottom field');
    field.scrollIntoView();
    field.focus();
    // State a later story on the same page must not see.
    document.title = 'dirty title';
    window.history.pushState(null, '', '#dirty');
    await new Promise((resolve) => {
      const open = window.indexedDB.open('scry-fixture-leak', 1);
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => resolve();
    });
    if (window.caches) await window.caches.open('scry-fixture-leak');
  },
};
