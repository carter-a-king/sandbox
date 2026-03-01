import { useState, useRef, useEffect, useMemo } from "react";

// ── Design tokens (soft, friendly palette) ───────────────────────────────────
const C = {
  bgBase:       "#1a1d2e",
  bgSubtle:     "#212538",
  bgSurface:    "#2a2f45",
  border:       "#363c56",
  blue:         "#7cacf8",
  green:        "#6fcf97",
  red:          "#f28b82",
  txtPrimary:   "#e8ecf4",
  txtSecondary: "#a0a8c0",
  txtMuted:     "#7a82a0",
  accent:       "#a78bfa",
  accentBg:     "#2d2554",
  font:         '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono:         '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
};

// ── Time helpers ───────────────────────────────────────────────────────────────

function relativeTime(ts) {
  const diffMs = Date.now() - ts;
  const m = Math.floor(diffMs / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function lastOpenedLabel(ts) {
  if (!ts) return "Never";
  return relativeTime(ts);
}

// ── New-project modal ──────────────────────────────────────────────────────────

function NewProjectModal({ onConfirm, onClose }) {
  const [name, setName] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
    else onConfirm("Untitled Project");
  };

  const onKey = (e) => {
    if (e.key === "Enter")  submit();
    if (e.key === "Escape") onClose();
  };

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={s.modalTitle}>New Project</h2>
        <p style={s.modalSub}>Give your project a name — you can rename it at any time.</p>
        <input
          ref={inputRef}
          style={s.modalInput}
          placeholder="e.g. Sales Analysis Q1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKey}
          maxLength={60}
        />
        <div style={s.modalActions}>
          <button style={s.modalCancel} onClick={onClose}>Cancel</button>
          <button style={s.modalCreate} onClick={submit}>Create Project</button>
        </div>
      </div>
    </div>
  );
}

// ── Inline rename ──────────────────────────────────────────────────────────────

function RenameInput({ value, onDone }) {
  const [name, setName] = useState(value);
  const ref = useRef(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => onDone(name.trim() || value);

  return (
    <input
      ref={ref}
      style={s.renameInput}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter")  commit();
        if (e.key === "Escape") onDone(value);
      }}
      onClick={(e) => e.stopPropagation()}
      maxLength={60}
    />
  );
}

// ── Project card ───────────────────────────────────────────────────────────────

function ProjectCard({ project, onOpen, onRename, onDelete }) {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const tables = project.datasetInfo?.tables ?? [];
  const dtype  = project.datasetInfo?.dataset_type;

  return (
    <div
      style={s.card}
      onClick={() => !renaming && onOpen(project.id)}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = C.accent)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = C.border)}
    >
      {/* Card header */}
      <div style={s.cardHeader}>
        <div style={s.cardIconWrap}>
          <span style={s.cardIcon}>⬡</span>
        </div>
        {/* Menu button */}
        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            style={s.menuBtn}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
            title="Options"
          >
            ···
          </button>
          {menuOpen && (
            <div style={s.menu}>
              <button
                style={s.menuItem}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  setRenaming(true);
                }}
              >
                ✏ Rename
              </button>
              <button
                style={{ ...s.menuItem, color: C.red }}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  if (window.confirm(`Delete "${project.name}"?`)) onDelete(project.id);
                }}
              >
                🗑 Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Name + meta */}
      <div style={s.cardBody}>
        {renaming ? (
          <RenameInput
            value={project.name}
            onDone={(n) => { setRenaming(false); onRename(project.id, n); }}
          />
        ) : (
          <p style={s.cardName}>{project.name}</p>
        )}
        <p style={s.cardMeta}>Created {relativeTime(project.createdAt)}</p>
        <p style={s.cardLastOpened}>
          Last opened: {lastOpenedLabel(project.lastOpenedAt)}
        </p>
      </div>

      {/* Footer badges */}
      {dtype ? (
        <div style={s.cardFooter}>
          <span style={s.dtypeBadge}>{dtype.toUpperCase()}</span>
          {tables.slice(0, 3).map((t) => (
            <span key={t} style={s.tableBadge}>{t}</span>
          ))}
          {tables.length > 3 && (
            <span style={s.tableBadgeMore}>+{tables.length - 3}</span>
          )}
        </div>
      ) : (
        <div style={s.cardFooter}>
          <span style={s.emptyBadge}>No dataset yet</span>
        </div>
      )}
    </div>
  );
}

