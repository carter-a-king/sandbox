"""DuckDB dataset manager — handles uploads, schema extraction, and query execution."""

from __future__ import annotations

import os
import re
import uuid
import tempfile
import shutil
from pathlib import Path
from typing import Any

import threading
import concurrent.futures

import duckdb
import pandas as pd


UPLOAD_DIR = Path(tempfile.gettempdir()) / "sql_preflight_uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# In-memory registry: dataset_id -> metadata
_datasets: dict[str, dict] = {}

# Shared DuckDB connection — guarded by _lock to prevent concurrent-access crashes
_conn = duckdb.connect()
_conn.execute("SET memory_limit='512MB'")
_conn.execute("SET threads=2")
_lock = threading.Lock()

QUERY_TIMEOUT_SECONDS = 30


def _sanitize_table_name(name: str) -> str:
    """Make a string safe to use as a SQL table name."""
    name = re.sub(r"[^\w]", "_", name)
    if name and name[0].isdigit():
        name = "t_" + name
    return name or "data"


def register_csv(file_path: str, dataset_id: str, table_name: str = "data") -> dict:
    """Register a CSV file as a DuckDB table (via pandas for reliable header detection)."""
    table_name = _sanitize_table_name(table_name)
    df = pd.read_csv(file_path)
    with _lock:
        _conn.execute(f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM df')
    meta = {
        "id": dataset_id,
        "type": "csv",
        "path": file_path,
        "tables": [table_name],
        "conn_type": "shared",
    }
    _datasets[dataset_id] = meta
    return meta


def register_xlsx(file_path: str, dataset_id: str, table_name: str = "data") -> dict:
    """Register an XLSX file as a DuckDB table via pandas."""
    table_name = _sanitize_table_name(table_name)
    df = pd.read_excel(file_path, engine="openpyxl")
    with _lock:
        _conn.execute(f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM df')
    meta = {
        "id": dataset_id,
        "type": "xlsx",
        "path": file_path,
        "tables": [table_name],
        "conn_type": "shared",
    }
    _datasets[dataset_id] = meta
    return meta


def _load_sqlite_ext() -> None:
    """Ensure the sqlite extension is installed and loaded (idempotent)."""
    # Called only while _lock is already held by register_db
    try:
        _conn.execute("LOAD sqlite")
    except Exception:
        _conn.execute("INSTALL sqlite")
        _conn.execute("LOAD sqlite")


def register_db(file_path: str, dataset_id: str) -> dict:
    """Attach a .db / .sqlite file and enumerate its tables."""
    ext = Path(file_path).suffix.lower()
    alias = f"ds_{dataset_id.replace('-', '_')[:16]}"

    with _lock:
        if ext in (".sqlite", ".sqlite3"):
            _load_sqlite_ext()
            _conn.execute(f"ATTACH '{file_path}' AS \"{alias}\" (TYPE sqlite)")
        elif ext == ".db":
            # .db is almost always SQLite; try that first, fall back to DuckDB
            try:
                _load_sqlite_ext()
                _conn.execute(f"ATTACH '{file_path}' AS \"{alias}\" (TYPE sqlite)")
            except Exception:
                _conn.execute(f"ATTACH '{file_path}' AS \"{alias}\"")
        else:
            _conn.execute(f"ATTACH '{file_path}' AS \"{alias}\"")

    tables = _list_tables(alias)
    meta = {
        "id": dataset_id,
        "type": "db",
        "path": file_path,
        "tables": tables,
        "conn_type": "shared",
        "alias": alias,
    }
    _datasets[dataset_id] = meta
    return meta


def get_dataset(dataset_id: str) -> dict | None:
    return _datasets.get(dataset_id)


def get_schema(dataset_id: str) -> dict:
    """Extract full schema for a dataset including columns, PKs, FKs, and ERD."""
    meta = _datasets.get(dataset_id)
    if not meta:
        raise ValueError(f"Dataset {dataset_id} not found")

    tables_schema = []
    relationships = []
    inferred_relationships = []

    for tbl in meta["tables"]:
        qualified = f"\"{meta.get('alias', 'main')}\".\"{tbl}\"" if meta.get("alias") else f"\"{tbl}\""
        cols = _describe_table(qualified, tbl, meta)
        pk = _get_primary_key(tbl, meta)
        fks = _get_foreign_keys(tbl, meta)

        tables_schema.append({
            "name": tbl,
            "columns": cols,
            "primary_key": pk,
            "foreign_keys": fks,
        })

        for fk in fks:
            relationships.append({
                "from_table": tbl,
                "from_column": fk["column"],
                "to_table": fk["ref_table"],
                "to_column": fk["ref_column"],
            })

    # Heuristic relationship inference
    # Build a map of table_name_lower -> (table_name, likely_pk_col)
    # First use explicit PKs, then infer from naming conventions
    
    def _singular(name: str) -> str:
        """Very lightweight plural→singular used only for FK name matching."""
        if name.endswith("ies"):
            return name[:-3] + "y"
        if name.endswith("sses") or name.endswith("xes") or name.endswith("ches"):
            return name[:-2]
        if name.endswith("s") and len(name) > 2:
            return name[:-1]
        return name

    def _infer_pk_column(table_name: str, columns: list[dict]) -> str | None:
        """Infer the primary key column for a table based on naming conventions."""
        col_names = [c["name"] for c in columns]
        col_names_lower = {c.lower(): c for c in col_names}
        
        # Common PK naming patterns (in priority order)
        candidates = [
            f"{table_name}id",           # CustomersID, EmployeesID
            f"{_singular(table_name)}id", # CustomerID, EmployeeID  
            f"{table_name}_id",           # customers_id
            f"{_singular(table_name)}_id", # customer_id
            "id",                          # id
        ]
        
        for candidate in candidates:
            if candidate.lower() in col_names_lower:
                return col_names_lower[candidate.lower()]
        
        # Check if first column ends with "ID" (common pattern)
        if col_names and col_names[0].lower().endswith("id"):
            return col_names[0]
        
        return None

    # Build table info with PKs (explicit or inferred)
    table_pk_map: dict[str, tuple[str, str]] = {}  # table_lower -> (table_name, pk_col)
    for ts in tables_schema:
        pk_col = None
        if ts["primary_key"]:
            pk_col = ts["primary_key"][0]  # Use first PK column
        else:
            pk_col = _infer_pk_column(ts["name"], ts["columns"])
        
        if pk_col:
            table_pk_map[ts["name"].lower()] = (ts["name"], pk_col)
            # Also store singular form for matching
            singular = _singular(ts["name"].lower())
            if singular != ts["name"].lower():
                table_pk_map[singular] = (ts["name"], pk_col)

    # Now find relationships by matching FK columns to table PKs
    for ts in tables_schema:
        for col in ts["columns"]:
            col_name = col["name"]
            col_lower = col_name.lower()
            
            # Skip if this is the table's own PK
            table_info = table_pk_map.get(ts["name"].lower())
            if table_info and col_name == table_info[1]:
                continue
            
            # Look for columns that could be foreign keys
            # Pattern 1: ColumnID or Column_ID -> look for table named "Column" or "Columns"
            ref_table_name = None
            ref_col = None
            
            if col_lower.endswith("_id"):
                # e.g., customer_id -> look for customers/customer table
                base = col_lower[:-3]  # Remove "_id"
                for variant in [base, base + "s", base + "es"]:
                    if variant in table_pk_map:
                        ref_table_name, ref_col = table_pk_map[variant]
                        break
            elif col_lower.endswith("id") and len(col_lower) > 2:
                # e.g., CustomerID -> look for customers/customer table
                base = col_lower[:-2]  # Remove "id"
                for variant in [base, base + "s", base + "es"]:
                    if variant in table_pk_map:
                        ref_table_name, ref_col = table_pk_map[variant]
                        break
            
            if ref_table_name and ref_table_name != ts["name"]:
                # Check not already in explicit relationships
                already_fk = any(
                    r["from_table"] == ts["name"] and r["from_column"] == col_name
                    for r in relationships + inferred_relationships
                )
                if not already_fk:
                    inferred_relationships.append({
                        "from_table": ts["name"],
                        "from_column": col_name,
                        "to_table": ref_table_name,
                        "to_column": ref_col,
                        "confidence": "medium",
                    })

    # Pattern 2: Exact column name match FOR ID-like columns only
    # Only connect tables with matching ID columns (more selective to avoid clutter)
    generic_columns = {"id", "name", "description", "created_at", "updated_at", "created", "updated", 
                       "date", "status", "type", "value", "count", "amount", "notes", "active",
                       "address", "city", "region", "postalcode", "country", "phone", "fax", "email",
                       "companyname", "contactname", "contacttitle", "title", "firstname", "lastname"}
    
    # Build column -> tables map (only for ID-like columns)
    column_to_tables: dict[str, list[tuple[str, str]]] = {}
    for ts in tables_schema:
        for col in ts["columns"]:
            col_lower = col["name"].lower()
            # Only consider columns that look like IDs
            if col_lower not in generic_columns and (col_lower.endswith("id") or col_lower.endswith("_id") or col_lower.endswith("code")):
                if col_lower not in column_to_tables:
                    column_to_tables[col_lower] = []
                column_to_tables[col_lower].append((ts["name"], col["name"]))
    
    # Create relationships for shared columns
    for col_lower, table_list in column_to_tables.items():
        if len(table_list) >= 2:
            # Connect all pairs, prefer table with PK on this column as target
            for i, (t1, c1) in enumerate(table_list):
                for t2, c2 in table_list[i+1:]:
                    # Check if already have a relationship
                    already_rel = any(
                        (r["from_table"] == t1 and r["to_table"] == t2) or 
                        (r["from_table"] == t2 and r["to_table"] == t1)
                        for r in relationships + inferred_relationships
                    )
                    if already_rel:
                        continue
                    
                    # Determine direction: table with PK on this column is the target
                    t1_pk = table_pk_map.get(t1.lower(), (None, None))[1]
                    t2_pk = table_pk_map.get(t2.lower(), (None, None))[1]
                    
                    if t2_pk and t2_pk.lower() == col_lower:
                        from_t, from_c, to_t, to_c = t1, c1, t2, c2
                    elif t1_pk and t1_pk.lower() == col_lower:
                        from_t, from_c, to_t, to_c = t2, c2, t1, c1
                    else:
                        # Neither is PK, pick smaller table as source
                        t1_size = len(next((ts["columns"] for ts in tables_schema if ts["name"] == t1), []))
                        t2_size = len(next((ts["columns"] for ts in tables_schema if ts["name"] == t2), []))
                        if t1_size <= t2_size:
                            from_t, from_c, to_t, to_c = t1, c1, t2, c2
                        else:
                            from_t, from_c, to_t, to_c = t2, c2, t1, c1
                    
                    inferred_relationships.append({
                        "from_table": from_t,
                        "from_column": from_c,
                        "to_table": to_t,
                        "to_column": to_c,
                        "confidence": "low",  # lower confidence for name-only match
                    })

    mermaid_erd = _build_mermaid_erd(tables_schema, relationships, inferred_relationships)

    return {
        "tables": tables_schema,
        "relationships": relationships,
        "inferred_relationships": inferred_relationships,
        "mermaid_erd": mermaid_erd,
    }


def execute_query(dataset_id: str, sql: str, limit: int = 200, no_limit: bool = False) -> list[dict]:
    """Execute a SELECT query against the dataset and return rows.

    Runs inside a thread so we can enforce a hard timeout without blocking
    the event loop. The lock ensures only one query touches _conn at a time.
    """
    meta = _datasets.get(dataset_id)
    if not meta:
        raise ValueError(f"Dataset {dataset_id} not found")

    # Add LIMIT if not present (skip when exporting all rows)
    if not no_limit:
        upper = sql.strip().rstrip(";").upper()
        if "LIMIT" not in upper:
            sql = sql.strip().rstrip(";") + f" LIMIT {limit}"

    def _run() -> list[dict]:
        with _lock:
            # For attached DBs, switch active catalog so unqualified names resolve
            if meta.get("alias"):
                _conn.execute(f'USE "{meta["alias"]}"')
            result = _conn.execute(sql)
            columns = [desc[0] for desc in result.description]
            rows = result.fetchall()
            return [dict(zip(columns, row)) for row in rows]

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_run)
        try:
            return future.result(timeout=QUERY_TIMEOUT_SECONDS)
        except concurrent.futures.TimeoutError:
            raise TimeoutError(
                f"Query timed out after {QUERY_TIMEOUT_SECONDS} seconds. "
                "Try adding a LIMIT clause or simplifying the query."
            )


def save_upload(upload_file, filename: str) -> tuple[str, str]:
    """Copy uploaded file to the uploads directory and return (dataset_id, file_path).

    Uses shutil.copyfileobj to stream in 1 MB chunks so memory stays flat
    regardless of file size (handles multi-GB files).
    """
    dataset_id = str(uuid.uuid4())
    ext = Path(filename).suffix
    dest = UPLOAD_DIR / f"{dataset_id}{ext}"
    upload_file.file.seek(0)
    with open(dest, "wb") as out:
        shutil.copyfileobj(upload_file.file, out, length=1024 * 1024)
    return dataset_id, str(dest)


# ---- Internal helpers ----

def _list_tables(alias: str) -> list[str]:
    """Try several strategies to list tables in an attached database."""
    queries = [
        f"SELECT table_name FROM information_schema.tables WHERE table_catalog = '{alias}' AND table_type = 'BASE TABLE'",
        f"SELECT table_name FROM information_schema.tables WHERE table_catalog = '{alias}'",
        f"SELECT table_name FROM information_schema.tables WHERE table_schema = '{alias}'",
    ]
    with _lock:
        for q in queries:
            try:
                rows = _conn.execute(q).fetchall()
                if rows:
                    return [r[0] for r in rows if not r[0].startswith("sqlite_")]
            except Exception:
                pass

        # Fallback: PRAGMA table_list (works for SQLite-attached databases)
        try:
            rows = _conn.execute(f"PRAGMA \"{alias}\".table_list").fetchall()
            if rows:
                # Returns: schema, name, type, ncol, wr, strict
                return [r[1] for r in rows if not r[1].startswith("sqlite_")]
        except Exception:
            pass

        # Fallback: SHOW TABLES FROM alias
        try:
            rows = _conn.execute(f'SHOW TABLES FROM "{alias}"').fetchall()
            if rows:
                return [r[0] for r in rows if not r[0].startswith("sqlite_")]
        except Exception:
            pass

    return []


def _run_pragma(alias: str, pragma: str):
    """Run a PRAGMA against an attached database by switching catalog first.

    DuckDB 1.1.x doesn't support PRAGMA "alias".func() syntax, so we
    USE the catalog, run the pragma, and switch back to memory.
    """
    with _lock:
        try:
            _conn.execute(f'USE "{alias}"')
            rows = _conn.execute(pragma).fetchall()
            return rows
        finally:
            try:
                _conn.execute("USE memory")
            except Exception:
                pass


def _describe_table(qualified_name: str, table_name: str, meta: dict) -> list[dict]:
    describe_rows = []

    with _lock:
        # For .db (SQLite) files, use information_schema which returns proper DuckDB-mapped types
        if meta.get("type") == "db":
            alias = meta.get("alias", "main")
            try:
                info_rows = _conn.execute(
                    "SELECT column_name, data_type, is_nullable "
                    "FROM information_schema.columns "
                    f"WHERE table_catalog = '{alias}' AND table_name = '{table_name}' "
                    "ORDER BY ordinal_position"
                ).fetchall()
                if info_rows:
                    describe_rows = [
                        (r[0], r[1], None, "NO" if r[2] == "NO" else "YES")
                        for r in info_rows
                    ]
            except Exception:
                pass

        # Fallback for .db: DESCRIBE SELECT (works when info_schema misses)
        if not describe_rows and meta.get("type") == "db":
            try:
                rows = _conn.execute(f"DESCRIBE SELECT * FROM {qualified_name}").fetchall()
                if rows:
                    describe_rows = [
                        (r[0], r[1], None, r[2] if len(r) > 2 else "YES")
                        for r in rows
                    ]
            except Exception:
                pass

        # Strategy for non-db: DESCRIBE (works for DuckDB native / CSV / XLSX tables)
        if not describe_rows:
            try:
                describe_rows = _conn.execute(f"DESCRIBE {qualified_name}").fetchall()
            except Exception:
                pass

        # Last resort: SELECT * LIMIT 0 — gets names but not types
        if not describe_rows:
            try:
                result = _conn.execute(f"SELECT * FROM {qualified_name} LIMIT 0")
                describe_rows = [(d[0], "TEXT", None, "YES") for d in result.description]
            except Exception:
                return []

        # Read the first data row for sample values
        try:
            first_row_result = _conn.execute(f"SELECT * FROM {qualified_name} LIMIT 1").fetchone()
            meta_result = _conn.execute(f"SELECT * FROM {qualified_name} LIMIT 0")
            first_row_cols = [d[0] for d in meta_result.description]
            first_row = dict(zip(first_row_cols, first_row_result)) if first_row_result else {}
        except Exception:
            first_row = {}

    columns = []
    for row in describe_rows:
        col_name = row[0]
        col_type = row[1]
        nullable = row[3] != "NO" if len(row) > 3 else True
        sample = first_row.get(col_name)
        sample_values = [str(sample)] if sample is not None else []

        columns.append({
            "name": col_name,
            "type": str(col_type),
            "nullable": nullable,
            "sample_values": sample_values,
        })
    return columns


def _get_primary_key(table_name: str, meta: dict) -> list[str] | None:
    if meta["type"] != "db":
        return None
    alias = meta.get("alias", "main")
    try:
        rows = _run_pragma(alias, f"PRAGMA table_info('{table_name}')")
        pks = [r[1] for r in rows if r[5] > 0]
        return pks if pks else None
    except Exception:
        return None


def _get_foreign_keys(table_name: str, meta: dict) -> list[dict]:
    if meta["type"] != "db":
        return []
    alias = meta.get("alias", "main")
    try:
        rows = _run_pragma(alias, f"PRAGMA foreign_key_list('{table_name}')")
        return [
            {"column": r[3], "ref_table": r[2], "ref_column": r[4]}
            for r in rows
        ]
    except Exception:
        return []


def _mermaid_id(s: str) -> str:
    """Sanitize a string to a valid mermaid identifier (alphanumeric + underscore)."""
    s = re.sub(r"[^A-Za-z0-9_]", "_", str(s))
    if s and s[0].isdigit():
        s = "c_" + s
    return s or "col"


def _mermaid_type(type_str: str) -> str:
    """Extract the base type and sanitize it for mermaid (e.g. VARCHAR(255) -> VARCHAR)."""
    base = re.split(r"[\s(]", str(type_str))[0]
    return _mermaid_id(base) or "VARCHAR"


def _build_mermaid_erd(
    tables: list[dict],
    relationships: list[dict],
    inferred: list[dict],
) -> str | None:
    if not tables:
        return None

    lines = ["erDiagram"]

    for tbl in tables:
        if not tbl["columns"]:
            continue  # mermaid erDiagram rejects empty entity blocks
        tbl_id = _mermaid_id(tbl["name"])
        lines.append(f"    {tbl_id} {{")
        for col in tbl["columns"]:
            col_id = _mermaid_id(col["name"])
            dtype = _mermaid_type(col["type"])
            pk_marker = " PK" if tbl.get("primary_key") and col["name"] in tbl["primary_key"] else ""
            fk_marker = ""
            for fk in tbl.get("foreign_keys", []):
                if fk["column"] == col["name"]:
                    fk_marker = " FK"
            lines.append(f"        {dtype} {col_id}{pk_marker}{fk_marker}")
        lines.append("    }")

    for rel in relationships:
        from_id = _mermaid_id(rel["from_table"])
        to_id = _mermaid_id(rel["to_table"])
        col_id = _mermaid_id(rel["from_column"])
        lines.append(f'    {from_id} }}o--|| {to_id} : "{col_id}"')

    for rel in inferred:
        from_id = _mermaid_id(rel["from_table"])
        to_id = _mermaid_id(rel["to_table"])
        col_id = _mermaid_id(rel["from_column"])
        lines.append(f'    {from_id} }}o..|| {to_id} : "{col_id}_inferred"')

    return "\n".join(lines)
