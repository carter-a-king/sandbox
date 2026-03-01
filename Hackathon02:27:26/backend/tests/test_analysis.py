"""Unit tests for the deterministic SQL analysis module."""

import pytest
from app.analysis import analyze_sql


class TestAnalyzeSQL:
    def test_simple_select(self):
        result = analyze_sql("SELECT id, name FROM users LIMIT 10")
        assert result["statement_type"] == "SELECT"
        assert result["is_destructive"] is False
        assert result["has_limit"] is True
        assert result["risk_score"] == "LOW"

    def test_select_star_medium_risk(self):
        result = analyze_sql("SELECT * FROM users LIMIT 10")
        assert result["has_select_star"] is True
        assert result["risk_score"] == "MEDIUM"

    def test_select_no_limit_medium_risk(self):
        result = analyze_sql("SELECT id FROM users")
        assert result["has_limit"] is False
        assert result["risk_score"] == "MEDIUM"
        assert any("LIMIT" in f for f in result["flags"])

    def test_delete_without_where_high_risk(self):
        result = analyze_sql("DELETE FROM users")
        assert result["statement_type"] == "DELETE"
        assert result["is_destructive"] is True
        assert result["has_where"] is False
        assert result["risk_score"] == "HIGH"

    def test_delete_with_where(self):
        result = analyze_sql("DELETE FROM users WHERE id = 1")
        assert result["is_destructive"] is True
        assert result["has_where"] is True
        assert result["risk_score"] == "HIGH"

    def test_update_without_where_high_risk(self):
        result = analyze_sql("UPDATE users SET name = 'x'")
        assert result["risk_score"] == "HIGH"
        assert result["has_where"] is False

    def test_drop_table_high_risk(self):
        result = analyze_sql("DROP TABLE users")
        assert result["risk_score"] == "HIGH"
        assert result["is_destructive"] is True

    def test_truncate_high_risk(self):
        result = analyze_sql("TRUNCATE TABLE users")
        assert result["risk_score"] == "HIGH"

    def test_alter_high_risk(self):
        result = analyze_sql("ALTER TABLE users ADD COLUMN age INT")
        assert result["risk_score"] == "HIGH"

    def test_insert_is_destructive(self):
        result = analyze_sql("INSERT INTO users (name) VALUES ('test')")
        assert result["is_destructive"] is True
        assert result["risk_score"] == "HIGH"

    def test_create_is_destructive(self):
        result = analyze_sql("CREATE TABLE test (id INT)")
        assert result["is_destructive"] is True
        assert result["risk_score"] == "HIGH"

    def test_empty_query(self):
        result = analyze_sql("")
        assert result["statement_type"] == "UNKNOWN"

    def test_safe_query_flags(self):
        result = analyze_sql("SELECT id FROM users WHERE active = true LIMIT 10")
        assert result["risk_score"] == "LOW"
        assert "Query looks safe" in result["flags"]
