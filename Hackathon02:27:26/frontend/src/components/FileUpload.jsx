import React, { useRef, useState } from "react";

export default function FileUpload({ onUpload, loading }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleChange = (e) => {
    const file = e.target.files?.[0];
    if (file) onUpload(file);
    e.target.value = "";
  };

  const handleDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onUpload(file);
  };

  return (
    <div
      style={{ ...styles.wrapper, ...(dragging ? styles.wrapperDrag : {}) }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx,.db,.duckdb,.sqlite,.sqlite3"
        onChange={handleChange}
        style={{ display: "none" }}
      />
      <button
        style={loading ? { ...styles.btn, ...styles.btnLoading } : styles.btn}
        onClick={() => inputRef.current?.click()}
        disabled={loading}
      >
        {loading ? (
          <><span style={styles.icon}>⟳</span> Uploading…</>
        ) : (
          <><span style={styles.icon}>⬆</span> Upload File</>
        )}
      </button>
    </div>
  );
}

const styles = {
  wrapper: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "3px 6px",
    borderRadius: 10,
    transition: "background 0.15s",
  },
  wrapperDrag: {
    background: "#2d2554",
    outline: "1.5px dashed #a78bfa",
    outlineOffset: 2,
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: "14px 28px",
    background: "#2a2f45",
    color: "#e8ecf4",
    border: "1px solid #363c56",
    borderRadius: 12,
    cursor: "pointer",
    fontSize: 17,
    fontWeight: 600,
    letterSpacing: "0.01em",
    whiteSpace: "nowrap",
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    transition: "background 0.15s",
  },
  btnLoading: {
    background: "#212538",
    color: "#5c6180",
    cursor: "not-allowed",
  },
  icon: { fontSize: 18, lineHeight: 1 },
  hint: {
    fontSize: 12,
    color: "#5c6180",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
};
