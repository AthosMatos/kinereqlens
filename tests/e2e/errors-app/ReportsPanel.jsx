import { useEffect, useState } from 'react';

// Mounted on demand (window.showReports): fetches an endpoint that answers 404 from its effect, so the failure has a
// component the Errors view can locate (tests of the automatic error-area screenshot).
export function ReportsPanel() {
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/reports/7')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => setError(String(err.message)));
  }, []);
  return (
    <section id="reports-panel" class="orders">
      <h2>Reports</h2>
      {error ? <p role="alert">Could not load reports: {error}</p> : <p>Loading…</p>}
    </section>
  );
}
