function Broken() {
  throw new Error('fixture story always throws');
}

export default { title: 'Components/Broken', component: Broken };

export const Throws = {};
