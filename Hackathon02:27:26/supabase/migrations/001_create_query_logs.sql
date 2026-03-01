-- Create query_logs table for persisting preflight results
CREATE TABLE IF NOT EXISTS query_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT now(),
    sql_text TEXT NOT NULL,
    statement_type TEXT,
    risk_score TEXT,
    is_destructive BOOLEAN DEFAULT FALSE,
    deterministic_flags JSONB,
    ai_summary TEXT,
    ai_risk_level TEXT,
    ai_flags JSONB,
    suggested_safe_sql TEXT
);

-- Enable Row Level Security (allow all for demo; lock down in production)
ALTER TABLE query_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to query_logs" ON query_logs
    FOR ALL USING (true) WITH CHECK (true);
