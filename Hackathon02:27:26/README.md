# SQL Preflight

A visual SQL query builder for non-technical users. Upload a CSV, XLSX, or DuckDB/SQLite file and SQL Preflight generates an interactive Entity Relationship Diagram. Drag and drop fields from the ERD to build SELECT, JOIN, and WHERE clauses without writing any SQL. Each query is scored for risk (destructive operations, performance issues, syntax errors) and explained in plain English via an AI summary.

**Stack:** React + Vite (port 3000) · FastAPI + DuckDB (port 8000) · Supabase (auth, query logs, edge function → OpenAI)

---

## Setup & Run

### 1. Environment variables

No setup needed to run the core app — all variables have working defaults.

To enable AI-powered query summaries (optional), edit `backend/.env` with your Supabase credentials:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_EDGE_FUNCTION_URL=https://your-project.supabase.co/functions/v1/preflight-summary
```

Without these, the app runs fine and returns deterministic SQL analysis only.

### 2. Backend (Python 3.9+)

```bash
cd backend
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 3. Frontend (Node 18+)

```bash
cd frontend
npm install
npm run dev                   # runs on http://localhost:3000
```

### 4. Supabase (optional — needed for auth and AI summaries)

- Create a project at [supabase.com](https://supabase.com)
- Run `supabase/migrations/001_create_query_logs.sql` in the SQL editor
- Deploy the edge function in `supabase/functions/preflight-summary/`
- Add your project URL and keys to `backend/.env`

### 5. Run backend tests

```bash
cd backend
pytest
```
