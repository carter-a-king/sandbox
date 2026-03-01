"""Deterministic SQL analysis, risk scoring, and plain-English description using sqlparse."""

from __future__ import annotations

import re
import sqlparse
from sqlparse.sql import Statement
from sqlparse.tokens import Keyword, DML


DESTRUCTIVE_KEYWORDS = {"UPDATE", "DELETE", "INSERT", "CREATE", "DROP", "ALTER", "TRUNCATE"}


def analyze_sql(sql: str) -> dict:
    """Perform deterministic analysis on a SQL string.

    Returns a dict with:
      - statement_type: e.g. "SELECT", "UPDATE"
      - is_destructive: bool
      - has_where: bool
      - has_select_star: bool
      - has_limit: bool
      - risk_score: "LOW" | "MEDIUM" | "HIGH"
      - flags: list of human-readable warning strings
    """
    parsed = sqlparse.parse(sql)
    if not parsed:
        return _empty_analysis("UNKNOWN")

    stmt: Statement = parsed[0]
    stmt_type = stmt.get_type() or "UNKNOWN"
    stmt_type = stmt_type.upper()

    upper_sql = sql.upper()
    tokens_upper = [str(t).strip().upper() for t in stmt.flatten()]

    is_destructive = stmt_type in DESTRUCTIVE_KEYWORDS or any(
        kw in tokens_upper for kw in DESTRUCTIVE_KEYWORDS
    )
    has_where = "WHERE" in tokens_upper
    has_select_star = "SELECT" in tokens_upper and "*" in tokens_upper
    has_limit = "LIMIT" in tokens_upper

    flags = []
    risk_score = "LOW"

    if stmt_type in ("DROP", "TRUNCATE", "ALTER"):
        risk_score = "HIGH"
        flags.append(f"{stmt_type} statement detected — high risk")
    elif stmt_type in ("UPDATE", "DELETE") and not has_where:
        risk_score = "HIGH"
        flags.append(f"{stmt_type} without WHERE clause — affects all rows")
    elif is_destructive:
        risk_score = "HIGH"
        flags.append("Destructive operation detected")

    if risk_score != "HIGH":
        if has_select_star:
            risk_score = "MEDIUM"
            flags.append("SELECT * may return excessive columns")
        if stmt_type == "SELECT" and not has_limit:
            if risk_score == "LOW":
                risk_score = "MEDIUM"
            flags.append("No LIMIT clause — may return many rows")

    if not flags:
        flags.append("Query looks safe")

    return {
        "statement_type": stmt_type,
        "is_destructive": is_destructive,
        "has_where": has_where,
        "has_select_star": has_select_star,
        "has_limit": has_limit,
        "risk_score": risk_score,
        "flags": flags,
    }


def _empty_analysis(stmt_type: str) -> dict:
    return {
        "statement_type": stmt_type,
        "is_destructive": False,
        "has_where": False,
        "has_select_star": False,
        "has_limit": False,
        "risk_score": "LOW",
        "flags": ["Unable to parse query"],
    }


# ── Plain-English description generator ────────────────────────────────────────
# Uses regex on the raw SQL string to correctly handle quoted identifiers,
# table aliases, JOINed tables, aggregate functions, GROUP BY, etc.


def _strip_quotes(name: str) -> str:
    """Remove surrounding quotes from an identifier."""
    name = name.strip()
    if len(name) >= 2 and name[0] in ('"', "'", "`") and name[-1] == name[0]:
        return name[1:-1]
    return name


def _clean_col_ref(ref: str) -> str:
    """Clean a column reference like '"E"."LastName"' → 'LastName'."""
    ref = ref.strip()
    # Remove table alias prefix: anything before the last dot
    # Handle patterns like "E"."LastName", E.LastName, `e`.`last_name`
    dot_pattern = re.search(r'^.*?\.\s*(.+)$', ref)
    if dot_pattern:
        ref = dot_pattern.group(1).strip()
    return _strip_quotes(ref)


def _humanize_list(items: list[str]) -> str:
    """Join a list: ['A', 'B', 'C'] → 'A, B, and C'."""
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + ", and " + items[-1]


