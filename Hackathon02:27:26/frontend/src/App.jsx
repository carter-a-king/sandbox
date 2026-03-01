import { useState, useEffect, useRef, useCallback } from "react";
import FileUpload from "./components/FileUpload.jsx";
import SqlEditor from "./components/SqlEditor.jsx";
import AnalysisPanel from "./components/AnalysisPanel.jsx";
import ResultsTable from "./components/ResultsTable.jsx";
import SchemaPanel from "./components/SchemaPanel.jsx";
import TableExplorer from "./components/TableExplorer.jsx";
import { uploadFile, preflight, runQuery, exportQuery } from "./lib/api.js";

// ── Design tokens (soft, friendly palette) ───────────────────────────────────
const C = {
  bgBase:   "#1a1d2e",
  bgSubtle: "#212538",
  bgSurface:"#2a2f45",
  border:   "#363c56",
  borderMuted: "#2a2f45",
  blue:     "#7cacf8",
  green:    "#6fcf97",
  yellow:   "#f2c94c",
  red:      "#f28b82",
  txtPrimary:   "#e8ecf4",
  txtSecondary: "#a0a8c0",
  txtMuted:     "#7a82a0",
  accent:   "#a78bfa",       // soft purple accent
  accentBg: "#2d2554",
  font:     '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono:     '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
};

// ── Editable project name in topbar ──────────────────────────────────────────

function ProjectNameEditor({ name, onRename }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef(null);

  useEffect(() => { setValue(name); }, [name]);

  const startEdit = () => {
    setEditing(true);
    setTimeout(() => { inputRef.current?.select(); }, 0);
  };

  const commit = () => {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setValue(name);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        style={pnStyles.input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setValue(name); setEditing(false); } }}
        maxLength={60}
        autoFocus
      />
    );
  }

  return (
    <button style={pnStyles.nameBtn} onClick={startEdit} title="Click to rename">
      {name}
      <span style={pnStyles.editHint}>✏</span>
    </button>
  );
}

const pnStyles = {
  nameBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 22,
    fontWeight: 600,
    color: C.txtPrimary,
    padding: "4px 8px",
    borderRadius: 8,
    letterSpacing: "-0.02em",
    fontFamily: C.font,
  },
  editHint: {
    fontSize: 14,
    color: C.txtMuted,
    opacity: 0.5,
  },
  input: {
    fontSize: 22,
    fontWeight: 600,
    color: C.txtPrimary,
    background: C.bgBase,
    border: `1.5px solid ${C.accent}`,
    borderRadius: 8,
    padding: "4px 12px",
    outline: "none",
    fontFamily: C.font,
    width: 300,
    letterSpacing: "-0.02em",
  },
};

// ── App ────────────────────────────────────────────────────────────────────────

