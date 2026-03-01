import { useState, useMemo } from "react";

// ── Design tokens (soft, friendly palette) ───────────────────────────────────
const C = {
  bgBase:       "#1a1d2e",
  bgSubtle:     "#212538",
  bgSurface:    "#2a2f45",
  border:       "#363c56",
  blue:         "#7cacf8",
  green:        "#6fcf97",
  purple:       "#b99cff",
  txtPrimary:   "#e8ecf4",
  txtSecondary: "#a0a8c0",
  txtMuted:     "#7a82a0",
  accent:       "#a78bfa",
  mono:         '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
};

// Type → icon mapping
function typeIcon(colType) {
  if (!colType) return "?";
  const t = colType.toUpperCase().replace(/\(.*\)/, "").trim();
  if (["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "FLOAT", "DOUBLE", "REAL", "DECIMAL", "NUMERIC", "NUMBER"].includes(t)) return "#";
  if (["TEXT", "VARCHAR", "NVARCHAR", "CHAR", "NCHAR", "STRING", "CLOB"].includes(t)) return "Aa";
  if (["DATE", "DATETIME", "TIMESTAMP", "TIME"].includes(t)) return "📅";
  if (["BOOLEAN", "BOOL", "BIT"].includes(t)) return "✓";
  if (["BLOB", "BINARY", "VARBINARY", "IMAGE"].includes(t)) return "◼";
  return "?";
}

function typeColor(colType) {
  if (!colType) return C.txtMuted;
  const t = colType.toUpperCase().replace(/\(.*\)/, "").trim();
  if (["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "FLOAT", "DOUBLE", "REAL", "DECIMAL", "NUMERIC", "NUMBER"].includes(t)) return "#93bbf5";
  if (["TEXT", "VARCHAR", "NVARCHAR", "CHAR", "NCHAR", "STRING", "CLOB"].includes(t)) return C.green;
  if (["DATE", "DATETIME", "TIMESTAMP", "TIME"].includes(t)) return C.purple;
  if (["BOOLEAN", "BOOL", "BIT"].includes(t)) return "#e8a87c";
  return C.txtMuted;
}

export default function TableExplorer({ schema, datasetType }) {
  const [search, setSearch] = useState("");
  const [expandedTable, setExpandedTable] = useState(null);

  const tables = schema?.tables || [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q))
    );
  }, [tables, search]);

  // Auto-expand single table
  const effectiveExpanded =
    filtered.length === 1 ? filtered[0].name : expandedTable;

  if (!schema || !tables.length) return null;

  return (
    <div style={s.wrapper}>
      {/* Header */}
      <div style={s.header}>
        <span style={s.title}>Tables</span>
        <span style={s.count}>{tables.length}</span>
      </div>

      {/* Search */}
      <div style={s.searchWrap}>
        <span style={s.searchIcon}>⌕</span>
        <input
          style={s.searchInput}
          placeholder="Search tables or fields…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button style={s.clearBtn} onClick={() => setSearch("")}>
            ✕
          </button>
        )}
      </div>

      {/* Table list */}
      <div style={s.list}>
        {filtered.length === 0 && (
          <p style={s.noResults}>No tables match "{search}"</p>
        )}
        {filtered.map((table) => {
          const isOpen = effectiveExpanded === table.name;
          return (
            <div key={table.name} style={s.tableGroup}>
              {/* Table name row */}
              <button
                style={{
                  ...s.tableRow,
                  background: isOpen ? C.bgSurface : "transparent",
                }}
                onClick={() =>
                  setExpandedTable(isOpen ? null : table.name)
                }
                onMouseEnter={(e) => {
                  if (!isOpen)
                    e.currentTarget.style.background = "rgba(167,139,250,0.08)";
                }}
                onMouseLeave={(e) => {
                  if (!isOpen)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <span style={s.chevron}>{isOpen ? "▾" : "▸"}</span>
                <span style={s.tableIcon}>▦</span>
                <span style={s.tableName}>{table.name}</span>
                <span style={s.colCount}>{table.columns.length} cols</span>
              </button>

              {/* Columns (expanded) */}
              {isOpen && (
                <div style={s.columns}>
                  {table.columns.map((col) => (
                    <div
                      key={col.name}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", col.name);
                        e.dataTransfer.setData(
                          "application/x-table-name",
                          table.name
                        );
                        e.dataTransfer.setData(
                          "application/x-col-type",
                          col.type || "TEXT"
                        );
                        e.dataTransfer.effectAllowed = "copy";
                        // Visual feedback
                        e.currentTarget.style.opacity = "0.5";
                      }}
                      onDragEnd={(e) => {
                        e.currentTarget.style.opacity = "1";
                      }}
                      style={s.colRow}
                      title={`Drag "${col.name}" into the Query Builder`}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          "rgba(167,139,250,0.1)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span
                        style={{
                          ...s.colTypeIcon,
                          color: typeColor(col.type),
                        }}
                      >
                        {typeIcon(col.type)}
                      </span>
                      <span style={s.colName}>{col.name}</span>
                      <span style={s.colType}>{col.type || "TEXT"}</span>
                      <span style={s.dragHint}>⠿</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    borderTop: `1px solid ${C.border}`,
    marginTop: 6,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 4px 8px",
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: C.txtPrimary,
    letterSpacing: "-0.01em",
  },
  count: {
    fontSize: 10,
    fontWeight: 600,
    color: C.accent,
    background: "rgba(167,139,250,0.12)",
    borderRadius: 8,
    padding: "2px 7px",
    lineHeight: "16px",
  },

  // Search
  searchWrap: {
    position: "relative",
    margin: "0 0 8px",
  },
  searchIcon: {
    position: "absolute",
    left: 10,
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: 13,
    color: C.txtMuted,
    pointerEvents: "none",
  },
  searchInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 30px 8px 28px",
    fontSize: 13,
    fontFamily: "inherit",
    color: C.txtPrimary,
    background: C.bgBase,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    outline: "none",
  },
  clearBtn: {
    position: "absolute",
    right: 8,
    top: "50%",
    transform: "translateY(-50%)",
    background: "none",
    border: "none",
    color: C.txtMuted,
    cursor: "pointer",
    fontSize: 11,
    padding: "2px 4px",
    lineHeight: 1,
  },

  // List
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  noResults: {
    fontSize: 13,
    color: C.txtMuted,
    fontStyle: "italic",
    padding: "10px 4px",
    margin: 0,
  },

  // Table row
  tableGroup: {
    display: "flex",
    flexDirection: "column",
  },
  tableRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    padding: "7px 8px",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "background 0.12s",
  },
  chevron: {
    fontSize: 10,
    color: C.txtMuted,
    width: 12,
    textAlign: "center",
    flexShrink: 0,
  },
  tableIcon: {
    fontSize: 13,
    color: C.accent,
    flexShrink: 0,
  },
  tableName: {
    fontSize: 13,
    fontWeight: 600,
    color: C.txtPrimary,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: 1,
    textAlign: "left",
  },
  colCount: {
    fontSize: 11,
    color: C.txtMuted,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },

  // Columns
  columns: {
    display: "flex",
    flexDirection: "column",
    marginLeft: 20,
    padding: "3px 0 6px",
    borderLeft: `1px solid ${C.border}`,
    marginBottom: 2,
  },
  colRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "4px 10px 4px 12px",
    borderRadius: 6,
    cursor: "grab",
    transition: "background 0.1s",
    userSelect: "none",
  },
  colTypeIcon: {
    fontSize: 10,
    fontWeight: 600,
    width: 18,
    textAlign: "center",
    flexShrink: 0,
    fontFamily: C.mono,
  },
  colName: {
    fontSize: 12,
    color: C.txtPrimary,
    flex: 1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontFamily: C.mono,
  },
  colType: {
    fontSize: 10,
    color: C.txtMuted,
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontFamily: C.mono,
  },
  dragHint: {
    fontSize: 12,
    color: C.txtMuted,
    opacity: 0.35,
    flexShrink: 0,
    marginLeft: 2,
  },
};
