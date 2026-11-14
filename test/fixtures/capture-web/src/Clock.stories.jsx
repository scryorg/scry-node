/** Reads the clock, storage, cookies, scroll position, title and address at render time; the loader counts databases and caches. */
function Clock({ databases, caches }) {
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
      <dt>Page</dt>
      <dd data-testid="title">{document.title === 'dirty title' ? 'title: dirty' : 'title: clean'}</dd>
      <dd data-testid="address">{window.location.hash ? 'address: dirty' : 'address: clean'}</dd>
      <dd data-testid="databases">databases: {databases}</dd>
      <dd data-testid="caches">caches: {caches}</dd>
    </dl>
  );
}

export default { title: 'Widgets/Clock', component: Clock };

export const Now = {
  loaders: [
    async () => ({
      databases: window.indexedDB.databases ? (await window.indexedDB.databases()).length : 0,
      caches: window.caches ? (await window.caches.keys()).length : 0,
    }),
  ],
  render: (args, { loaded }) => <Clock databases={loaded.databases} caches={loaded.caches} />,
};
