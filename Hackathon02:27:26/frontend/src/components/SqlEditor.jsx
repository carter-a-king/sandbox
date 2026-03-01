import { useState, useEffect, useRef, useMemo, useCallback } from "react";

const AGGREGATES_NUMERIC = ["NONE", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX", "COUNT DISTINCT"];
const AGGREGATES_STRING = ["NONE", "DISTINCT", "COUNT", "COUNT DISTINCT", "First Alphabetical", "Last Alphabetical"];
const WHERE_OPS_NUMERIC = ["=", "!=", ">", "<", ">=", "<=", "IN", "IS NULL", "IS NOT NULL"];
const WHERE_OPS_STRING = ["=", "!=", "Starts with", "Contains", "Ends with", "IN", "IS NULL", "IS NOT NULL"];
const NO_VALUE_OPS = ["IS NULL", "IS NOT NULL"];

const STRING_TYPES = new Set(["TEXT", "VARCHAR", "NVARCHAR", "CHAR", "NCHAR", "STRING", "CLOB", "CHARACTER VARYING", "VARYING CHARACTER", "NVARCHAR2", "VARCHAR2"]);
function isStringType(colType) {
  if (!colType) return false;
  return STRING_TYPES.has(colType.toUpperCase().replace(/\(.*\)/, "").trim());
}

/** Map display aggregate label to SQL function */
function aggToSql(agg) {
  if (agg === "First Alphabetical") return "MIN";
  if (agg === "Last Alphabetical") return "MAX";
  if (agg === "DISTINCT") return "NONE"; // handled separately in buildSelectStr
  return agg;
}

let _uid = 0;
const uid = () => ++_uid;

// ── Alias generation ──────────────────────────────────────────────────────────

function generateAlias(tableName, existingAliases) {
  const usedSet = new Set(Object.values(existingAliases).map((a) => a.toUpperCase()));
  const upper = tableName.toUpperCase();
  for (let len = 1; len <= tableName.length; len++) {
    const candidate = upper.slice(0, len);
    if (!usedSet.has(candidate)) return candidate;
  }
  let i = 2;
  while (usedSet.has(`${upper}${i}`)) i++;
  return `${upper}${i}`;
}

// ── Relationship graph + BFS join finder ──────────────────────────────────────

function buildRelGraph(schema) {
  const graph = {};
  const allRels = [
    ...(schema.relationships || []),
    ...(schema.inferred_relationships || []),
  ];
  const seen = new Set();
  for (const r of allRels) {
    const key = `${r.from_table}.${r.from_column}->${r.to_table}.${r.to_column}`;
    const revKey = `${r.to_table}.${r.to_column}->${r.from_table}.${r.from_column}`;
    if (seen.has(key) || seen.has(revKey)) continue;
    seen.add(key);
    if (!graph[r.from_table]) graph[r.from_table] = [];
    if (!graph[r.to_table]) graph[r.to_table] = [];
    graph[r.from_table].push({
      neighbor: r.to_table,
      relFromTable: r.from_table,
      relFromCol: r.from_column,
      relToTable: r.to_table,
      relToCol: r.to_column,
    });
    graph[r.to_table].push({
      neighbor: r.from_table,
      relFromTable: r.from_table,
      relFromCol: r.from_column,
      relToTable: r.to_table,
      relToCol: r.to_column,
    });
  }
  return graph;
}

/** BFS from all existing tables to newTable; returns path or null */
function findJoinPath(graph, existingTables, newTable) {
  if (existingTables.has(newTable)) return [];
  const queue = [];
  const cameFrom = new Map();
  for (const t of existingTables) {
    queue.push(t);
    cameFrom.set(t, null);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === newTable) {
      const path = [];
      let node = current;
      while (cameFrom.get(node) !== null) {
        const { prev, edge } = cameFrom.get(node);
        path.unshift({ prevTable: prev, nextTable: node, edge });
        node = prev;
      }
      return path;
    }
    for (const edge of graph[current] || []) {
      if (!cameFrom.has(edge.neighbor)) {
        cameFrom.set(edge.neighbor, { prev: current, edge });
        queue.push(edge.neighbor);
      }
    }
  }
  return null;
}

/** Convert a BFS path step into a join spec */
function stepToJoin(step) {
  const { prevTable, nextTable, edge } = step;
  if (edge.relFromTable === prevTable) {
    return {
      newTable: nextTable,
      existingTable: prevTable,
      existingCol: edge.relFromCol,
      newCol: edge.relToCol,
    };
  }
  return {
    newTable: nextTable,
    existingTable: prevTable,
    existingCol: edge.relToCol,
    newCol: edge.relFromCol,
  };
}

// ── SQL builder ───────────────────────────────────────────────────────────────

