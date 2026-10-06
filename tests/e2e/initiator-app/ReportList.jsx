import { useEffect, useState } from 'react';

export function ReportList() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    fetch('/api/reports?from=ReportList')
      .then((res) => res.json())
      .then((data) => setRows(data.rows));
  }, []);
  return (
    <ul id="report-list" class="reports">
      {rows.map((row) => (
        <li key={row.id}>{row.title}</li>
      ))}
    </ul>
  );
}
