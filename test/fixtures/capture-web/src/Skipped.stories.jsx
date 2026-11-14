function Hidden() {
  return <p>Never captured</p>;
}

export default { title: 'Components/Skipped', component: Hidden };

export const Hidden_ = { name: 'Hidden', parameters: { scry: { capture: { skip: true } } } };