function buildSelectStr(items) {
  if (!items.length) return "*";
  return items
    .map((item) => {
      if (item.agg === "DISTINCT") return `DISTINCT ${item.field}`;
      const sqlAgg = aggToSql(item.agg);
      if (sqlAgg === "NONE") return item.field;
      if (sqlAgg === "COUNT DISTINCT") return `COUNT(DISTINCT ${item.field})`;
      return `${sqlAgg}(${item.field})`;
    })
    .join(", ");
}

function buildWhereStr(filters) {
  if (!filters.length) return null;
  return filters
    .map((f, i) => {
      let cond;
      if (f.op === "IS NULL") cond = `${f.field} IS NULL`;
      else if (f.op === "IS NOT NULL") cond = `${f.field} IS NOT NULL`;
      else if (f.op === "Starts with") {
        cond = `${f.field} LIKE '${f.value}%'`;
      } else if (f.op === "Contains") {
        cond = `${f.field} LIKE '%${f.value}%'`;
      } else if (f.op === "Ends with") {
        cond = `${f.field} LIKE '%${f.value}'`;
      } else {
        const numOps = [">", "<", ">=", "<="];
        const isNum =
          numOps.includes(f.op) && /^-?\d+(\.\d+)?$/.test((f.value || "").trim());
        const val = isNum ? f.value : `'${f.value}'`;
        cond = `${f.field} ${f.op} ${val}`;
      }
      return i === 0 ? cond : `${f.conn} ${cond}`;
    })
    .join("\n       ");
}

function q(name) { return `"${name}"`; }

function buildFromStr(base, joinList, aliases) {
  if (!base) return "";
  const baseAlias = aliases[base];
  let result = baseAlias ? `${q(base)} AS ${q(baseAlias)}` : q(base);

  const joinedTables = new Set([base]);
  for (const j of joinList) {
    const eAlias = aliases[j.existingTable] || j.existingTable;
    const nAlias = aliases[j.newTable] || j.newTable;
    result += `\nJOIN ${q(j.newTable)} AS ${q(nAlias)} ON ${q(eAlias)}.${q(j.existingCol)} = ${q(nAlias)}.${q(j.newCol)}`;
    joinedTables.add(j.newTable);
  }

  // Cross-join any table that has an alias but no join path
  for (const [table, alias] of Object.entries(aliases)) {
    if (!joinedTables.has(table)) {
      result += `, ${q(table)} AS ${q(alias)}`;
    }
  }
  return result;
}

function buildHavingStr(havingFilters) {
  const enabled = havingFilters.filter((h) => h.enabled && h.value.trim());
  if (!enabled.length) return null;
  return enabled.map((h) => `${h.expr} ${h.op} ${h.value}`).join(" AND ");
}

