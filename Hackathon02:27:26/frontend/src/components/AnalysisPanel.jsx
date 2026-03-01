import React from "react";

const RISK = {
  LOW:    { color: "#6fcf97", bg: "#1a3028", border: "#3a7d56", label: "Safe" },
  MEDIUM: { color: "#f2c94c", bg: "#302818", border: "#8a6a24", label: "Caution" },
  HIGH:   { color: "#f28b82", bg: "#2d1b1e", border: "#8b5252", label: "Risky" },
};

const CLAUSE_COLORS = {
  SELECT:   "#7cacf8",
  FROM:     "#a78bfa",
  JOIN:     "#c084fc",
  DISTINCT: "#f0abfc",
  WHERE:    "#f2c94c",
  "GROUP BY": "#6fcf97",
  HAVING:   "#34d399",
  "ORDER BY": "#fb923c",
  LIMIT:    "#94a3b8",
};

export default function AnalysisPanel({ description, analysis, clauses, onExecute, loading }) {
  if (!description && !analysis && !clauses) return null;

  const risk = analysis?.risk_score || "LOW";
  const riskInfo = RISK[risk] || RISK.LOW;

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.icon}>⚡</span>
          <span style={styles.title}>Pre-Flight Check</span>
          <span style={{
            ...styles.riskChip,
            background: riskInfo.bg,
            borderColor: riskInfo.border,
            color: riskInfo.color,
          }}>
            {riskInfo.label}
          </span>
        </div>

        {/* Clause-by-clause breakdown */}
        {clauses && clauses.length > 0 ? (
          <div style={styles.clauseList}>
            {clauses.map((clause, i) => {
              const accentColor = CLAUSE_COLORS[clause.label] || "#a0a8c0";
              const isLast = i === clauses.length - 1;
              return (
                <div
                  key={i}
                  style={{
                    ...styles.clauseItem,
                    borderBottom: isLast ? "none" : "1px solid #252a3d",
                    paddingBottom: isLast ? 0 : 14,
                  }}
                >
                  <div style={{ ...styles.clauseLabel, color: accentColor }}>
                    {clause.label}
                  </div>
                  {clause.lines.map((line, j) => (
                    <p key={j} style={styles.clauseLine}>{line}</p>
                  ))}
                </div>
              );
            })}
          </div>
        ) : description ? (
          <p style={styles.descriptionText}>{description}</p>
        ) : null}

        {/* Flags */}
        {analysis?.flags?.length > 0 && analysis.flags[0] !== "Query looks safe" && (
          <div style={styles.flagsBox}>
            {analysis.flags.map((f, i) => (
              <div key={i} style={styles.flagItem}>
                <span style={styles.flagIcon}>⚠</span>
                <span>{f}</span>
              </div>
            ))}
          </div>
        )}

        {/* Execute button */}
        <button
          style={{
            ...styles.executeBtn,
            ...(loading ? styles.executeBtnDisabled : {}),
          }}
          onClick={onExecute}
          disabled={loading}
        >
          {loading ? (
            <>
              <span style={styles.spinner} />
              Running…
            </>
          ) : (
            <>▶ Yes, Run This Query</>
          )}
        </button>
      </div>
    </div>
  );
}

const styles = {
  wrapper: {
    padding: 4,
  },
  card: {
    background: "linear-gradient(135deg, #1e2235 0%, #212538 100%)",
    border: "1px solid #363c56",
    borderRadius: 14,
    padding: 20,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  icon: {
    fontSize: 18,
  },
  title: {
    fontSize: 15,
    fontWeight: 600,
    color: "#e8ecf4",
    letterSpacing: "-0.01em",
  },
  riskChip: {
    marginLeft: "auto",
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 10px",
    borderRadius: 20,
    border: "1px solid transparent",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
  },
  clauseList: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  clauseItem: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
  },
  clauseLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    textDecoration: "underline",
    textUnderlineOffset: 3,
    marginBottom: 2,
  },
  clauseLine: {
    fontSize: 13,
    lineHeight: 1.65,
    color: "#d0d7e6",
    margin: 0,
  },
  descriptionText: {
    fontSize: 14,
    lineHeight: 1.7,
    color: "#d0d7e6",
    margin: 0,
  },
  flagsBox: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "10px 12px",
    background: "#2a2230",
    borderRadius: 10,
    border: "1px solid #3d2e45",
  },
  flagItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 13,
    color: "#c9a060",
    lineHeight: 1.5,
  },
  flagIcon: {
    flexShrink: 0,
    marginTop: 1,
  },
  executeBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "12px 24px",
    fontSize: 15,
    fontWeight: 600,
    color: "#fff",
    background: "linear-gradient(135deg, #238636 0%, #2ea043 100%)",
    border: "1px solid #2ea043",
    borderRadius: 10,
    cursor: "pointer",
    transition: "all 0.15s ease",
    letterSpacing: "-0.01em",
    marginTop: 4,
  },
  executeBtnDisabled: {
    opacity: 0.6,
    cursor: "not-allowed",
  },
  spinner: {
    display: "inline-block",
    width: 14,
    height: 14,
    border: "2px solid rgba(255,255,255,0.3)",
    borderTopColor: "#fff",
    borderRadius: "50%",
    animation: "spin 0.6s linear infinite",
  },
};
