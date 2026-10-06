import { ReportList } from './ReportList.jsx';

function ReportsPage() {
  return (
    <main class="page">
      <h1>Reports</h1>
      <ReportList />
    </main>
  );
}

export function App() {
  return <ReportsPage />;
}