// ── HomePage ───────────────────────────────────────────────────────────────────

export default function HomePage({ projects, onCreate, onOpen, onRename, onDelete }) {
  const [showModal, setShowModal] = useState(false);
  const [search, setSearch]       = useState("");
  const [sortBy, setSortBy]       = useState("newest"); // newest | oldest | recent | never

  const handleCreate = (name) => {
    setShowModal(false);
    onCreate(name);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
    return [...list].sort((a, b) => {
      if (sortBy === "newest")  return b.createdAt - a.createdAt;
      if (sortBy === "oldest")  return a.createdAt - b.createdAt;
      if (sortBy === "recent") {
        if (!a.lastOpenedAt && !b.lastOpenedAt) return b.createdAt - a.createdAt;
        if (!a.lastOpenedAt) return 1;
        if (!b.lastOpenedAt) return -1;
        return b.lastOpenedAt - a.lastOpenedAt;
      }
      return b.createdAt - a.createdAt;
    });
  }, [projects, search, sortBy]);

  const SORT_TABS = [
    { key: "newest", label: "New → Old" },
    { key: "oldest", label: "Old → New" },
    { key: "recent", label: "Last Opened" },
  ];

  return (
    <div style={s.page}>
      {/* Topbar */}
      <header style={s.topbar}>
        <div style={s.topLeft}>
          <span style={s.logo}>⬡</span>
          <span style={s.appName}>SQL Preflight</span>
        </div>
        <button style={s.newBtn} onClick={() => setShowModal(true)}>
          + New Project
        </button>
      </header>

      {/* Body */}
      <main style={s.body}>
        <div style={s.bodyInner}>
          <div style={s.bodyHeader}>
            <h1 style={s.pageTitle}>Projects</h1>
            <p style={s.pageSub}>{projects.length} project{projects.length !== 1 ? "s" : ""}</p>
          </div>

          {/* Search + Sort toolbar */}
          {projects.length > 0 && (
            <div style={s.toolbar}>
              {/* Search input */}
              <div style={s.searchWrap}>
                <span style={s.searchIcon}>⌕</span>
                <input
                  style={s.searchInput}
                  type="text"
                  placeholder="Search projects..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  spellCheck={false}
                />
                {search && (
                  <button style={s.searchClear} onClick={() => setSearch("")} title="Clear">✕</button>
                )}
              </div>
              {/* Sort tabs */}
              <div style={s.sortTabs}>
                {SORT_TABS.map(({ key, label }) => (
                  <button
                    key={key}
                    style={sortBy === key ? { ...s.sortTab, ...s.sortTabActive } : s.sortTab}
                    onClick={() => setSortBy(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {projects.length === 0 ? (
            <div style={s.empty}>
              <div style={s.emptyIcon}>⬡</div>
              <p style={s.emptyTitle}>No projects yet</p>
              <p style={s.emptySub}>Create your first project to start querying your data.</p>
              <button style={s.emptyBtn} onClick={() => setShowModal(true)}>
                + New Project
              </button>
            </div>
          ) : (
            <>
              {filtered.length === 0 && (
                <div style={s.empty}>
                  <div style={{ ...s.emptyIcon, fontSize: 40 }}>🔍</div>
                  <p style={s.emptyTitle}>No results</p>
                  <p style={s.emptySub}>No projects match "{search}".</p>
                </div>
              )}
              {filtered.length > 0 && (
                <div style={s.grid}>
                  {/* "New project" card */}
                  <div
                    style={s.newCard}
                    onClick={() => setShowModal(true)}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = C.accent)}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = C.border)}
                  >
                    <span style={s.newCardPlus}>+</span>
                    <span style={s.newCardLabel}>New Project</span>
                  </div>

                  {filtered.map((p) => (
                    <ProjectCard
                      key={p.id}
                      project={p}
                      onOpen={onOpen}
                      onRename={onRename}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {showModal && (
        <NewProjectModal
          onConfirm={handleCreate}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: C.bgBase,
    color: C.txtPrimary,
    fontFamily: C.font,
  },

  // Topbar
  topbar: {
    height: 64,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 32px",
    background: C.bgSubtle,
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  topLeft: { display: "flex", alignItems: "center", gap: 14 },
  logo:    {
    fontSize: 22,
    lineHeight: 1,
    background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  appName: {
    fontSize: 20,
    fontWeight: 700,
    color: C.txtPrimary,
    letterSpacing: "-0.02em",
  },
  newBtn: {
    padding: "10px 22px",
    background: `linear-gradient(135deg, ${C.accent}, #8b6cf6)`,
    color: "#fff",
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 14,
    letterSpacing: "0.01em",
    boxShadow: "0 2px 12px rgba(167,139,250,0.3)",
    fontFamily: C.font,
    transition: "transform 0.1s, box-shadow 0.15s",
  },

  // Body
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "48px 32px",
  },
  bodyInner: { maxWidth: 1100, margin: "0 auto" },
  bodyHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: 14,
    marginBottom: 32,
  },
  pageTitle: {
    margin: 0,
    fontSize: 28,
    fontWeight: 700,
    color: C.txtPrimary,
    letterSpacing: "-0.03em",
  },
  pageSub: {
    margin: 0,
    fontSize: 14,
    color: C.txtMuted,
  },

  // ── Search + Sort toolbar ──────────────────────────────────────────────────
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    marginBottom: 28,
    flexWrap: "wrap",
  },
  searchWrap: {
    flex: 1,
    minWidth: 200,
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  searchIcon: {
    position: "absolute",
    left: 14,
    fontSize: 17,
    color: C.txtMuted,
    pointerEvents: "none",
    lineHeight: 1,
    marginTop: 1,
  },
  searchInput: {
    width: "100%",
    padding: "10px 36px 10px 38px",
    background: C.bgSurface,
    border: `1.5px solid ${C.border}`,
    borderRadius: 12,
    color: C.txtPrimary,
    fontSize: 14,
    outline: "none",
    fontFamily: C.font,
    boxSizing: "border-box",
    transition: "border-color 0.15s",
  },
  searchClear: {
    position: "absolute",
    right: 12,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: C.txtMuted,
    fontSize: 13,
    lineHeight: 1,
    padding: 2,
  },
  sortTabs: {
    display: "flex",
    gap: 4,
    background: C.bgSurface,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: 4,
    flexShrink: 0,
  },
  sortTab: {
    padding: "7px 14px",
    background: "transparent",
    border: "none",
    borderRadius: 8,
    color: C.txtSecondary,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: C.font,
    whiteSpace: "nowrap",
    transition: "background 0.12s, color 0.12s",
  },
  sortTabActive: {
    background: C.accentBg,
    color: C.accent,
    boxShadow: "0 1px 6px rgba(167,139,250,0.15)",
  },

  // Grid
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: 18,
  },

  // New card (first slot)
  newCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    minHeight: 175,
    background: "transparent",
    border: `2px dashed ${C.border}`,
    borderRadius: 14,
    cursor: "pointer",
    transition: "border-color 0.15s, background 0.15s",
    userSelect: "none",
  },
  newCardPlus:  { fontSize: 32, color: C.accent, lineHeight: 1, opacity: 0.7 },
  newCardLabel: { fontSize: 14, fontWeight: 500, color: C.txtMuted },

  // Project card
  card: {
    display: "flex",
    flexDirection: "column",
    background: C.bgSubtle,
    border: `1px solid ${C.border}`,
    borderRadius: 14,
    padding: 18,
    cursor: "pointer",
    transition: "border-color 0.15s, transform 0.1s",
    userSelect: "none",
    minHeight: 175,
    gap: 10,
  },
  cardHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  cardIconWrap: {
    width: 40,
    height: 40,
    background: C.accentBg,
    border: `1px solid rgba(167,139,250,0.3)`,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  cardIcon: { fontSize: 20, color: C.accent },
  menuBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: C.txtMuted,
    fontSize: 18,
    lineHeight: 1,
    padding: "4px 8px",
    borderRadius: 6,
  },
  menu: {
    position: "absolute",
    right: 0,
    top: "100%",
    marginTop: 4,
    background: C.bgSurface,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    zIndex: 100,
    minWidth: 140,
    overflow: "hidden",
    boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
  },
  menuItem: {
    display: "block",
    width: "100%",
    padding: "10px 16px",
    background: "transparent",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    fontSize: 13,
    color: C.txtSecondary,
    fontFamily: C.font,
  },
  cardBody: { flex: 1 },
  cardName: {
    margin: "0 0 6px",
    fontSize: 16,
    fontWeight: 600,
    color: C.txtPrimary,
    wordBreak: "break-word",
    lineHeight: 1.35,
  },
  cardMeta: {
    margin: "0 0 3px",
    fontSize: 12,
    color: C.txtMuted,
  },
  cardLastOpened: {
    margin: 0,
    fontSize: 12,
    color: C.txtMuted,
    fontStyle: "italic",
  },
  cardFooter: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
  },
  dtypeBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: "3px 8px",
    background: C.accentBg,
    border: `1px solid rgba(167,139,250,0.3)`,
    borderRadius: 6,
    color: C.accent,
    letterSpacing: "0.04em",
  },
  tableBadge: {
    fontSize: 11,
    padding: "3px 8px",
    background: C.bgSurface,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    color: C.txtSecondary,
    fontFamily: C.mono,
  },
  tableBadgeMore: {
    fontSize: 11,
    padding: "3px 8px",
    background: C.bgSurface,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    color: C.txtMuted,
  },
  emptyBadge: {
    fontSize: 11,
    padding: "3px 8px",
    background: C.bgSurface,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    color: C.txtMuted,
    fontStyle: "italic",
  },

  // Rename input
  renameInput: {
    width: "100%",
    fontSize: 16,
    fontWeight: 600,
    background: C.bgBase,
    border: `1.5px solid ${C.accent}`,
    borderRadius: 8,
    color: C.txtPrimary,
    padding: "4px 8px",
    outline: "none",
    fontFamily: C.font,
    marginBottom: 4,
  },

  // Empty state
  empty: {
    textAlign: "center",
    paddingTop: 90,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
  },
  emptyIcon:  { fontSize: 60, opacity: 0.08, color: C.accent, lineHeight: 1, marginBottom: 10 },
  emptyTitle: { margin: 0, fontSize: 20, fontWeight: 600, color: C.txtSecondary },
  emptySub:   { margin: 0, fontSize: 14, color: C.txtMuted, maxWidth: 340, lineHeight: 1.7 },
  emptyBtn: {
    marginTop: 16,
    padding: "11px 26px",
    background: `linear-gradient(135deg, ${C.accent}, #8b6cf6)`,
    color: "#fff",
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 14,
    fontFamily: C.font,
    boxShadow: "0 2px 12px rgba(167,139,250,0.3)",
  },

  // Modal
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(10,12,20,0.65)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    backdropFilter: "blur(4px)",
  },
  modal: {
    width: 440,
    background: C.bgSubtle,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 32,
    boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
  },
  modalTitle: {
    margin: "0 0 8px",
    fontSize: 20,
    fontWeight: 700,
    color: C.txtPrimary,
  },
  modalSub: {
    margin: "0 0 20px",
    fontSize: 14,
    color: C.txtMuted,
    lineHeight: 1.6,
  },
  modalInput: {
    width: "100%",
    padding: "12px 14px",
    background: C.bgBase,
    border: `1.5px solid ${C.border}`,
    borderRadius: 10,
    color: C.txtPrimary,
    fontSize: 15,
    outline: "none",
    fontFamily: C.font,
    boxSizing: "border-box",
    transition: "border-color 0.15s",
  },
  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 12,
    marginTop: 20,
  },
  modalCancel: {
    padding: "10px 20px",
    background: C.bgSurface,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    color: C.txtSecondary,
    cursor: "pointer",
    fontWeight: 500,
    fontSize: 14,
    fontFamily: C.font,
  },
  modalCreate: {
    padding: "10px 20px",
    background: `linear-gradient(135deg, ${C.accent}, #8b6cf6)`,
    border: "none",
    borderRadius: 10,
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 14,
    fontFamily: C.font,
    boxShadow: "0 2px 8px rgba(167,139,250,0.25)",
  },
};
