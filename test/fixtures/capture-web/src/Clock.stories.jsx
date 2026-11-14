/** Reads the clock, storage, cookies, scroll position and focus at render time. */
function Clock() {
  const leak = window.localStorage.getItem('scry-fixture-leak') || window.sessionStorage.getItem('scry-fixture-leak');
  const cookie = document.cookie.includes('scry_fixture_leak');
  return (
    <dl>
      <dt>Now</dt>
      <dd data-testid="now">{new Date().toISOString()}</dd>
      <dt>Storage</dt>
      <dd data-testid="storage">{leak || cookie ? 'storage: dirty' : 'storage: clean'}</dd>
      <dt>Scroll</dt>
      <dd data-testid="scroll">scrollY: {Math.round(window.scrollY)}</dd>
    </dl>
  );
}

export default { title: 'Widgets/Clock', component: Clock };

export const Now = {};
