const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

export async function uploadFile(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API}/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function preflight(sql, datasetId) {
  const res = await fetch(`${API}/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, dataset_id: datasetId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runQuery(sql, datasetId, limit = 200, allowDestructive = false) {
  const res = await fetch(`${API}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sql,
      dataset_id: datasetId,
      limit,
      allow_destructive: allowDestructive,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSchema(datasetId) {
  const res = await fetch(`${API}/schema/${datasetId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function exportQuery(sql, datasetId) {
  const res = await fetch(`${API}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, dataset_id: datasetId }),
  });
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "export.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