export default function App({ project = {}, pendingFile = null, onHome = () => {}, onUpdateProject = () => {}, onRenameProject = () => {} }) {
  const [datasetId, setDatasetId] = useState(project.datasetId ?? null);
  const [datasetInfo, setDatasetInfo] = useState(project.datasetInfo ?? null);
  const [schema, setSchema] = useState(project.schema ?? null);
  const [builderSql, setBuilderSql] = useState(project.sql ?? "");
  const [manualSql, setManualSql] = useState(project.sql ?? "");
  const [activeSource, setActiveSource] = useState("builder"); // "builder" | "manual"
  const sql = activeSource === "manual" ? manualSql : builderSql;
  const [analysis, setAnalysis] = useState(null);
  const [preflightDescription, setPreflightDescription] = useState(null);
  const [clauses, setClauses] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [rightTab, setRightTab] = useState("code");

  // ── Resizable panels ──
  const [leftWidth, setLeftWidth] = useState(330);
  const [rightWidth, setRightWidth] = useState(365);
  const bodyRef = useRef(null);
  const dragging = useRef(null); // "left" | "right" | null

  const onDividerDown = useCallback((which) => (e) => {
    e.preventDefault();
    dragging.current = which;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current || !bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const totalW = rect.width;
      const MIN = 200;
      if (dragging.current === "left") {
        setLeftWidth(Math.max(MIN, Math.min(x, totalW - rightWidth - MIN - 12)));
      } else {
        const fromRight = totalW - x;
        setRightWidth(Math.max(MIN, Math.min(fromRight, totalW - leftWidth - MIN - 12)));
      }
    };
    const onUp = () => {
      if (dragging.current) {
        dragging.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [leftWidth, rightWidth]);

  // Auto-save project state back to Root whenever relevant state changes
  useEffect(() => {
    onUpdateProject({ id: project.id, datasetId, datasetInfo, schema, sql });
  }, [datasetId, datasetInfo, schema, sql]); // eslint-disable-line

  // Auto-upload if a file was passed from the home page card
  useEffect(() => {
    if (pendingFile) handleUpload(pendingFile);
  }, []); // eslint-disable-line

  const handleBuilderChange = useCallback((newSql) => {
    setBuilderSql(newSql);
    setActiveSource("builder");
  }, []);

  const handleManualChange = useCallback((val) => {
    setManualSql(val);
    setActiveSource("manual");
  }, []);

  const handleUpload = async (file) => {
    setUploading(true);
    setError(null);
    try {
      const data = await uploadFile(file);
      setDatasetId(data.dataset_id);
      setDatasetInfo(data);
      setSchema(data.schema);
      setAnalysis(null);
      setPreflightDescription(null);
      setClauses(null);
      setResults(null);
      setActiveSource("builder");
      setManualSql("");
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handlePreflight = async () => {
    if (!datasetId || !sql.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await preflight(sql, datasetId);
      setAnalysis(data.analysis);
      setPreflightDescription(data.description);
      setClauses(data.clauses || null);
      setRightTab("analysis");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRun = async () => {
    if (!datasetId || !sql.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await runQuery(sql, datasetId);
      setResults(data);
      setRightTab("results");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (!datasetId || !sql.trim()) return;
    setExporting(true);
    setError(null);
    try {
      await exportQuery(sql, datasetId);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  };

  const canRun = !!datasetId && !!sql.trim() && !loading;

  return (
    <div style={styles.root}>
      {/* ── TOP BAR ── */}
      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <button style={styles.homeBtn} onClick={onHome} title="All projects">
            ⬡
          </button>
          <span style={styles.topDivider}>/</span>
          <ProjectNameEditor name={project.name ?? "Untitled"} onRename={onRenameProject} />
          {datasetInfo && (
            <div style={styles.datasetPill}>
              <span style={styles.datasetTypeBadge}>{datasetInfo.dataset_type.toUpperCase()}</span>
            </div>
          )}
        </div>
        <div style={styles.topRight}>
          <FileUpload onUpload={handleUpload} loading={uploading} />
        </div>
      </header>

      {/* ── BODY (3 panels) ── */}
      <div ref={bodyRef} style={styles.body}>

        {/* Left: SQL Builder */}
        <aside style={{ ...styles.leftPanel, width: leftWidth, minWidth: leftWidth }}>
          <div style={styles.panelHeader}>
            <span style={styles.panelTitle}>Query Builder</span>
            {schema && <span style={styles.panelHint}>drag fields from ERD or Tables below</span>}
          </div>
          <div style={styles.editorScroll}>
            <SqlEditor
              onChange={handleBuilderChange}
              onPreflight={handlePreflight}
              onRun={handleRun}
              disabled={!datasetId || loading}
              schema={schema}
              datasetType={datasetInfo?.dataset_type}
              showPreview={false}
              showButtons={false}
            />

            {/* ── Manual SQL input ── */}
            <div style={styles.manualSqlBox}>
              <div style={styles.manualSqlHeader}>
                <span style={styles.manualSqlLabel}>Raw SQL</span>
                <span style={{
                  ...styles.sourceBadge,
                  ...(activeSource === "manual" ? styles.sourceBadgeActive : {}),
                }}>
                  {activeSource === "manual" ? "● active" : "○ builder active"}
                </span>
              </div>
              <textarea
                style={styles.manualSqlTextarea}
                value={manualSql}
                onChange={(e) => handleManualChange(e.target.value)}
                placeholder={"-- type SQL here to override the builder\nSELECT * FROM ..."}
                spellCheck={false}
              />
            </div>

            {schema && (
              <TableExplorer
                schema={schema}
                datasetType={datasetInfo?.dataset_type}
              />
            )}
          </div>
        </aside>

        {/* Divider: left ↔ center */}
        <div style={styles.divider} onMouseDown={onDividerDown("left")}>
          <div style={styles.dividerGrip} />
        </div>

        {/* Center: ERD */}
        <main style={styles.centerPanel}>
          {schema ? (
            <SchemaPanel schema={schema} datasetType={datasetInfo?.dataset_type} />
          ) : (
            <div style={styles.emptyErd}>
              <div style={styles.emptyErdGlyph}>⬡</div>
              <p style={styles.emptyErdTitle}>No dataset loaded</p>
              <p style={styles.emptyErdSub}>Upload a CSV, XLSX, or database file to visualise the entity-relationship diagram</p>
            </div>
          )}
        </main>

        {/* Divider: center ↔ right */}
        <div style={styles.divider} onMouseDown={onDividerDown("right")}>
          <div style={styles.dividerGrip} />
        </div>

        {/* Right: Output */}
        <aside style={{ ...styles.rightPanel, width: rightWidth, minWidth: rightWidth }}>
          <div style={styles.actionRow}>
            <button style={{ ...styles.actionBtn, ...styles.actionBtnPreflight }} onClick={handlePreflight} disabled={!canRun}>
              {loading ? "Running…" : "⚡ Preflight"}
            </button>
            <button style={{ ...styles.actionBtn, ...styles.actionBtnRun }} onClick={handleRun} disabled={!canRun}>
              {loading ? "Running…" : "▶ Run"}
            </button>
            {results && (
              <button style={{ ...styles.actionBtn, ...styles.actionBtnExport }} onClick={handleExport} disabled={exporting}>
                {exporting ? "Exporting…" : "⬇ Export"}
              </button>
            )}
          </div>
          <div style={styles.tabBar}>
            {[["code", "SQL", "⌨"], ["analysis", "Preflight", "⚡"], ["results", "Results", "⊞"]].map(([key, label, icon]) => (
              <button
                key={key}
                style={rightTab === key ? styles.tabActive : styles.tab}
                onClick={() => setRightTab(key)}
              >
                <span style={styles.tabIcon}>{icon}</span>
                {label}
              </button>
            ))}
          </div>

          <div style={styles.tabContent}>
            {rightTab === "code" && (
              <div style={styles.sqlPane}>
                <p style={styles.paneLabel}>Generated SQL</p>
                <pre style={styles.sqlCode}>{sql ? (sql.trimEnd().endsWith(";") ? sql : sql.trimEnd() + ";") : "-- build your query on the left"}</pre>
                {error && (
                  <div style={styles.errorBox}>
                    <span style={styles.errorIcon}>⚠</span>
                    {error}
                  </div>
                )}

              </div>
            )}

            {rightTab === "analysis" && (
              <div style={styles.tabScrollContent}>
                {analysis || preflightDescription
                  ? <AnalysisPanel
                      description={preflightDescription}
                      analysis={analysis}
                      clauses={clauses}
                      onExecute={handleRun}
                      loading={loading}
                    />
                  : <EmptyTabMsg icon="⚡" text="Run Preflight to see what your query does before executing it." />}
              </div>
            )}

            {rightTab === "results" && (
              <div style={styles.tabScrollContent}>
                {results
                  ? <ResultsTable data={results} onExport={handleExport} exporting={exporting} />
                  : <EmptyTabMsg icon="⊞" text="Run a query to see results here." />}
              </div>
            )}
          </div>

          {loading && (
            <div style={styles.loadingFooter}>
              <span style={styles.loadingPulse} />
              Processing…
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function EmptyTabMsg({ icon, text }) {
  return (
    <div style={{ textAlign: "center", paddingTop: 52, color: C.txtMuted }}>
      <div style={{ fontSize: 32, marginBottom: 14, opacity: 0.3 }}>{icon}</div>
      <p style={{ fontSize: 14, margin: 0, lineHeight: 1.7, fontFamily: C.font }}>{text}</p>
    </div>
  );
}

const styles = {
  // ── Root
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    overflow: "hidden",
    fontFamily: C.font,
    background: C.bgBase,
    color: C.txtPrimary,
  },

  // ── Topbar
  topbar: {
    height: 80,
    minHeight: 80,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 32px",
    background: C.bgSubtle,
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  topLeft: {
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  homeBtn: {
    background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`,
    border: "none",
    cursor: "pointer",
    fontSize: 26,
    color: "#fff",
    lineHeight: 1,
    padding: "10px 13px",
    borderRadius: 14,
    display: "flex",
    alignItems: "center",
    boxShadow: "0 3px 12px rgba(167,139,250,0.3)",
  },
  topDivider: {
    fontSize: 26,
    color: C.border,
    userSelect: "none",
  },
  datasetPill: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginLeft: 4,
    padding: "7px 18px",
    background: C.bgSurface,
    border: `1px solid ${C.border}`,
    borderRadius: 24,
  },
  datasetTypeBadge: {
    fontWeight: 600,
    color: C.accent,
    fontSize: 14,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
  },
  datasetTables: {
    color: C.txtSecondary,
    fontSize: 16,
  },
  topRight: {
    display: "flex",
    alignItems: "center",
  },

  // ── Body
  body: {
    flex: 1,
    display: "flex",
    flexDirection: "row",
    overflow: "hidden",
    minHeight: 0,
  },

  // ── Divider
  divider: {
    width: 6,
    minWidth: 6,
    cursor: "col-resize",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: C.bgSubtle,
    zIndex: 2,
    flexShrink: 0,
    transition: "background .15s",
  },
  dividerGrip: {
    width: 3,
    height: 40,
    borderRadius: 2,
    background: C.border,
    transition: "background .15s",
  },

  // ── Left panel
  leftPanel: {
    width: 330,
    minWidth: 200,
    display: "flex",
    flexDirection: "column",
    background: C.bgSubtle,
    borderRight: `1px solid ${C.border}`,
    overflow: "hidden",
  },
  panelHeader: {
    padding: "14px 18px",
    borderBottom: `1px solid ${C.border}`,
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    flexShrink: 0,
    background: C.bgSubtle,
  },
  panelTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: C.txtPrimary,
    letterSpacing: "-0.01em",
  },
  panelHint: {
    fontSize: 12,
    color: C.txtMuted,
    fontStyle: "italic",
  },
  editorScroll: {
    flex: 1,
    overflowY: "auto",
    padding: "12px 14px 18px",
  },

  // ── Center panel
  centerPanel: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    background: "#ffffff",
    overflow: "auto",
    position: "relative",
    minWidth: 0,
  },
  emptyErd: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    userSelect: "none",
    padding: 40,
    textAlign: "center",
  },
  emptyErdGlyph: {
    fontSize: 64,
    opacity: 0.07,
    color: "#0f172a",
    lineHeight: 1,
    marginBottom: 20,
  },
  emptyErdTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: "#475569",
    margin: "0 0 8px",
  },
  emptyErdSub: {
    fontSize: 14,
    color: "#94a3b8",
    margin: 0,
    maxWidth: 320,
    lineHeight: 1.7,
  },

  // ── Right panel
  rightPanel: {
    width: 365,
    minWidth: 200,
    display: "flex",
    flexDirection: "column",
    background: C.bgBase,
    borderLeft: `1px solid ${C.border}`,
    overflow: "hidden",
  },
  tabBar: {
    display: "flex",
    background: C.bgSubtle,
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
    padding: "0 8px",
    gap: 2,
  },
  tab: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    flex: 1,
    padding: "12px 4px",
    background: "transparent",
    border: "none",
    borderBottom: "2.5px solid transparent",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    color: C.txtMuted,
    letterSpacing: "0.02em",
    fontFamily: C.font,
  },
  tabActive: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    flex: 1,
    padding: "12px 4px",
    background: "transparent",
    border: "none",
    borderBottom: `2.5px solid ${C.accent}`,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    color: C.txtPrimary,
    letterSpacing: "0.02em",
    fontFamily: C.font,
  },
  tabIcon: { fontSize: 14 },
  tabContent: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },

  // SQL pane
  sqlPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    padding: 18,
    gap: 14,
    overflow: "hidden",
  },
  paneLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: C.txtMuted,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    margin: 0,
    flexShrink: 0,
  },
  sqlCode: {
    flex: 1,
    margin: 0,
    padding: 16,
    background: C.bgSubtle,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    color: "#93bbf5",
    fontFamily: C.mono,
    fontSize: 13,
    lineHeight: 1.8,
    whiteSpace: "pre-wrap",
    overflowY: "auto",
    minHeight: 80,
  },
  errorBox: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "12px 16px",
    background: "#2d1b1e",
    border: `1px solid #6b3a3f`,
    borderRadius: 10,
    color: C.red,
    fontSize: 13,
    lineHeight: 1.5,
    flexShrink: 0,
  },
  errorIcon: { flexShrink: 0, fontSize: 14, marginTop: 1 },
  actionRow: {
    display: "flex",
    gap: 8,
    flexShrink: 0,
  },
  actionBtn: {
    flex: 1,
    padding: "10px 0",
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    letterSpacing: "0.01em",
    fontFamily: C.font,
    transition: "transform 0.1s, box-shadow 0.15s",
  },
  actionBtnPreflight: { background: "linear-gradient(135deg, #c77b1a, #e09422)", color: "#fff" },
  actionBtnRun:       { background: "linear-gradient(135deg, #22804a, #34a85a)", color: "#fff" },
  actionBtnExport:    { background: "linear-gradient(135deg, #3b5cc6, #5179e0)", color: "#fff" },
  tabScrollContent: {
    flex: 1,
    overflowY: "auto",
    padding: 18,
  },
  loadingFooter: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 18px",
    background: C.accentBg,
    borderTop: `1px solid ${C.border}`,
    color: C.accent,
    fontSize: 13,
    fontWeight: 500,
    flexShrink: 0,
  },
  loadingPulse: {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: C.accent,
    flexShrink: 0,
  },

  // ── Manual SQL box
  manualSqlBox: {
    marginTop: 12,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    overflow: "hidden",
    background: C.bgBase,
  },
  manualSqlHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    background: C.bgSurface,
    borderBottom: `1px solid ${C.borderMuted}`,
  },
  manualSqlLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: C.txtSecondary,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  sourceBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: C.txtMuted,
    letterSpacing: "0.04em",
  },
  sourceBadgeActive: {
    color: C.accent,
  },
  manualSqlTextarea: {
    display: "block",
    width: "100%",
    minHeight: 100,
    padding: "10px 12px",
    background: C.bgBase,
    border: "none",
    outline: "none",
    resize: "vertical",
    color: "#93bbf5",
    fontFamily: C.mono,
    fontSize: 12,
    lineHeight: 1.7,
    boxSizing: "border-box",
  },
};
