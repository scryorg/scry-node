import { useState } from 'react';

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" className="btn" onClick={() => setCount((c) => c + 1)}>
        Add one
      </button>
      <p data-testid="count">Count: {count}</p>
    </div>
  );
}
