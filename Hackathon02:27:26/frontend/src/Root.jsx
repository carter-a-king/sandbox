import { useState, useCallback, useRef, useEffect } from "react";
import HomePage from "./components/HomePage.jsx";
import App from "./App.jsx";

function navigate(path) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function usePathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const handler = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);
  return pathname;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "sqlpreflight_projects";

function loadProjects() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

function makeProject(name) {
  return {
    id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: name || "Untitled Project",
    createdAt: Date.now(),
    lastOpenedAt: null,
    datasetId: null,
    datasetInfo: null,
    schema: null,
    sql: "",
  };
}

// ── Root ───────────────────────────────────────────────────────────────────────

export default function Root() {
  const pathname = usePathname();
  const [projects, setProjects] = useState(loadProjects);
  const [currentId, setCurrentId] = useState(null);
  const pendingFileRef = useRef(null);

  const currentProject = projects.find((p) => p.id === currentId) ?? null;

  // ── Project CRUD ────────────────────────────────────────────────────────────

  const handleCreate = useCallback((name) => {
    const proj = makeProject(name);
    setProjects((prev) => {
      const next = [proj, ...prev];
      saveProjects(next);
      return next;
    });
    setCurrentId(proj.id);
    navigate("/erd");
  }, []);

  const handleOpen = useCallback((id) => {
    pendingFileRef.current = null;
    setProjects((prev) => {
      const next = prev.map((p) => p.id === id ? { ...p, lastOpenedAt: Date.now() } : p);
      saveProjects(next);
      return next;
    });
    setCurrentId(id);
    navigate("/erd");
  }, []);

  const handleOpenWithFile = useCallback((id, file) => {
    pendingFileRef.current = file;
    setProjects((prev) => {
      const next = prev.map((p) => p.id === id ? { ...p, lastOpenedAt: Date.now() } : p);
      saveProjects(next);
      return next;
    });
    setCurrentId(id);
    navigate("/erd");
  }, []);

  const handleHome = useCallback(() => {
    setCurrentId(null);
    navigate("/home");
  }, []);

  const handleUpdateProject = useCallback((patch) => {
    setProjects((prev) => {
      const next = prev.map((p) =>
        p.id === patch.id ? { ...p, ...patch } : p
      );
      saveProjects(next);
      return next;
    });
  }, []);

  const handleRename = useCallback((id, name) => {
    setProjects((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, name } : p));
      saveProjects(next);
      return next;
    });
  }, []);

  const handleDelete = useCallback((id) => {
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id);
      saveProjects(next);
      return next;
    });
    if (currentId === id) setCurrentId(null);
  }, [currentId]);

  // ── Render ──────────────────────────────────────────────────────────────────

  // Redirect bare / to /home
  if (pathname === "/" || pathname === "") {
    navigate("/home");
    return null;
  }

  if (pathname === "/erd") {
    if (!currentProject) {
      navigate("/home");
      return null;
    }
    return (
      <App
        key={currentProject.id}
        project={currentProject}
        pendingFile={pendingFileRef.current}
        onHome={handleHome}
        onUpdateProject={handleUpdateProject}
        onRenameProject={(name) => handleRename(currentProject.id, name)}
      />
    );
  }

  // /home (default)
  return (
    <HomePage
      projects={projects}
      onCreate={handleCreate}
      onOpen={handleOpen}
      onOpenWithFile={handleOpenWithFile}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  );
}