function buildSql({ selectItems, from, whereFilters, groupByFields, havingFilters, orderByItems }) {
  if (!from) return "";
  const parts = [`SELECT ${buildSelectStr(selectItems)}`, `FROM ${from}`];
  const whereStr = buildWhereStr(whereFilters);
  if (whereStr) parts.push(`WHERE ${whereStr}`);
  if (groupByFields.length) parts.push(`GROUP BY ${groupByFields.join(", ")}`);
  const havingStr = buildHavingStr(havingFilters);
  if (havingStr) parts.push(`HAVING ${havingStr}`);
  if (orderByItems.length)
    parts.push(
      `ORDER BY ${orderByItems.map((o) => `${o.field} ${o.dir}`).join(", ")}`
    );
  return parts.join("\n");
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SqlEditor({
  onChange,
  onPreflight,
  onRun,
  disabled,
  schema,
  datasetType,
  showPreview = true,
  showButtons = true,
}) {
  const [selectItems, setSelectItems] = useState([]);
  const [whereFilters, setWhereFilters] = useState([]);
  const [groupByFields, setGroupByFields] = useState([]);
  const [havingFilters, setHavingFilters] = useState([]); // [{ id, expr, enabled, op, value }]
  const [orderByItems, setOrderByItems] = useState([]);
  const [from, setFrom] = useState("");

  // Alias / join tracking (DB multi-table mode)
  const [tableAliases, setTableAliases] = useState({}); // { tableName: alias }
  const [baseTable, setBaseTable] = useState(null);
  const [joinList, setJoinList] = useState([]); // [{ newTable, existingTable, existingCol, newCol }]

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const isDb = datasetType === "db";
  const firstTable = schema?.tables?.[0]?.name;
  const hasMultipleTables = (schema?.tables?.length || 0) > 1;

  // Build relationship graph once per schema
  const relGraph = useMemo(() => {
    if (!schema || !isDb) return {};
    return buildRelGraph(schema);
  }, [schema, isDb]);

  // Reset when schema changes
  useEffect(() => {
    setSelectItems([]);
    setWhereFilters([]);
    setGroupByFields([]);
    setHavingFilters([]);
    setOrderByItems([]);
    setTableAliases({});
    setBaseTable(null);
    setJoinList([]);
    if (firstTable && !hasMultipleTables) {
      setFrom(firstTable);
    } else {
      setFrom("");
    }
  }, [schema]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto GROUP BY from non-aggregate SELECT fields
  useEffect(() => {
    const hasAgg = selectItems.some((i) => aggToSql(i.agg) !== "NONE");
    if (hasAgg) {
      const nonAggFields = selectItems
        .filter((i) => aggToSql(i.agg) === "NONE")
        .map((i) => i.field);
      setGroupByFields((prev) => {
        const kept = prev.filter((f) => nonAggFields.includes(f));
        const toAdd = nonAggFields.filter((f) => !kept.includes(f));
        return [...kept, ...toAdd];
      });
    } else {
      setGroupByFields([]);
    }
  }, [selectItems]);

  // Auto-populate HAVING filters from aggregate SELECT items
  useEffect(() => {
    const aggItems = selectItems.filter((i) => aggToSql(i.agg) !== "NONE");
    setHavingFilters((prev) => {
      // Build set of existing expressions so we don't duplicate
      const existingExprs = new Set(prev.map((h) => h.expr));
      // Remove entries whose aggregate expression no longer exists in selectItems
      const currentExprs = new Set(
        aggItems.map((i) => {
          const sqlAgg = aggToSql(i.agg);
          if (sqlAgg === "COUNT DISTINCT") return `COUNT(DISTINCT ${i.field})`;
          return `${sqlAgg}(${i.field})`;
        })
      );
      const kept = prev.filter((h) => currentExprs.has(h.expr));
      // Add new entries for any new aggregates
      const toAdd = aggItems
        .map((i) => {
          const sqlAgg = aggToSql(i.agg);
          const expr =
            sqlAgg === "COUNT DISTINCT"
              ? `COUNT(DISTINCT ${i.field})`
              : `${sqlAgg}(${i.field})`;
          return expr;
        })
        .filter((expr) => !existingExprs.has(expr))
        .map((expr) => ({ id: uid(), expr, enabled: false, op: ">", value: "" }));
      return [...kept, ...toAdd];
    });
  }, [selectItems]);

  // Notify parent whenever SQL changes
  useEffect(() => {
    onChangeRef.current(
      buildSql({ selectItems, from, whereFilters, groupByFields, havingFilters, orderByItems })
    );
  }, [selectItems, from, whereFilters, groupByFields, havingFilters, orderByItems]);

  // ── Add a table to the query, return its alias ────────────────────────────

  const addTableToQuery = useCallback(
    (tableName) => {
      if (!isDb) {
        if (!from) setFrom(tableName);
        return null; // no alias in CSV mode
      }

      // Already tracked
      if (tableAliases[tableName]) return tableAliases[tableName];

      // First table
      if (!baseTable) {
        const alias = generateAlias(tableName, {});
        const newAliases = { [tableName]: alias };
        setTableAliases(newAliases);
        setBaseTable(tableName);
        setJoinList([]);
        setFrom(buildFromStr(tableName, [], newAliases));
        return alias;
      }

      // New table → find join path via BFS
      const existingTables = new Set(Object.keys(tableAliases));
      const path = findJoinPath(relGraph, existingTables, tableName);

      let currentAliases = { ...tableAliases };
      let currentJoins = [...joinList];

      if (path && path.length > 0) {
        for (const step of path) {
          if (!currentAliases[step.nextTable]) {
            currentAliases[step.nextTable] = generateAlias(step.nextTable, currentAliases);
            currentJoins.push(stepToJoin(step));
          }
        }
      } else {
        // No FK path found → add as cross-join
        currentAliases[tableName] = generateAlias(tableName, currentAliases);
      }

      setTableAliases(currentAliases);
      setJoinList(currentJoins);
      setFrom(buildFromStr(baseTable, currentJoins, currentAliases));
      return currentAliases[tableName];
    },
    [isDb, from, baseTable, tableAliases, joinList, relGraph]
  );

  // ── Resolve drop data → aliased field string ─────────────────────────────

  const resolveDropField = useCallback(
    (e) => {
      const colName = e.dataTransfer.getData("text/plain");
      const tableName = e.dataTransfer.getData("application/x-table-name");
      const colType = e.dataTransfer.getData("application/x-col-type") || "";
      if (!colName) return null;
      let field;
      if (tableName && isDb) {
        const alias = addTableToQuery(tableName);
        field = alias ? `${q(alias)}.${q(colName)}` : q(colName);
      } else {
        if (tableName && !from) setFrom(tableName);
        field = colName;
      }
      return { field, colType };
    },
    [addTableToQuery, isDb, from]
  );

  // ── Drop handlers ─────────────────────────────────────────────────────────

  const dropToSelect = (e) => {
    e.preventDefault();
    const result = resolveDropField(e);
    if (!result) return;
    const { field, colType } = result;
    setSelectItems((prev) =>
      prev.some((i) => i.field === field)
        ? prev
        : [...prev, { id: uid(), field, agg: "NONE", colType }]
    );
  };

  const dropToWhere = (e) => {
    e.preventDefault();
    const result = resolveDropField(e);
    if (!result) return;
    setWhereFilters((prev) => [
      ...prev,
      { id: uid(), field: result.field, op: "=", value: "", conn: "AND", colType: result.colType },
    ]);
  };

  const dropToGroupBy = (e) => {
    e.preventDefault();
    const result = resolveDropField(e);
    if (!result) return;
    setGroupByFields((prev) => (prev.includes(result.field) ? prev : [...prev, result.field]));
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const preview = buildSql({
    selectItems,
    from,
    whereFilters,
    groupByFields,
    havingFilters,
    orderByItems,
  });

  const fromLineCount = (from.match(/\n/g) || []).length + 1;

  return (
    <div style={s.wrapper}>
      <div style={s.header}>
        <span style={s.label}>SQL Query Builder</span>
        {schema && (
          <span style={s.hint}>drag fields from the ERD into clauses below</span>
        )}
      </div>

      <div style={s.grid}>
        {/* ── SELECT ─────────────────────────────────────────────── */}
        <ClauseRow label="SELECT" required hint="What data you want to see">
          <DropZone onDrop={dropToSelect} emptyHint="drag fields here from ERD">
            {selectItems.map((item) => (
              <SelectChip
                key={item.id}
                item={item}
                onAggChange={(agg) =>
                  setSelectItems((prev) =>
                    prev.map((i) => (i.id === item.id ? { ...i, agg } : i))
                  )
                }
                onRemove={() =>
                  setSelectItems((prev) => prev.filter((i) => i.id !== item.id))
                }
              />
            ))}
            <InlineInput
              placeholder="type field name…"
              onAdd={(val) => {
                const v = val.trim();
                if (!v) return;
                setSelectItems((prev) =>
                  prev.some((i) => i.field === v)
                    ? prev
                    : [...prev, { id: uid(), field: v, agg: "NONE" }]
                );
              }}
            />
          </DropZone>
        </ClauseRow>

        {/* ── FROM ───────────────────────────────────────────────── */}
        <ClauseRow label="FROM" required hint="Which table(s) to pull data from">
          {fromLineCount > 1 ? (
            <textarea
              style={{ ...s.input, ...s.fromTextarea, ...(isDb ? {} : s.inputLocked) }}
              value={from}
              onChange={isDb ? (e) => setFrom(e.target.value) : undefined}
              readOnly={!isDb}
              spellCheck={false}
              rows={Math.min(fromLineCount, 8)}
            />
          ) : (
            <input
              style={{ ...s.input, ...(isDb ? {} : s.inputLocked) }}
              value={from}
              onChange={isDb ? (e) => setFrom(e.target.value) : undefined}
              readOnly={!isDb}
              spellCheck={false}
            />
          )}
          {!isDb && <span style={s.lockBadge}>locked</span>}
        </ClauseRow>

        {/* ── WHERE ──────────────────────────────────────────────── */}
        <ClauseRow label="WHERE" hint="How you want to filter the data">
          <WhereZone
            filters={whereFilters}
            onDrop={dropToWhere}
            onChange={setWhereFilters}
            schema={schema}
          />
        </ClauseRow>

        {/* ── GROUP BY ───────────────────────────────────────────── */}
        <ClauseRow label="GROUP BY" hint="Combine rows that share the same values">
          <GroupByZone
            fields={groupByFields}
            onChange={setGroupByFields}
            onDrop={dropToGroupBy}
          />
        </ClauseRow>

        {/* ── HAVING ─────────────────────────────────────────────── */}
        <ClauseRow label="HAVING" hint="Filter groups after aggregating">
          <HavingZone
            filters={havingFilters}
            onChange={setHavingFilters}
          />
        </ClauseRow>

        {/* ── ORDER BY ───────────────────────────────────────────── */}
        <ClauseRow label="ORDER BY" hint="How you want to sort the results">
          <OrderByZone
            orderByItems={orderByItems}
            onChange={setOrderByItems}
            selectItems={selectItems}
          />
        </ClauseRow>
      </div>

      {showPreview && preview && (
        <div style={s.preview}>
          <span style={s.previewLabel}>SQL Preview</span>
          <pre style={s.previewCode}>{preview}</pre>
        </div>
      )}

      {showButtons && (
        <div style={s.buttons}>
          <button
            style={s.btnPreflight}
            onClick={onPreflight}
            disabled={disabled || !from}
          >
            Preflight
          </button>
          <button style={s.btnRun} onClick={onRun} disabled={disabled || !from}>
            Run
          </button>
        </div>
      )}
    </div>
  );
}

// ── Inline typing input (used in SELECT, WHERE, GROUP BY, ORDER BY) ─────────

function InlineInput({ placeholder, onAdd }) {
  const [value, setValue] = useState("");
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && value.trim()) {
      onAdd(value.trim());
      setValue("");
    }
  };
  return (
    <input
      style={s.inlineInput}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      spellCheck={false}
    />
  );
}

// ── SELECT chip ───────────────────────────────────────────────────────────────

function SelectChip({ item, onAggChange, onRemove }) {
  const strType = isStringType(item.colType);
  const aggOptions = strType ? AGGREGATES_STRING : AGGREGATES_NUMERIC;
  return (
    <div style={s.selectChip}>
      <span style={s.chipField}>{item.field}</span>
      <select
        value={item.agg}
        onChange={(e) => onAggChange(e.target.value)}
        style={s.aggSelect}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {aggOptions.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <button style={s.chipX} onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

// ── HAVING zone ──────────────────────────────────────────────────────────────

const HAVING_OPS = ["=", "!=", ">", "<", ">=", "<="];

function HavingZone({ filters, onChange }) {
  const update = (id, patch) =>
    onChange((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h)));

  if (!filters.length) {
    return (
      <div style={s.havingZone}>
        <span style={s.emptyHint}>add aggregate functions in SELECT to filter here</span>
      </div>
    );
  }

  return (
    <div style={s.havingZone}>
      {filters.map((h) => (
        <div key={h.id} style={s.havingRow}>
          <label style={s.havingCheckLabel}>
            <input
              type="checkbox"
              checked={h.enabled}
              onChange={(e) => update(h.id, { enabled: e.target.checked })}
              style={s.havingCheck}
            />
            <span style={{
              ...s.havingExpr,
              opacity: h.enabled ? 1 : 0.5,
            }}>{h.expr}</span>
          </label>
          {h.enabled && (
            <>
              <select
                value={h.op}
                onChange={(e) => update(h.id, { op: e.target.value })}
                style={s.opSel}
              >
                {HAVING_OPS.map((op) => (
                  <option key={op}>{op}</option>
                ))}
              </select>
              <input
                style={s.filterVal}
                value={h.value}
                onChange={(e) => update(h.id, { value: e.target.value })}
                placeholder="value"
                spellCheck={false}
              />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ── ORDER BY zone (dropdown from SELECT items) ───────────────────────────────

function OrderByZone({ orderByItems, onChange, selectItems }) {
  const addField = (field) => {
    if (!field) return;
    onChange((prev) =>
      prev.some((i) => i.field === field)
        ? prev
        : [...prev, { id: uid(), field, dir: "ASC" }]
    );
  };

  const toggleDir = (id) =>
    onChange((prev) =>
      prev.map((i) =>
        i.id === id ? { ...i, dir: i.dir === "ASC" ? "DESC" : "ASC" } : i
      )
    );

  const remove = (id) => onChange((prev) => prev.filter((i) => i.id !== id));

  // Build dropdown options from SELECT items (using their display expression)
  const availableFields = selectItems.map((item) => {
    const sqlAgg = aggToSql(item.agg);
    if (sqlAgg === "NONE") return item.field;
    if (sqlAgg === "COUNT DISTINCT") return `COUNT(DISTINCT ${item.field})`;
    return `${sqlAgg}(${item.field})`;
  });

  const usedFields = new Set(orderByItems.map((i) => i.field));

  return (
    <div style={s.orderByZone}>
      {orderByItems.map((item) => (
        <div key={item.id} style={s.orderChip}>
          <span style={s.chipField}>{item.field}</span>
          <button style={s.dirBtn} onClick={() => toggleDir(item.id)}>
            {item.dir}
          </button>
          <button
            style={{ ...s.chipX, borderLeft: "1px solid #7a4706" }}
            onClick={() => remove(item.id)}
          >
            ×
          </button>
        </div>
      ))}
      {availableFields.length > 0 ? (
        <select
          value=""
          onChange={(e) => addField(e.target.value)}
          style={s.orderBySelect}
        >
          <option value="" disabled>
            + add field…
          </option>
          {availableFields
            .filter((f) => !usedFields.has(f))
            .map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
        </select>
      ) : (
        <span style={s.emptyHint}>add fields to SELECT first</span>
      )}
    </div>
  );
}

// ── Generic drop zone (SELECT) ───────────────────────────────────────────────

function DropZone({ onDrop, emptyHint, children }) {
  const [over, setOver] = useState(false);
  const kids = Array.isArray(children) ? children : [children];
  const hasContent = kids.some(
    (c) => c && c.type !== InlineInput // don't count InlineInput as content
  );
  return (
    <div
      style={{ ...s.dropZone, ...(over ? s.dropZoneOver : {}) }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        onDrop(e);
      }}
    >
      {!hasContent && <span style={s.emptyHint}>{emptyHint}</span>}
      {children}
    </div>
  );
}

// ── WHERE zone ────────────────────────────────────────────────────────────────

function WhereZone({ filters, onDrop, onChange, schema }) {
  const [over, setOver] = useState(false);

  // Build a lookup of column types from schema
  const colTypeMap = useMemo(() => {
    const map = {};
    if (!schema?.tables) return map;
    for (const t of schema.tables) {
      for (const c of t.columns || []) {
        map[c.name] = c.type || "";
        map[`${t.name}.${c.name}`] = c.type || "";
      }
    }
    return map;
  }, [schema]);

  const getFilterColType = (f) => {
    if (f.colType) return f.colType;
    // Try to resolve from schema by field name (strip quotes/alias)
    const bare = f.field.replace(/"/g, "");
    if (colTypeMap[bare]) return colTypeMap[bare];
    const parts = bare.split(".");
    if (parts.length === 2 && colTypeMap[`${parts[0]}.${parts[1]}`]) {
      return colTypeMap[`${parts[0]}.${parts[1]}`];
    }
    return "";
  };

  const getOpsForFilter = (f) => {
    const colType = getFilterColType(f);
    return isStringType(colType) ? WHERE_OPS_STRING : WHERE_OPS_NUMERIC;
  };

  const update = (id, patch) =>
    onChange((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const remove = (id) => onChange((prev) => prev.filter((f) => f.id !== id));

  const addManual = (val) => {
    const v = val.trim();
    if (!v) return;
    onChange((prev) => [
      ...prev,
      { id: uid(), field: v, op: "=", value: "", conn: "AND" },
    ]);
  };

  return (
    <div
      style={{ ...s.whereZone, ...(over ? s.dropZoneOver : {}) }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        onDrop(e);
      }}
    >
      {!filters.length && (
        <span style={s.emptyHint}>drag fields to build filters</span>
      )}
      {filters.map((f, i) => (
        <div key={f.id} style={s.filterRow}>
          {i > 0 && (
            <select
              value={f.conn}
              onChange={(e) => update(f.id, { conn: e.target.value })}
              style={s.connSel}
            >
              <option>AND</option>
              <option>OR</option>
            </select>
          )}
          <span style={s.filterField}>{f.field}</span>
          <select
            value={f.op}
            onChange={(e) => update(f.id, { op: e.target.value })}
            style={s.opSel}
          >
            {getOpsForFilter(f).map((op) => (
              <option key={op}>{op}</option>
            ))}
          </select>
          {!NO_VALUE_OPS.includes(f.op) && (
            <input
              style={s.filterVal}
              value={f.value}
              onChange={(e) => update(f.id, { value: e.target.value })}
              placeholder="value"
              spellCheck={false}
            />
          )}
          <button style={s.filterX} onClick={() => remove(f.id)}>
            ×
          </button>
        </div>
      ))}
      <InlineInput placeholder="type field to filter…" onAdd={addManual} />
    </div>
  );
}

// ── GROUP BY zone (drag to reorder + drop from ERD + manual typing) ──────────

function GroupByZone({ fields, onChange, onDrop }) {
  const [over, setOver] = useState(false);
  const dragIdx = useRef(null);

  return (
    <div
      style={{ ...s.groupByZone, ...(over ? s.dropZoneOver : {}) }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        // Check if it's an internal reorder or external drop
        const tableName = e.dataTransfer.getData("application/x-table-name");
        if (tableName) {
          // External drop from ERD
          onDrop(e);
        } else if (dragIdx.current !== null) {
          // Internal reorder
          const targetIdx = [...e.currentTarget.children].findIndex(
            (child) => child === e.target || child.contains(e.target)
          );
          if (targetIdx >= 0 && targetIdx !== dragIdx.current) {
            const next = [...fields];
            const [moved] = next.splice(dragIdx.current, 1);
            next.splice(targetIdx, 0, moved);
            onChange(next);
          }
          dragIdx.current = null;
        }
      }}
    >
      {!fields.length && (
        <span style={s.emptyHint}>
          auto-populated from non-aggregate SELECT fields
        </span>
      )}
      {fields.map((field, idx) => (
        <div
          key={field}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", field);
            dragIdx.current = idx;
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.stopPropagation();
            const src = dragIdx.current;
            if (src === null || src === idx) return;
            const next = [...fields];
            const [moved] = next.splice(src, 1);
            next.splice(idx, 0, moved);
            onChange(next);
            dragIdx.current = null;
          }}
          style={s.groupByChip}
        >
          <span style={s.grip}>⠿</span>
          {field}
          <button
            style={s.chipX}
            onClick={() => onChange(fields.filter((f) => f !== field))}
          >
            ×
          </button>
        </div>
      ))}
      <InlineInput
        placeholder="type field…"
        onAdd={(val) => {
          const v = val.trim();
          if (!v) return;
          onChange((prev) => (prev.includes(v) ? prev : [...prev, v]));
        }}
      />
    </div>
  );
}

// ── Clause row wrapper ────────────────────────────────────────────────────────

function ClauseRow({ label, required, hint, children }) {
  return (
    <div style={s.row}>
      <span
        style={{
          ...s.clauseLabel,
          color: required ? "#58a6ff" : "#6e7681",
        }}
      >
        {label}
      </span>
      <div style={s.clauseContent}>
        {hint && <div style={s.clauseHint}>{hint}</div>}
        <div style={s.clauseContentInner}>{children}</div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const MONO = '"JetBrains Mono", "SF Mono", "Fira Code", monospace';

const s = {
  wrapper: { marginBottom: 0 },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    marginBottom: 10,
  },
  label: { fontWeight: 600, fontSize: 14, color: "#e8ecf4" },
  hint: { fontSize: 12, color: "#7a82a0", fontStyle: "italic" },

  // Clause grid
  grid: {
    display: "flex",
    flexDirection: "column",
    background: "#1a1d2e",
    border: "1px solid #363c56",
    borderRadius: 10,
    overflow: "hidden",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    borderBottom: "1px solid #2a2f45",
    minHeight: 46,
  },
  clauseLabel: {
    width: 90,
    minWidth: 90,
    padding: "13px 0 13px 14px",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.03em",
    alignSelf: "flex-start",
  },
  clauseContent: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 46,
  },
  clauseContentInner: {
    flex: 1,
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
    padding: "7px 14px 7px 6px",
    width: "100%",
  },
  clauseHint: {
    fontSize: 16,
    color: "#8892b0",
    fontStyle: "italic",
    padding: "8px 14px 0 6px",
  },
  input: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 13,
    padding: "7px 12px",
    border: "1px solid #363c56",
    borderRadius: 8,
    background: "#212538",
    outline: "none",
    color: "#e8ecf4",
  },
  fromTextarea: {
    resize: "vertical",
    lineHeight: 1.5,
    fontFamily: MONO,
    fontSize: 13,
    whiteSpace: "pre",
    overflowX: "auto",
  },
  inputLocked: {
    background: "#1a1d2e",
    color: "#7a82a0",
    cursor: "not-allowed",
    borderColor: "#2a2f45",
  },
  lockBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: "#7a82a0",
    textTransform: "uppercase",
    flexShrink: 0,
  },

  // Generic drop zone
  dropZone: {
    flex: 1,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 5,
    height: 64,
    overflowY: "auto",
    border: "1.5px dashed #363c56",
    borderRadius: 8,
    padding: "5px 10px",
    background: "#212538",
    transition: "border-color .15s, background .15s",
  },
  dropZoneOver: { borderColor: "#a78bfa", background: "#2d2554" },
  emptyHint: {
    fontSize: 12,
    color: "#5c6180",
    fontStyle: "italic",
    userSelect: "none",
  },

  // Inline input
  inlineInput: {
    border: "none",
    outline: "none",
    background: "transparent",
    color: "#e8ecf4",
    fontFamily: MONO,
    fontSize: 12,
    padding: "4px 4px",
    minWidth: 110,
    flex: "1 1 90px",
  },

  // SELECT chip
  selectChip: {
    display: "inline-flex",
    alignItems: "stretch",
    background: "#1e2a4a",
    border: "1px solid #4a6fa5",
    borderRadius: 8,
    overflow: "hidden",
    fontSize: 12,
  },
  chipField: {
    padding: "5px 9px",
    fontWeight: 600,
    color: "#93bbf5",
    fontFamily: MONO,
    alignSelf: "center",
  },
  aggSelect: {
    border: "none",
    borderLeft: "1px solid #4a6fa5",
    background: "#1a2640",
    fontSize: 11,
    fontWeight: 600,
    color: "#7cacf8",
    cursor: "pointer",
    outline: "none",
    padding: "3px 5px",
  },
  chipX: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    border: "none",
    borderLeft: "1px solid #4a6fa5",
    background: "#1e1e38",
    color: "#f28b82",
    cursor: "pointer",
    fontSize: 16,
    fontWeight: 600,
    padding: 0,
    flexShrink: 0,
  },

  // WHERE zone
  whereZone: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 5,
    height: 64,
    overflowY: "auto",
    border: "1.5px dashed #363c56",
    borderRadius: 8,
    padding: "6px 10px",
    background: "#212538",
    transition: "border-color .15s, background .15s",
  },
  filterRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    flexWrap: "wrap",
  },
  filterField: {
    background: "#1e2a4a",
    border: "1px solid #4a6fa5",
    borderRadius: 6,
    padding: "4px 9px",
    fontSize: 12,
    fontWeight: 600,
    color: "#93bbf5",
    fontFamily: MONO,
  },
  connSel: {
    fontSize: 11,
    fontWeight: 600,
    border: "1px solid #363c56",
    borderRadius: 6,
    background: "#2a2f45",
    color: "#a0a8c0",
    padding: "3px 5px",
    cursor: "pointer",
  },
  opSel: {
    fontSize: 12,
    border: "1px solid #363c56",
    borderRadius: 6,
    background: "#212538",
    color: "#e8ecf4",
    padding: "3px 5px",
    cursor: "pointer",
  },
  filterVal: {
    flex: 1,
    minWidth: 80,
    maxWidth: 180,
    fontSize: 12,
    border: "1px solid #363c56",
    borderRadius: 6,
    background: "#212538",
    color: "#e8ecf4",
    padding: "4px 7px",
    outline: "none",
    fontFamily: MONO,
  },
  filterX: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    border: "1px solid #8b5252",
    borderRadius: 6,
    background: "#2d1b1e",
    color: "#f28b82",
    cursor: "pointer",
    fontSize: 14,
    padding: 0,
    flexShrink: 0,
  },

  // GROUP BY zone
  groupByZone: {
    flex: 1,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 5,
    height: 64,
    overflowY: "auto",
    border: "1.5px dashed #363c56",
    borderRadius: 8,
    padding: "5px 10px",
    background: "#212538",
    transition: "border-color .15s, background .15s",
  },
  groupByChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    background: "#1a3028",
    border: "1px solid #3a7d56",
    borderRadius: 8,
    padding: "4px 8px",
    fontSize: 12,
    fontWeight: 600,
    color: "#6fcf97",
    cursor: "grab",
    userSelect: "none",
  },
  grip: { fontSize: 11, color: "#3a7d56", cursor: "grab" },

  // HAVING zone
  havingZone: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 5,
    height: 64,
    overflowY: "auto",
    border: "1.5px dashed #363c56",
    borderRadius: 8,
    padding: "6px 10px",
    background: "#212538",
    transition: "border-color .15s, background .15s",
  },
  havingRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  havingCheckLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    cursor: "pointer",
  },
  havingCheck: {
    accentColor: "#a78bfa",
    cursor: "pointer",
    margin: 0,
  },
  havingExpr: {
    background: "#2d2554",
    border: "1px solid #7c5cbf",
    borderRadius: 6,
    padding: "4px 9px",
    fontSize: 12,
    fontWeight: 600,
    color: "#b99cff",
    fontFamily: MONO,
    transition: "opacity .15s",
  },

  // ORDER BY zone
  orderByZone: {
    flex: 1,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 5,
    height: 64,
    overflowY: "auto",
    border: "1.5px dashed #363c56",
    borderRadius: 8,
    padding: "5px 10px",
    background: "#212538",
    transition: "border-color .15s, background .15s",
  },
  orderBySelect: {
    fontSize: 12,
    border: "1px solid #363c56",
    borderRadius: 6,
    background: "#212538",
    color: "#a0a8c0",
    padding: "4px 6px",
    cursor: "pointer",
    outline: "none",
    fontFamily: MONO,
  },

  // ORDER BY chip
  orderChip: {
    display: "inline-flex",
    alignItems: "stretch",
    background: "#302818",
    border: "1px solid #8a6a24",
    borderRadius: 8,
    overflow: "hidden",
    fontSize: 12,
  },
  dirBtn: {
    border: "none",
    borderLeft: "1px solid #8a6a24",
    background: "#3c300a",
    fontSize: 11,
    fontWeight: 600,
    color: "#f2c94c",
    cursor: "pointer",
    padding: "3px 8px",
  },

  // SQL preview
  preview: {
    marginTop: 12,
    background: "#1a1d2e",
    border: "1px solid #2a2f45",
    borderRadius: 8,
    padding: "12px 16px",
  },
  previewLabel: {
    display: "block",
    color: "#7a82a0",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    marginBottom: 6,
    textTransform: "uppercase",
  },
  previewCode: {
    margin: 0,
    color: "#e8ecf4",
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
  },

  // Buttons
  buttons: { display: "flex", gap: 10, marginTop: 12 },
  btnPreflight: {
    padding: "9px 22px",
    background: "linear-gradient(135deg, #c77b1a, #e09422)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 14,
  },
  btnRun: {
    padding: "9px 22px",
    background: "linear-gradient(135deg, #22804a, #34a85a)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 14,
  },
};