def _split_top_level(s: str, delimiter: str = ",") -> list[str]:
    """Split string by delimiter, but not inside parentheses."""
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for ch in s:
        if ch == "(":
            depth += 1
            current.append(ch)
        elif ch == ")":
            depth -= 1
            current.append(ch)
        elif ch == delimiter and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def _extract_clause(sql: str, pattern: str) -> str:
    """Extract a SQL clause using a regex pattern. Returns the first group or ''."""
    m = re.search(pattern, sql, re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else ""


def describe_sql(sql: str) -> str:
    """Generate a concise plain-English description of what a SQL query does."""
    sql_clean = sql.strip()
    if not sql_clean:
        return "Empty query."

    parsed = sqlparse.parse(sql_clean)
    if not parsed:
        return "Could not parse the query."

    stmt: Statement = parsed[0]
    stmt_type = (stmt.get_type() or "UNKNOWN").upper()

    # Normalize whitespace for regex matching
    norm = " ".join(sql_clean.split())

    if stmt_type == "SELECT":
        return _describe_select(norm)

    if stmt_type == "INSERT":
        table = _extract_clause(norm, r'\bINTO\s+("(?:[^"]+)"|[\w]+)')
        return f"You are inserting new data into the {_strip_quotes(table or 'a table')} table."

    if stmt_type == "UPDATE":
        table = _extract_clause(norm, r'\bUPDATE\s+("(?:[^"]+)"|[\w]+)')
        table_name = _strip_quotes(table) if table else "a table"
        set_raw = _extract_clause(norm, r'\bSET\s+(.*?)(?:\s+WHERE\b|$)')
        where_raw = _extract_clause(norm, r'\bWHERE\s+(.*?)$')
        cols: list[str] = []
        if set_raw:
            for assignment in _split_top_level(set_raw, ","):
                if "=" in assignment:
                    cols.append(_clean_col_ref(assignment.split("=")[0]))
        parts = ["You are updating"]
        if cols:
            parts.append(f" {_humanize_list(cols)} in")
        parts.append(f" the {table_name} table")
        if where_raw:
            parts.append(f" where {_describe_where_str(where_raw)}")
        else:
            parts.append(" (all rows)")
        return "".join(parts) + "."

    if stmt_type == "DELETE":
        table = _extract_clause(norm, r'\bFROM\s+("(?:[^"]+)"|[\w]+)')
        table_name = _strip_quotes(table) if table else "a table"
        where_raw = _extract_clause(norm, r'\bWHERE\s+(.*?)$')
        if where_raw:
            return f"You are deleting rows from the {table_name} table where {_describe_where_str(where_raw)}."
        return f"You are deleting ALL rows from the {table_name} table."

    if stmt_type == "CREATE":
        obj = _extract_clause(norm, r'\bCREATE\s+(.{3,40}?)(?:\s*\(|$)')
        return f"You are creating {_strip_quotes(obj) if obj else 'an object'}."

    if stmt_type in ("DROP", "TRUNCATE", "ALTER"):
        obj = _extract_clause(norm, rf'\b{stmt_type}\s+(.{{3,40}}?)(?:\s*;|$)')
        return f"You are running {stmt_type} on {_strip_quotes(obj) if obj else 'an object'}."

    return f"You are executing a {stmt_type} statement."


# ── SELECT description ─────────────────────────────────────────────────────────

def _parse_select_columns(select_str: str) -> tuple[list[str], bool]:
    """Parse SELECT column list into human descriptions. Returns (descriptions, has_aggregates)."""
    if not select_str.strip():
        return (["data"], False)

    cols = _split_top_level(select_str, ",")
    descriptions: list[str] = []
    has_agg = False

    for col in cols:
        col = col.strip()
        if not col:
            continue
        col_upper = col.upper().strip()

        if col_upper == "*":
            descriptions.append("all columns")
            continue

        # Check for aggregate: FUNC(...)
        agg_match = re.match(r'(\w+)\s*\((.*)\)\s*(?:AS\s+.+)?$', col, re.IGNORECASE | re.DOTALL)
        if agg_match:
            func = agg_match.group(1).upper()
            inner = agg_match.group(2).strip()
            inner_clean = _clean_col_ref(inner)

            if func == "COUNT":
                has_agg = True
                if inner_clean == "*":
                    descriptions.append("the count of all rows")
                elif inner.strip().upper().startswith("DISTINCT"):
                    rest = inner.strip()[8:].strip()  # skip "DISTINCT"
                    descriptions.append(f"the count of distinct {_clean_col_ref(rest)} values")
                else:
                    descriptions.append(f"the count of {inner_clean}")
            elif func == "SUM":
                has_agg = True
                descriptions.append(f"the total {inner_clean}")
            elif func == "AVG":
                has_agg = True
                descriptions.append(f"the average {inner_clean}")
            elif func == "MIN":
                has_agg = True
                descriptions.append(f"the minimum {inner_clean}")
            elif func == "MAX":
                has_agg = True
                descriptions.append(f"the maximum {inner_clean}")
            else:
                descriptions.append(f"{func}({inner_clean})")
            continue

        # Handle alias: col AS alias
        alias_match = re.match(r'(.+?)\s+AS\s+.+', col, re.IGNORECASE)
        if alias_match:
            col = alias_match.group(1).strip()

        descriptions.append(_clean_col_ref(col))

    return (descriptions, has_agg)


def _describe_select(norm: str) -> str:
    """Build a plain-English description for a SELECT query using the normalized SQL string."""

    # ── Extract clauses ────────────────────────────────────────────────────
    # SELECT columns (between SELECT and FROM)
    select_raw = _extract_clause(norm, r'\bSELECT\s+(.*?)\s+FROM\b')

    # FROM table(s) (stop at JOIN / WHERE / GROUP BY / ORDER BY / HAVING / LIMIT)
    from_raw = _extract_clause(
        norm,
        r'\bFROM\s+(.*?)(?:\s+(?:(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+)?JOIN\b|\s+WHERE\b|\s+GROUP\s+BY\b|\s+ORDER\s+BY\b|\s+HAVING\b|\s+LIMIT\b|$)',
    )

    # JOINed tables — capture the table name from each JOIN clause
    # Handles: JOIN "Table" AS "T" ON …   and   JOIN tablename alias ON …
    join_raw_tables = re.findall(
        r'\bJOIN\s+("(?:[^"]+)"|`(?:[^`]+)`|[\w]+)\s+',
        norm,
        re.IGNORECASE,
    )

    # WHERE
    where_raw = _extract_clause(norm, r'\bWHERE\s+(.*?)(?:\s+GROUP\s+BY\b|\s+ORDER\s+BY\b|\s+HAVING\b|\s+LIMIT\b|$)')

    # GROUP BY
    group_raw = _extract_clause(norm, r'\bGROUP\s+BY\s+(.*?)(?:\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|$)')

    # ORDER BY
    order_raw = _extract_clause(norm, r'\bORDER\s+BY\s+(.*?)(?:\s+LIMIT\b|$)')

    # LIMIT
    limit_raw = _extract_clause(norm, r'\bLIMIT\s+(\d+)')

    # ── Parse columns ──────────────────────────────────────────────────────
    col_descriptions, has_agg = _parse_select_columns(select_raw)

    # ── Parse tables ───────────────────────────────────────────────────────
    tables: list[str] = []
    if from_raw:
        for part in _split_top_level(from_raw, ","):
            # First token is the table name, rest is alias
            tokens = part.strip().split()
            if tokens:
                tables.append(_strip_quotes(tokens[0]))

    for jt in join_raw_tables:
        tables.append(_strip_quotes(jt))

    # Dedupe preserving order
    seen: set[str] = set()
    unique_tables: list[str] = []
    for t in tables:
        if t.lower() not in seen:
            seen.add(t.lower())
            unique_tables.append(t)

    # ── Parse GROUP BY ─────────────────────────────────────────────────────
    group_cols: list[str] = []
    if group_raw:
        for g in _split_top_level(group_raw, ","):
            group_cols.append(_clean_col_ref(g))

    # ── Parse ORDER BY ─────────────────────────────────────────────────────
    order_parts: list[str] = []
    if order_raw:
        for o in _split_top_level(order_raw, ","):
            o = o.strip()
            direction = ""
            if re.search(r'\bDESC\s*$', o, re.IGNORECASE):
                direction = " (descending)"
                o = re.sub(r'\s+DESC\s*$', '', o, flags=re.IGNORECASE)
            elif re.search(r'\bASC\s*$', o, re.IGNORECASE):
                direction = " (ascending)"
                o = re.sub(r'\s+ASC\s*$', '', o, flags=re.IGNORECASE)
            order_parts.append(_clean_col_ref(o) + direction)

    # ── Parse WHERE ────────────────────────────────────────────────────────
    where_desc = _describe_where_str(where_raw) if where_raw else ""

    # ── Assemble description ───────────────────────────────────────────────
    parts: list[str] = ["You are viewing"]

    if col_descriptions:
        parts.append(f" {_humanize_list(col_descriptions)}")
    else:
        parts.append(" data")

    if unique_tables:
        if len(unique_tables) == 1:
            parts.append(f" from the {unique_tables[0]} table")
        else:
            parts.append(f" from the {_humanize_list(unique_tables)} tables")

    if where_desc:
        parts.append(f" where {where_desc}")

    # GROUP BY — hierarchical description
    if group_cols:
        parts.append(f", grouped by {group_cols[0]}")
        for gc in group_cols[1:]:
            parts.append(f", then by {gc}")

    if order_parts:
        parts.append(f", sorted by {_humanize_list(order_parts)}")

    if limit_raw:
        parts.append(f", limited to {limit_raw} rows")

    return "".join(parts) + "."


def _singularize(word: str) -> str:
    """Simple singularizer for common table-name patterns."""
    w = word.lower()
    if w.endswith("ies") and len(w) > 4:
        return word[:-3] + "y"
    if w.endswith(("ses", "xes", "zes")) and len(w) > 4:
        return word[:-2]
    if w.endswith("s") and not w.endswith("ss") and len(w) > 2:
        return word[:-1]
    return word


def _extract_aggregates_for_groupby(select_str: str, entity_plural: str, group_col: str) -> list[str]:
    """Return GROUP BY aggregate sentences like 'COUNT(*) then calculates …'."""
    if not select_str.strip():
        return []
    lines: list[str] = []
    for col in _split_top_level(select_str, ","):
        col = col.strip()
        m = re.match(r"(\w+)\s*\((.*)\)\s*(?:AS\s+.+)?$", col, re.IGNORECASE | re.DOTALL)
        if not m:
            continue
        func = m.group(1).upper()
        inner = m.group(2).strip()
        inner_clean = _clean_col_ref(inner)
        if func == "COUNT":
            if inner_clean == "*":
                lines.append(f"COUNT(*) then calculates how many {entity_plural} belong to each {group_col}.")
            elif inner.upper().startswith("DISTINCT"):
                rest = _clean_col_ref(inner[8:].strip())
                lines.append(f"COUNT(DISTINCT {rest}) then calculates how many distinct {rest} values belong to each {group_col}.")
            else:
                lines.append(f"COUNT({inner_clean}) then calculates the number of {inner_clean} values in each {group_col}.")
        elif func == "SUM":
            lines.append(f"SUM({inner_clean}) then calculates the total {inner_clean} for each {group_col}.")
        elif func == "AVG":
            lines.append(f"AVG({inner_clean}) then calculates the average {inner_clean} for each {group_col}.")
        elif func == "MIN":
            lines.append(f"MIN({inner_clean}) then calculates the minimum {inner_clean} for each {group_col}.")
        elif func == "MAX":
            lines.append(f"MAX({inner_clean}) then calculates the maximum {inner_clean} for each {group_col}.")
    return lines


def describe_sql_clauses(sql: str) -> list[dict]:
    """Return a per-clause structured breakdown of what a SQL query does.

    Each item is {"label": str, "lines": [str, ...]} where label is the
    clause keyword (SELECT, FROM, WHERE, …) and lines are plain-English
    sentences describing that clause's role in this specific query.
    """
    sql_clean = sql.strip()
    if not sql_clean:
        return []

    parsed = sqlparse.parse(sql_clean)
    if not parsed:
        return []

    stmt: Statement = parsed[0]
    stmt_type = (stmt.get_type() or "UNKNOWN").upper()

    # For non-SELECT statements return a single entry.
    if stmt_type != "SELECT":
        return [{"label": stmt_type, "lines": [describe_sql(sql_clean)]}]

    norm = " ".join(sql_clean.split())

    # ── Clause extraction ───────────────────────────────────────────────────
    select_raw = _extract_clause(norm, r"\bSELECT\s+(.*?)\s+FROM\b")
    from_raw = _extract_clause(
        norm,
        r"\bFROM\s+(.*?)(?:\s+(?:(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+)?JOIN\b|\s+WHERE\b|\s+GROUP\s+BY\b|\s+ORDER\s+BY\b|\s+HAVING\b|\s+LIMIT\b|$)",
    )
    join_raw_tables = re.findall(
        r"\bJOIN\s+(\"(?:[^\"]+)\"|`(?:[^`]+)`|[\w]+)\s+", norm, re.IGNORECASE
    )
    where_raw = _extract_clause(
        norm,
        r"\bWHERE\s+(.*?)(?:\s+GROUP\s+BY\b|\s+ORDER\s+BY\b|\s+HAVING\b|\s+LIMIT\b|$)",
    )
    group_raw = _extract_clause(
        norm, r"\bGROUP\s+BY\s+(.*?)(?:\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|$)"
    )
    having_raw = _extract_clause(
        norm, r"\bHAVING\s+(.*?)(?:\s+ORDER\s+BY\b|\s+LIMIT\b|$)"
    )
    order_raw = _extract_clause(norm, r"\bORDER\s+BY\s+(.*?)(?:\s+LIMIT\b|$)")
    limit_raw = _extract_clause(norm, r"\bLIMIT\s+(\d+)")

    has_distinct = bool(re.search(r"\bSELECT\s+DISTINCT\b", norm, re.IGNORECASE))
    select_for_parse = (
        re.sub(r"^DISTINCT\s+", "", select_raw.strip(), flags=re.IGNORECASE)
        if has_distinct
        else select_raw
    )

    col_descriptions, has_agg = _parse_select_columns(select_for_parse)

    # ── Tables ──────────────────────────────────────────────────────────────
    tables: list[str] = []
    if from_raw:
        for part in _split_top_level(from_raw, ","):
            tokens = part.strip().split()
            if tokens:
                tables.append(_strip_quotes(tokens[0]))
    for jt in join_raw_tables:
        tables.append(_strip_quotes(jt))

    seen: set[str] = set()
    unique_tables: list[str] = []
    for t in tables:
        if t.lower() not in seen:
            seen.add(t.lower())
            unique_tables.append(t)

    primary_table = unique_tables[0] if unique_tables else "the table"
    entity_plural = primary_table
    entity_singular = _singularize(primary_table)

    # ── GROUP BY columns ────────────────────────────────────────────────────
    group_cols: list[str] = []
    if group_raw:
        for g in _split_top_level(group_raw, ","):
            group_cols.append(_clean_col_ref(g))

    # ── ORDER BY entries ────────────────────────────────────────────────────
    order_entries: list[tuple[str, str]] = []
    if order_raw:
        for o in _split_top_level(order_raw, ","):
            o = o.strip()
            direction = "asc"
            if re.search(r"\bDESC\s*$", o, re.IGNORECASE):
                direction = "desc"
                o = re.sub(r"\s+DESC\s*$", "", o, flags=re.IGNORECASE)
            elif re.search(r"\bASC\s*$", o, re.IGNORECASE):
                o = re.sub(r"\s+ASC\s*$", "", o, flags=re.IGNORECASE)
            order_entries.append((_clean_col_ref(o), direction))

    clauses: list[dict] = []

    # ── SELECT ──────────────────────────────────────────────────────────────
    select_lines = [
        "The SELECT clause determines which columns will appear in the final result."
    ]
    if col_descriptions:
        if col_descriptions == ["all columns"]:
            select_lines.append(
                f"In this query, all columns from the {primary_table} table will be shown."
            )
        elif has_agg:
            agg_descs = [
                d for d in col_descriptions
                if any(d.startswith(p) for p in ["the count", "the total", "the average", "the minimum", "the maximum"])
            ]
            non_agg = [d for d in col_descriptions if d not in agg_descs]
            if non_agg and agg_descs:
                select_lines.append(
                    f"In this query, {_humanize_list(non_agg)} will be shown, along with {_humanize_list(agg_descs)}."
                )
            else:
                select_lines.append(
                    f"In this query, {_humanize_list(col_descriptions)} will be calculated."
                )
        else:
            select_lines.append(
                f"In this query, only {_humanize_list(col_descriptions)} will be shown for each {entity_singular}."
            )
    clauses.append({"label": "SELECT", "lines": select_lines})

    # ── FROM ────────────────────────────────────────────────────────────────
    if unique_tables:
        if where_raw or group_raw:
            from_detail = (
                f"All rows in the result originate from the {primary_table} table "
                "before any filtering or grouping occurs."
            )
        else:
            from_detail = f"The result includes all rows from the {primary_table} table."
        clauses.append({
            "label": "FROM",
            "lines": ["The FROM clause defines the primary data source.", from_detail],
        })

    # ── JOIN ────────────────────────────────────────────────────────────────
    if len(unique_tables) > 1:
        joined = _humanize_list([f"the {t} table" for t in unique_tables])
        clauses.append({"label": "JOIN", "lines": [f"The query combines {joined}."]})

    # ── DISTINCT ────────────────────────────────────────────────────────────
    if has_distinct:
        if col_descriptions and col_descriptions != ["all columns"]:
            dc = col_descriptions[0]
            distinct_lines = [
                f"This query returns each {dc} only once, "
                f"even if multiple {entity_plural} share the same {dc}."
            ]
        else:
            distinct_lines = ["This query returns each unique row only once."]
        clauses.append({"label": "DISTINCT", "lines": distinct_lines})

    # ── WHERE ───────────────────────────────────────────────────────────────
    if where_raw:
        where_desc = _describe_where_str(where_raw)
        if group_raw:
            where_generic = "The WHERE clause filters individual rows before grouping occurs."
        else:
            where_generic = "The WHERE clause filters which rows appear in the result."
        clauses.append({
            "label": "WHERE",
            "lines": [
                where_generic,
                f"Only {entity_plural} with {where_desc} remain in the result.",
            ],
        })

    # ── GROUP BY ────────────────────────────────────────────────────────────
    if group_raw and group_cols:
        group_col_str = _humanize_list(group_cols)
        group_lines = [
            f"The GROUP BY clause organizes {entity_plural} into categories based on their {group_col_str}.",
        ]
        group_lines.extend(
            _extract_aggregates_for_groupby(select_for_parse, entity_plural, group_cols[0])
        )
        group_lines.append("Each group becomes one row in the result.")
        clauses.append({"label": "GROUP BY", "lines": group_lines})

    # ── HAVING ──────────────────────────────────────────────────────────────
    if having_raw:
        having_desc = _describe_where_str(having_raw)
        having_group = group_cols[0] if group_cols else "category"
        clauses.append({
            "label": "HAVING",
            "lines": [
                f"After grouping {entity_plural} by {having_group}, the HAVING clause filters the groups.",
                f"Only groups where {having_desc} remain in the result.",
            ],
        })

    # ── ORDER BY ────────────────────────────────────────────────────────────
    if order_raw and order_entries:
        order_lines = ["ORDER BY sorts the final result."]
        for col, direction in order_entries:
            if direction == "desc":
                order_lines.append(
                    f"This query arranges {entity_plural} from highest {col} to lowest {col}."
                )
            else:
                order_lines.append(
                    f"This query arranges {entity_plural} from lowest {col} to highest {col}."
                )
        order_lines.append(
            "This does not change which rows appear, it only changes the order they appear in."
        )
        clauses.append({"label": "ORDER BY", "lines": order_lines})

    # ── LIMIT ───────────────────────────────────────────────────────────────
    if limit_raw:
        clauses.append({
            "label": "LIMIT",
            "lines": [f"The result is capped at {limit_raw} rows."],
        })

    return clauses


def _describe_where_str(where_str: str) -> str:
    """Generate a plain-English description from a WHERE clause string."""
    if not where_str.strip():
        return ""
    result = where_str.strip()
    # Clean up qualified column references: "E"."LastName" → LastName
    result = re.sub(r'"[^"]*"\s*\.\s*"([^"]*)"', r'\1', result)
    result = re.sub(r'`[^`]*`\s*\.\s*`([^`]*)`', r'\1', result)
    result = re.sub(r'[\w]+\s*\.\s*(\w+)', r'\1', result)
    # Strip remaining quotes
    result = re.sub(r'"([^"]*)"', r'\1', result)
    result = re.sub(r"'([^']*)'", r'\1', result)
    # Replace operators with words
    result = result.replace(" = ", " equals ")
    result = result.replace(" != ", " does not equal ")
    result = result.replace(" <> ", " does not equal ")
    result = result.replace(" >= ", " is at least ")
    result = result.replace(" <= ", " is at most ")
    result = result.replace(" > ", " is greater than ")
    result = result.replace(" < ", " is less than ")
    return result
