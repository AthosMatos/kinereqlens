// E2E fixture (tests/e2e/errors.spec.ts): a tiny "React" app (Preact aliased as react / react-dom by the spec's
// esbuild build, source map linked) whose OrdersPanel fetches an endpoint that answers 500; window.showReports()
// mounts a ReportsPanel (below it) whose fetch answers 404.
import { useEffect, useState } from 'react';
import { render } from 'react-dom';
import { OrdersPanel } from './OrdersPanel.jsx';
import { ReportsPanel } from './ReportsPanel.jsx';

function App() {
  const [reports, setReports] = useState(false);
  useEffect(() => {
    window.showReports = () => setReports(true);
  }, []);
  return (
    <main class="page">
      <h1>Shop</h1>
      <OrdersPanel />
      {reports ? <ReportsPanel /> : null}
    </main>
  );
}

render(<App />, document.getElementById('root'));

// Not from a component: a failure the Errors view captures as the visible page.
window.failNetwork = () => fetch('http://127.0.0.1:9/unreachable').catch(() => undefined);
window.failMissing = () => fetch('/api/missing/7').catch(() => undefined);
