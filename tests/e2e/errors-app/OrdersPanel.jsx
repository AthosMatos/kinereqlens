import { useEffect, useState } from 'react';

export function OrdersPanel() {
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/orders/42')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => setError(String(err.message)));
  }, []);
  return (
    <section id="orders-panel" class="orders">
      <h2>Orders</h2>
      {error ? <p role="alert">Could not load orders: {error}</p> : <p>Loading…</p>}
    </section>
  );
}
