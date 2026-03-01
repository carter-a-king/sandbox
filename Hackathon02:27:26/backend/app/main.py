"""FastAPI application — SQL Preflight backend."""

from __future__ import annotations

import csv
import io
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.analysis import analyze_sql, describe_sql, describe_sql_clauses, DESTRUCTIVE_KEYWORDS
from app.database import (
    register_csv,
    register_xlsx,
    register_db,
    get_dataset,
    get_schema,
    execute_query,
    save_upload,
)

load_dotenv()

app = FastAPI(title="SQL Preflight API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:3000")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPABASE_EDGE_URL = os.getenv("SUPABASE_EDGE_FUNCTION_URL", "http://localhost:54321/functions/v1/preflight-summary")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")


# ---- Request / Response models ----

class PreflightRequest(BaseModel):
    sql: str
    dataset_id: str


class RunRequest(BaseModel):
    sql: str
    dataset_id: str
    limit: int = 200
    allow_destructive: bool = False


# ---- Endpoints ----

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Accept CSV, XLSX, or DB file and register in DuckDB."""
    filename = file.filename or "upload"
    ext = Path(filename).suffix.lower()

    if ext not in (".csv", ".xlsx", ".db", ".duckdb", ".sqlite", ".sqlite3"):
        raise HTTPException(400, f"Unsupported file type: {ext}")

    dataset_id, file_path = save_upload(file, filename)
    stem = Path(filename).stem

    try:
        if ext == ".csv":
            meta = register_csv(file_path, dataset_id, table_name=stem)
        elif ext == ".xlsx":
            meta = register_xlsx(file_path, dataset_id, table_name=stem)
        else:
            meta = register_db(file_path, dataset_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to load file: {e}")

    schema = get_schema(dataset_id)

    return {
        "dataset_id": meta["id"],
        "dataset_type": meta["type"],
        "tables": meta["tables"],
        "schema": schema,
    }


@app.post("/preflight")
async def preflight(req: PreflightRequest):
    """Run deterministic analysis + generate plain-English description of the query."""
    ds = get_dataset(req.dataset_id)
    if not ds:
        raise HTTPException(404, "Dataset not found")

    analysis = analyze_sql(req.sql)
    description = describe_sql(req.sql)
    clauses = describe_sql_clauses(req.sql)

    # Call Supabase Edge Function for AI summary (enhanced description)
    ai_summary = None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                SUPABASE_EDGE_URL,
                json={"sql": req.sql, "analysis": analysis},
                headers={
                    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code == 200:
                ai_summary = resp.json()
    except Exception:
        pass  # Fallback to deterministic only

    # Use AI description if available, otherwise use our deterministic one
    final_description = ai_summary.get("summary", description) if ai_summary else description

    return {
        "description": final_description,
        "clauses": clauses,
        "analysis": analysis,
    }


@app.post("/run")
async def run_query(req: RunRequest):
    """Execute SQL query against dataset."""
    ds = get_dataset(req.dataset_id)
    if not ds:
        raise HTTPException(404, "Dataset not found")

    analysis = analyze_sql(req.sql)

    if analysis["is_destructive"] and not req.allow_destructive:
        raise HTTPException(
            403,
            "Destructive SQL blocked. Set allow_destructive=true to override.",
        )

    try:
        rows = execute_query(req.dataset_id, req.sql, limit=req.limit)
    except TimeoutError as e:
        raise HTTPException(408, str(e))
    except Exception as e:
        raise HTTPException(400, f"Query execution failed: {e}")

    return {
        "columns": list(rows[0].keys()) if rows else [],
        "rows": rows,
        "row_count": len(rows),
    }


@app.post("/export")
async def export_query(req: RunRequest):
    """Run query without row limit and return full results as a CSV download."""
    ds = get_dataset(req.dataset_id)
    if not ds:
        raise HTTPException(404, "Dataset not found")

    analysis = analyze_sql(req.sql)
    if analysis["is_destructive"] and not req.allow_destructive:
        raise HTTPException(403, "Destructive SQL blocked.")

    try:
        rows = execute_query(req.dataset_id, req.sql, no_limit=True)
    except TimeoutError as e:
        raise HTTPException(408, str(e))
    except Exception as e:
        raise HTTPException(400, f"Query execution failed: {e}")

    output = io.StringIO()
    if rows:
        writer = csv.DictWriter(output, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    output.seek(0)

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=export.csv"},
    )


@app.get("/schema/{dataset_id}")
async def schema_endpoint(dataset_id: str):
    """Re-fetch schema for a dataset."""
    ds = get_dataset(dataset_id)
    if not ds:
        raise HTTPException(404, "Dataset not found")
    return get_schema(dataset_id)
