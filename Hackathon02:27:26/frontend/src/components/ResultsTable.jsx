export default function ResultsTable({ data, onExport, exporting }) {
  if (!data) return null;

  const { columns, rows, row_count } = data;

  if (!rows || rows.length === 0) {
    return <p style={{ color: "#7a82a0", fontSize: 14 }}>No results returned.</p>;
  }

  const hitLimit = row_count >= 200;

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h3 style={styles.heading}>Query Results</h3>
          <p style={styles.rowCount}>{row_count}{hitLimit ? "+" : ""} rows returned</p>
        </div>
        <button style={styles.exportBtn} onClick={onExport} disabled={exporting}>
          {exporting ? "Exporting…" : "⬇ Export CSV"}
        </button>
      </div>

      {hitLimit && (
        <div style={styles.limitNotice}>
          <span style={styles.noticeIcon}>⚠</span>
          Showing first 200 rows — export CSV for full results.
        </div>
      )}

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} style={styles.th}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={i % 2 === 0 ? styles.rowEven : styles.rowOdd}>
                {columns.map((c) => (
                  <td key={c} style={styles.td}>
                    {row[c] === null
                      ? <em style={styles.nullVal}>NULL</em>
                      : String(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const MONO = '"JetBrains Mono", "SF Mono", "Fira Code", monospace';

const styles = {
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 12,
    gap: 10,
  },
  heading: { margin: "0 0 3px", fontSize: 15, fontWeight: 600, color: "#e8ecf4" },
  rowCount: { margin: 0, fontSize: 12, color: "#7a82a0" },
  exportBtn: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    background: "#2a2f45",
    color: "#e8ecf4",
    border: "1px solid #363c56",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 500,
    fontSize: 13,
    whiteSpace: "nowrap",
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  limitNotice: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    background: "#302818",
    border: "1px solid #8a6a24",
    borderRadius: 10,
    fontSize: 13,
    color: "#f2c94c",
    marginBottom: 12,
  },
  noticeIcon: { flexShrink: 0 },
  tableWrap: {
    overflowX: "auto",
    border: "1px solid #363c56",
    borderRadius: 10,
    background: "#1a1d2e",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "10px 14px",
    background: "#212538",
    borderBottom: "1px solid #363c56",
    fontWeight: 600,
    color: "#a0a8c0",
    whiteSpace: "nowrap",
    fontSize: 11,
    letterSpacing: "0.03em",
    textTransform: "uppercase",
  },
  td: {
    padding: "8px 14px",
    borderBottom: "1px solid #2a2f45",
    color: "#e8ecf4",
    fontFamily: MONO,
    fontSize: 12,
  },
  rowEven: { background: "#1a1d2e" },
  rowOdd:  { background: "#212538" },
  nullVal: { color: "#5c6180", fontStyle: "italic", fontSize: 11 },
};
