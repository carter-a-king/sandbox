import { useState, useEffect, useRef, useCallback, useMemo } from "react";

export default function SchemaPanel({ schema, datasetType }) {
  if (!schema) return null;
  const isDb = datasetType === "db";

  return (
    <div style={styles.wrapper}>
      {isDb ? <InteractiveErd schema={schema} /> : <CsvView schema={schema} />}
    </div>
  );
}

// ── CSV / XLSX: single draggable card ────────────────────────────────────────

function CsvView({ schema }) {
  const table = schema.tables?.[0];
  if (!table) return <p style={{ color: "#94a3b8" }}>No schema available.</p>;
  return (
    <div style={styles.csvCenter}>
      <TableCard table={table} />
    </div>
  );
}

// ── Sugiyama-style layout with crossing minimization ─────────────────────────

// Layout constants - wider spacing for readability
const CARD_WIDTH = 200;
const CARD_HEIGHT_BASE = 50;
const ROW_HEIGHT = 26;
const MAX_CARD_HEIGHT = 280;
const H_GAP = 100;  // Horizontal gap between columns (increased)
const V_GAP = 60;   // Vertical gap between rows (increased)

// Calculate card height for a table
const getCardHeight = (t) => Math.min(CARD_HEIGHT_BASE + Math.min(t.columns.length, 8) * ROW_HEIGHT + 20, MAX_CARD_HEIGHT);

// Check if a line segment intersects a rectangle (with padding)
function lineIntersectsBox(x1, y1, x2, y2, box, padding = 10) {
  const left = box.x - padding;
  const right = box.x + CARD_WIDTH + padding;
  const top = box.y - padding;
  const bottom = box.y + box.height + padding;
  
  // Check if both endpoints are inside - that's ok (connects to this table)
  const p1Inside = x1 >= left && x1 <= right && y1 >= top && y1 <= bottom;
  const p2Inside = x2 >= left && x2 <= right && y2 >= top && y2 <= bottom;
  if (p1Inside && p2Inside) return false; // Line stays within the box
  
  // If one endpoint is inside, it's connecting to this table - ok
  if (p1Inside || p2Inside) return false;
  
  // Line-rectangle intersection using Liang-Barsky algorithm
  const dx = x2 - x1;
  const dy = y2 - y1;
  
  let tMin = 0, tMax = 1;
  
  const edges = [
    { p: -dx, q: x1 - left },   // Left
    { p: dx, q: right - x1 },   // Right
    { p: -dy, q: y1 - top },    // Top
    { p: dy, q: bottom - y1 },  // Bottom
  ];
  
  for (const { p, q } of edges) {
    if (Math.abs(p) < 0.0001) {
      if (q < 0) return false; // Parallel and outside
    } else {
      const t = q / p;
      if (p < 0) {
        tMin = Math.max(tMin, t);
      } else {
        tMax = Math.min(tMax, t);
      }
    }
  }
  
  return tMin < tMax; // Intersects if tMin < tMax
}

// Check if a path passes through any table (excluding its endpoints' tables)
function pathPassesThroughTables(path, tableBoxes, fromTable, toTable) {
  for (const [tableName, box] of Object.entries(tableBoxes)) {
    // Skip the tables this line connects
    if (tableName === fromTable || tableName === toTable) continue;
    
    for (let i = 0; i < path.length - 1; i++) {
      if (lineIntersectsBox(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1], box)) {
        return true;
      }
    }
  }
  return false;
}

// Check if two line segments intersect
function segmentsIntersect(s1, s2, CHANNEL_SPACING = 14) {
  const { x1: a1, y1: b1, x2: a2, y2: b2 } = s1;
  const { x1: c1, y1: d1, x2: c2, y2: d2 } = s2;
  
  // Both horizontal
  if (Math.abs(b1 - b2) < 1 && Math.abs(d1 - d2) < 1) {
    if (Math.abs(b1 - d1) < CHANNEL_SPACING) {
      const minA = Math.min(a1, a2), maxA = Math.max(a1, a2);
      const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
      return !(maxA < minC || maxC < minA);
    }
    return false;
  }
  
  // Both vertical
  if (Math.abs(a1 - a2) < 1 && Math.abs(c1 - c2) < 1) {
    if (Math.abs(a1 - c1) < CHANNEL_SPACING) {
      const minB = Math.min(b1, b2), maxB = Math.max(b1, b2);
      const minD = Math.min(d1, d2), maxD = Math.max(d1, d2);
      return !(maxB < minD || maxD < minB);
    }
    return false;
  }
  
  // One horizontal, one vertical - check actual crossing
  let hz, vt;
  if (Math.abs(b1 - b2) < 1) {
    hz = s1; vt = s2;
  } else if (Math.abs(d1 - d2) < 1) {
    hz = s2; vt = s1;
  } else {
    return false;
  }
  
  const hY = hz.y1;
  const hMinX = Math.min(hz.x1, hz.x2);
  const hMaxX = Math.max(hz.x1, hz.x2);
  const vX = vt.x1;
  const vMinY = Math.min(vt.y1, vt.y2);
  const vMaxY = Math.max(vt.y1, vt.y2);
  
  return vX > hMinX && vX < hMaxX && hY > vMinY && hY < vMaxY;
}

// Compute positions with optional random shuffling for retries
function computeInitialPositions(tables, relationships, inferred, shuffleSeed = 0) {
  const allRels = [...relationships, ...inferred];
  const positions = {};
  
  if (!tables.length) return positions;

  // Shuffle function using seed for reproducible randomness
  const seededRandom = (seed) => {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  };
  
  const shuffleArray = (arr, seed) => {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom(seed + i) * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };

  // Build adjacency lists
  const outgoing = {}; // table -> tables it points TO (FK relationships)
  const incoming = {}; // table -> tables that point TO it
  
  tables.forEach(t => {
    outgoing[t.name] = new Set();
    incoming[t.name] = new Set();
  });
  
  allRels.forEach(r => {
    if (outgoing[r.from_table]) outgoing[r.from_table].add(r.to_table);
    if (incoming[r.to_table]) incoming[r.to_table].add(r.from_table);
  });

  // Step 1: Assign layers using longest path from sources
  // Sources are tables with no incoming edges (PK/lookup tables)
  const layers = {};
  const tableByName = {};
  tables.forEach(t => { tableByName[t.name] = t; });

  // Find sources (tables with no incoming references - these are the "root" tables)
  const sources = tables.filter(t => incoming[t.name].size === 0);
  const sinks = tables.filter(t => outgoing[t.name].size === 0);

  // BFS to assign layers - sources at layer 0
  const queue = [];
  const visited = new Set();
  
  // Initialize sources at layer 0
  if (sources.length > 0) {
    sources.forEach(t => {
      layers[t.name] = 0;
      queue.push(t.name);
      visited.add(t.name);
    });
  } else {
    // No clear sources, start with first table
    layers[tables[0].name] = 0;
    queue.push(tables[0].name);
    visited.add(tables[0].name);
  }

  // BFS to assign layers based on incoming edges
  while (queue.length > 0) {
    const current = queue.shift();
    const currentLayer = layers[current];
    
    // All tables that reference this one go to the next layer
    incoming[current]?.forEach(ref => {
      if (!visited.has(ref)) {
        layers[ref] = currentLayer + 1;
        visited.add(ref);
        queue.push(ref);
      } else {
        // Already visited - ensure it's at least one layer after
        layers[ref] = Math.max(layers[ref], currentLayer + 1);
      }
    });
  }

  // Handle disconnected tables
  tables.forEach(t => {
    if (layers[t.name] === undefined) {
      layers[t.name] = 0;
    }
  });

  // Step 2: Group tables by layer
  const layerGroups = {};
  tables.forEach(t => {
    const layer = layers[t.name];
    if (!layerGroups[layer]) layerGroups[layer] = [];
    layerGroups[layer].push(t);
  });

  const sortedLayers = Object.keys(layerGroups).map(Number).sort((a, b) => a - b);
  const numLayers = sortedLayers.length;

  // Step 3: Barycenter method to minimize edge crossings
  // Run multiple passes to improve ordering
  for (let pass = 0; pass < 4; pass++) {
    // Forward pass (left to right)
    for (let i = 1; i < numLayers; i++) {
      const layer = sortedLayers[i];
      const prevLayer = sortedLayers[i - 1];
      const group = layerGroups[layer];
      const prevGroup = layerGroups[prevLayer];
      
      // Calculate barycenter for each node based on connected nodes in previous layer
      group.forEach(t => {
        const connectedInPrev = [];
        // Find connections to previous layer
        outgoing[t.name]?.forEach(ref => {
          const idx = prevGroup.findIndex(pt => pt.name === ref);
          if (idx >= 0) connectedInPrev.push(idx);
        });
        incoming[t.name]?.forEach(ref => {
          const idx = prevGroup.findIndex(pt => pt.name === ref);
          if (idx >= 0) connectedInPrev.push(idx);
        });
        
        if (connectedInPrev.length > 0) {
          t._barycenter = connectedInPrev.reduce((a, b) => a + b, 0) / connectedInPrev.length;
        } else {
          t._barycenter = group.indexOf(t);
        }
      });
      
      // Sort by barycenter
      group.sort((a, b) => a._barycenter - b._barycenter);
    }

    // Backward pass (right to left)
    for (let i = numLayers - 2; i >= 0; i--) {
      const layer = sortedLayers[i];
      const nextLayer = sortedLayers[i + 1];
      const group = layerGroups[layer];
      const nextGroup = layerGroups[nextLayer];
      
      group.forEach(t => {
        const connectedInNext = [];
        incoming[t.name]?.forEach(ref => {
          const idx = nextGroup.findIndex(nt => nt.name === ref);
          if (idx >= 0) connectedInNext.push(idx);
        });
        outgoing[t.name]?.forEach(ref => {
          const idx = nextGroup.findIndex(nt => nt.name === ref);
          if (idx >= 0) connectedInNext.push(idx);
        });
        
        if (connectedInNext.length > 0) {
          t._barycenter = connectedInNext.reduce((a, b) => a + b, 0) / connectedInNext.length;
        } else {
          t._barycenter = group.indexOf(t);
        }
      });
      
      group.sort((a, b) => a._barycenter - b._barycenter);
    }
  }

  // Apply shuffle to layer ordering if shuffleSeed > 0 (for retries)
  if (shuffleSeed > 0) {
    sortedLayers.forEach((layer, idx) => {
      const group = layerGroups[layer];
      // Shuffle within each layer based on seed
      const shuffled = shuffleArray(group, shuffleSeed + idx * 100);
      layerGroups[layer] = shuffled;
    });
  }

  // Step 4: Calculate positions - use a grid layout that fills space better
  // Determine optimal grid dimensions based on number of tables
  const numTables = tables.length;
  
  // Target aspect ratio of ~16:9 for typical screens
  // If we have more layers than rows, transpose to horizontal layout
  let useHorizontalLayers = true;
  
  // Calculate total height if using vertical stacking per layer
  let maxLayerHeight = 0;
  sortedLayers.forEach(layer => {
    const group = layerGroups[layer];
    let layerHeight = 0;
    group.forEach(t => {
      layerHeight += getCardHeight(t) + V_GAP;
    });
    maxLayerHeight = Math.max(maxLayerHeight, layerHeight);
  });

  // If layers are too tall, spread tables horizontally within each layer
  const MAX_SINGLE_COLUMN_HEIGHT = 800;
  
  if (maxLayerHeight > MAX_SINGLE_COLUMN_HEIGHT && numLayers <= 3) {
    // Rebalance: put tables in a more grid-like arrangement
    // Calculate total tables and optimal grid
    const cols = Math.ceil(Math.sqrt(numTables * 1.5)); // Wider than tall
    const rows = Math.ceil(numTables / cols);
    
    // Sort all tables by layer, then by position within layer
    const sortedTables = [];
    sortedLayers.forEach(layer => {
      layerGroups[layer].forEach(t => sortedTables.push(t));
    });
    
    // Position in grid, keeping related tables nearby
    let col = 0, row = 0;
    let maxRowHeight = 0;
    let currentY = 0;
    
    sortedTables.forEach((t, idx) => {
      const cardHeight = getCardHeight(t);
      
      positions[t.name] = {
        x: col * (CARD_WIDTH + H_GAP),
        y: currentY
      };
      
      maxRowHeight = Math.max(maxRowHeight, cardHeight);
      col++;
      
      if (col >= cols) {
        col = 0;
        currentY += maxRowHeight + V_GAP;
        maxRowHeight = 0;
      }
    });
  } else {
    // Standard layer-based layout (horizontal layers)
    let currentX = 0;
    
    sortedLayers.forEach(layer => {
      const group = layerGroups[layer];
      let currentY = 0;
      
      group.forEach(t => {
        const cardHeight = getCardHeight(t);
        positions[t.name] = { x: currentX, y: currentY };
        currentY += cardHeight + V_GAP;
      });
      
      currentX += CARD_WIDTH + H_GAP;
    });

    // Center each layer vertically
    const allYs = Object.values(positions).map(p => p.y);
    const maxY = Math.max(...allYs);
    
    sortedLayers.forEach(layer => {
      const group = layerGroups[layer];
      if (!group.length) return;
      
      let layerHeight = 0;
      group.forEach(t => {
        layerHeight += getCardHeight(t) + V_GAP;
      });
      layerHeight -= V_GAP;
      
      const offset = (maxY - layerHeight + getCardHeight(group[group.length - 1])) / 2;
      if (offset > 0) {
        group.forEach(t => {
          positions[t.name].y += offset;
        });
      }
    });
  }

  // Add padding to center the diagram (leave space on left for line routing)
  const DIAGRAM_PADDING = 150; // Space on each side for routing lines around tables
  Object.keys(positions).forEach(name => {
    positions[name].x += DIAGRAM_PADDING;
    positions[name].y += DIAGRAM_PADDING / 2;
  });

  return positions;
}

// Validate if a layout has any lines passing through tables or crossing each other
function validateLayout(positions, tables, relationships, inferred) {
  const allRels = [...relationships, ...inferred];
  if (!allRels.length || !tables.length) return { valid: true, issues: 0 };
  
  // Build table boxes from positions
  const tableBoxes = {};
  tables.forEach(t => {
    const pos = positions[t.name];
    if (!pos) return;
    const cardHeight = getCardHeight(t);
    tableBoxes[t.name] = {
      x: pos.x,
      y: pos.y,
      height: cardHeight,
      centerX: pos.x + CARD_WIDTH / 2,
      centerY: pos.y + cardHeight / 2,
      left: pos.x,
      right: pos.x + CARD_WIDTH,
      top: pos.y,
      bottom: pos.y + cardHeight,
    };
  });
  
  let issues = 0;
  const allSegments = [];
  const CHANNEL_SPACING = 14;

  for (const rel of allRels) {
    const fromBox = tableBoxes[rel.from_table];
    const toBox = tableBoxes[rel.to_table];
    if (!fromBox || !toBox) continue;

    const dx = toBox.centerX - fromBox.centerX;
    const dy = toBox.centerY - fromBox.centerY;

    let startX, startY, endX, endY;
    const isHorizontal = Math.abs(dx) > Math.abs(dy);

    if (isHorizontal) {
      if (dx > 0) {
        startX = fromBox.right; startY = fromBox.centerY;
        endX = toBox.left; endY = toBox.centerY;
      } else {
        startX = fromBox.left; startY = fromBox.centerY;
        endX = toBox.right; endY = toBox.centerY;
      }
    } else {
      if (dy > 0) {
        startX = fromBox.centerX; startY = fromBox.bottom;
        endX = toBox.centerX; endY = toBox.top;
      } else {
        startX = fromBox.centerX; startY = fromBox.top;
        endX = toBox.centerX; endY = toBox.bottom;
      }
    }

    // Generate path
    let path;
    if (isHorizontal) {
      if (Math.abs(startY - endY) < 5) {
        path = [[startX, startY], [endX, endY]];
      } else {
        const midX = (startX + endX) / 2;
        path = [[startX, startY], [midX, startY], [midX, endY], [endX, endY]];
      }
    } else {
      if (Math.abs(startX - endX) < 5) {
        path = [[startX, startY], [endX, endY]];
      } else {
        const midY = (startY + endY) / 2;
        path = [[startX, startY], [startX, midY], [endX, midY], [endX, endY]];
      }
    }

    // Check if path passes through any table
    if (pathPassesThroughTables(path, tableBoxes, rel.from_table, rel.to_table)) {
      issues++;
    }

    // Check for crossings with existing segments
    for (let i = 0; i < path.length - 1; i++) {
      const seg = { x1: path[i][0], y1: path[i][1], x2: path[i+1][0], y2: path[i+1][1] };
      for (const existing of allSegments) {
        if (segmentsIntersect(seg, existing, CHANNEL_SPACING)) {
          issues++;
          break;
        }
      }
      allSegments.push(seg);
    }
  }

  return { valid: issues === 0, issues };
}

// Find best layout by trying multiple shuffles
function findBestLayout(tables, relationships, inferred, maxAttempts = 50) {
  let bestPositions = computeInitialPositions(tables, relationships, inferred, 0);
  let bestResult = validateLayout(bestPositions, tables, relationships, inferred);
  
  if (bestResult.valid) return bestPositions;
  
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    const positions = computeInitialPositions(tables, relationships, inferred, attempt);
    const result = validateLayout(positions, tables, relationships, inferred);
    
    if (result.valid) {
      return positions;
    }
    
    if (result.issues < bestResult.issues) {
      bestPositions = positions;
      bestResult = result;
    }
  }
  
  // Return best attempt even if not perfect
  return bestPositions;
}

// ── Interactive ERD with relationship lines + drag-and-drop ──────────────────

function InteractiveErd({ schema }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const cardRefs = useRef({});
  const colRefs = useRef({}); // Track column positions for drag-to-connect
  const [lines, setLines] = useState([]);
  const [hoveredLine, setHoveredLine] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [updateTrigger, setUpdateTrigger] = useState(0);
  const [zoom, setZoom] = useState(1);
  
  // Drag-to-connect state
  const [connectDrag, setConnectDrag] = useState(null); // { fromTable, fromCol, x, y }
  const [userRelationships, setUserRelationships] = useState([]);

  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 2;
  const ZOOM_STEP = 0.15;

  const allRels = useMemo(() => [
    ...(schema.relationships || []).map((r) => ({ ...r, inferred: false })),
    ...(schema.inferred_relationships || []).map((r) => ({ ...r, inferred: true })),
    ...userRelationships.map((r) => ({ ...r, inferred: false, userCreated: true })),
  ], [schema, userRelationships]);

  // Initialize positions using best layout algorithm
  const [positions, setPositions] = useState(() => 
    findBestLayout(schema.tables, schema.relationships || [], schema.inferred_relationships || [])
  );

  // Recalculate when schema changes
  useEffect(() => {
    setPositions(findBestLayout(schema.tables, schema.relationships || [], schema.inferred_relationships || []));
    setUserRelationships([]); // Reset user relationships on schema change
  }, [schema]);

  // Calculate canvas size (needed for zoom fit)
  const canvasSize = useMemo(() => {
    let maxX = 600, maxY = 400;
    schema.tables.forEach(t => {
      const pos = positions[t.name] || { x: 0, y: 0 };
      const cardHeight = 50 + Math.min(t.columns.length, 8) * 26 + 20;
      maxX = Math.max(maxX, pos.x + 220);
      maxY = Math.max(maxY, pos.y + cardHeight + 30);
    });
    // Add padding for edge routing on both sides (diagram already has left padding, add right)
    return { width: maxX + 150, height: maxY + 80 };
  }, [positions, schema.tables]);

  // Zoom handlers
  const handleZoomIn = () => setZoom(z => Math.min(ZOOM_MAX, z + ZOOM_STEP));
  const handleZoomOut = () => setZoom(z => Math.max(ZOOM_MIN, z - ZOOM_STEP));
  const handleZoomReset = () => setZoom(1);
  const handleZoomFit = () => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth - 32;
    const containerHeight = containerRef.current.clientHeight - 32;
    const fitZoom = Math.min(
      containerWidth / canvasSize.width,
      containerHeight / canvasSize.height,
      0.9 // Cap at 90% to ensure some padding
    );
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fitZoom)));
  };

  // Auto-fit on initial render
  useEffect(() => {
    const timer = setTimeout(() => {
      if (containerRef.current && canvasSize.width > 0) {
        const containerWidth = containerRef.current.clientWidth - 32;
        const containerHeight = containerRef.current.clientHeight - 32;
        const fitZoom = Math.min(
          containerWidth / canvasSize.width,
          containerHeight / canvasSize.height,
          0.85
        );
        setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fitZoom)));
        
        // Center the scroll position after zoom is set
        setTimeout(() => {
          if (containerRef.current) {
            const scaledWidth = canvasSize.width * fitZoom;
            const scaledHeight = canvasSize.height * fitZoom;
            const scrollLeft = Math.max(0, (scaledWidth - containerWidth) / 2);
            const scrollTop = Math.max(0, (scaledHeight - containerHeight) / 2);
            containerRef.current.scrollLeft = scrollLeft;
            containerRef.current.scrollTop = scrollTop;
          }
        }, 50);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [schema.tables.length, canvasSize.width, canvasSize.height]); // Re-fit when table count or canvas size changes

  // Mouse wheel zoom — proportional to deltaY for smooth touchpad support
  const handleWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // Scale ~0.002 per pixel: a typical touchpad nudge (deltaY≈5) → 0.01 (1%)
      const rawDelta = -e.deltaY * 0.002;
      const clampedDelta = Math.max(-0.1, Math.min(0.1, rawDelta));
      setZoom(z => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z + clampedDelta)));
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // Measure and draw relationship lines with proper crossing avoidance
  useEffect(() => {
    const measure = () => {
      if (!canvasRef.current || !allRels.length) {
        setLines([]);
        return;
      }
      const cRect = canvasRef.current.getBoundingClientRect();
      
      // Collect all table bounding boxes
      const PADDING = 8;
      const tableBoxes = {};
      schema.tables.forEach(t => {
        const card = cardRefs.current[t.name];
        if (card) {
          const r = card.getBoundingClientRect();
          tableBoxes[t.name] = {
            left: (r.left - cRect.left) / zoom - PADDING,
            top: (r.top - cRect.top) / zoom - PADDING,
            right: (r.right - cRect.left) / zoom + PADDING,
            bottom: (r.bottom - cRect.top) / zoom + PADDING,
            centerX: (r.left + r.width / 2 - cRect.left) / zoom,
            centerY: (r.top + r.height / 2 - cRect.top) / zoom,
          };
        }
      });

      // Prepare edge data with connection points
      const edges = [];
      for (const rel of allRels) {
        const fromBox = tableBoxes[rel.from_table];
        const toBox = tableBoxes[rel.to_table];
        if (!fromBox || !toBox) continue;

        const dx = toBox.centerX - fromBox.centerX;
        const dy = toBox.centerY - fromBox.centerY;

        edges.push({
          rel,
          fromBox, toBox,
          dx, dy,
          length: Math.abs(dx) + Math.abs(dy),
        });
      }

      // Sort edges by length (route shorter edges first to give them priority)
      edges.sort((a, b) => a.length - b.length);

      // Track all line segments to avoid crossings
      const allSegments = []; // [{x1, y1, x2, y2}]
      const CHANNEL_SPACING = 14;

      // Check if two segments intersect
      const segmentsIntersect = (s1, s2) => {
        const { x1: a1, y1: b1, x2: a2, y2: b2 } = s1;
        const { x1: c1, y1: d1, x2: c2, y2: d2 } = s2;
        
        // Both horizontal
        if (Math.abs(b1 - b2) < 1 && Math.abs(d1 - d2) < 1) {
          if (Math.abs(b1 - d1) < CHANNEL_SPACING) {
            const minA = Math.min(a1, a2), maxA = Math.max(a1, a2);
            const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
            return !(maxA < minC || maxC < minA);
          }
          return false;
        }
        
        // Both vertical
        if (Math.abs(a1 - a2) < 1 && Math.abs(c1 - c2) < 1) {
          if (Math.abs(a1 - c1) < CHANNEL_SPACING) {
            const minB = Math.min(b1, b2), maxB = Math.max(b1, b2);
            const minD = Math.min(d1, d2), maxD = Math.max(d1, d2);
            return !(maxB < minD || maxD < minB);
          }
          return false;
        }
        
        // One horizontal, one vertical - check actual crossing
        let hz, vt;
        if (Math.abs(b1 - b2) < 1) {
          hz = s1; vt = s2;
        } else if (Math.abs(d1 - d2) < 1) {
          hz = s2; vt = s1;
        } else {
          return false; // Neither is axis-aligned
        }
        
        const hY = hz.y1;
        const hMinX = Math.min(hz.x1, hz.x2);
        const hMaxX = Math.max(hz.x1, hz.x2);
        const vX = vt.x1;
        const vMinY = Math.min(vt.y1, vt.y2);
        const vMaxY = Math.max(vt.y1, vt.y2);
        
        return vX > hMinX && vX < hMaxX && hY > vMinY && hY < vMaxY;
      };

      // Check if a path would cross any existing segments
      const pathCrossesExisting = (path) => {
        for (let i = 0; i < path.length - 1; i++) {
          const seg = { x1: path[i][0], y1: path[i][1], x2: path[i+1][0], y2: path[i+1][1] };
          for (const existing of allSegments) {
            if (segmentsIntersect(seg, existing)) return true;
          }
        }
        return false;
      };

      // Check if a path passes through any table (except the connected ones)
      const pathPassesThroughTable = (path, fromTable, toTable) => {
        for (const [tableName, box] of Object.entries(tableBoxes)) {
          if (tableName === fromTable || tableName === toTable) continue;
          for (let i = 0; i < path.length - 1; i++) {
            const x1 = path[i][0], y1 = path[i][1];
            const x2 = path[i+1][0], y2 = path[i+1][1];
            
            // Check line-box intersection
            const padding = 5;
            const left = box.left - padding;
            const right = box.right + padding;
            const top = box.top - padding;
            const bottom = box.bottom + padding;
            
            // Both points outside box on same side - no intersection
            if (x1 < left && x2 < left) continue;
            if (x1 > right && x2 > right) continue;
            if (y1 < top && y2 < top) continue;
            if (y1 > bottom && y2 > bottom) continue;
            
            // Check if segment crosses box using parametric line equations
            const dx = x2 - x1;
            const dy = y2 - y1;
            let tMin = 0, tMax = 1;
            
            if (Math.abs(dx) > 0.001) {
              const t1 = (left - x1) / dx;
              const t2 = (right - x1) / dx;
              tMin = Math.max(tMin, Math.min(t1, t2));
              tMax = Math.min(tMax, Math.max(t1, t2));
            }
            if (Math.abs(dy) > 0.001) {
              const t1 = (top - y1) / dy;
              const t2 = (bottom - y1) / dy;
              tMin = Math.max(tMin, Math.min(t1, t2));
              tMax = Math.min(tMax, Math.max(t1, t2));
            }
            
            if (tMin < tMax && tMax > 0 && tMin < 1) {
              return true;
            }
          }
        }
        return false;
      };

      // Combined check: path validity (no crossings, no table passes)
      const isPathValid = (path, fromTable, toTable) => {
        return !pathCrossesExisting(path) && !pathPassesThroughTable(path, fromTable, toTable);
      };

      // Add path segments to tracking
      const addPathSegments = (path) => {
        for (let i = 0; i < path.length - 1; i++) {
          allSegments.push({ x1: path[i][0], y1: path[i][1], x2: path[i+1][0], y2: path[i+1][1] });
        }
      };

      const newLines = [];

      for (const edge of edges) {
        const { rel, fromBox, toBox, dx, dy } = edge;
        
        // Try multiple routing options and pick one that doesn't cross or pass through tables
        let bestPath = null;
        let bestScore = Infinity;

        // Calculate bounding area for route avoidance
        const minTableY = Math.min(...Object.values(tableBoxes).map(b => b.top)) - 50;
        const maxTableY = Math.max(...Object.values(tableBoxes).map(b => b.bottom)) + 50;
        const minTableX = Math.min(...Object.values(tableBoxes).map(b => b.left)) - 50;
        const maxTableX = Math.max(...Object.values(tableBoxes).map(b => b.right)) + 50;

        // Helper to get connection point for a side
        const getConnectionPoint = (box, side) => {
          switch (side) {
            case 'right': return { x: box.right, y: box.centerY };
            case 'left': return { x: box.left, y: box.centerY };
            case 'top': return { x: box.centerX, y: box.top };
            case 'bottom': return { x: box.centerX, y: box.bottom };
          }
        };

        // Generate paths for a given start/end connection
        const generatePaths = (startX, startY, endX, endY, startSide, endSide) => {
          const paths = [];
          const isStartHorizontal = startSide === 'right' || startSide === 'left';
          const isEndHorizontal = endSide === 'right' || endSide === 'left';
          
          // Direct line if close enough
          if (Math.abs(startX - endX) < 5 && Math.abs(startY - endY) < 5) {
            paths.push([[startX, startY], [endX, endY]]);
            return paths;
          }

          // Same horizontal sides (both left/right) - use Z-path with horizontal first
          if (isStartHorizontal && isEndHorizontal) {
            for (let offset = 0; offset <= 100; offset += CHANNEL_SPACING) {
              for (const dir of [1, -1]) {
                const midX = (startX + endX) / 2 + offset * dir;
                paths.push([[startX, startY], [midX, startY], [midX, endY], [endX, endY]]);
              }
            }
          }
          // Same vertical sides (both top/bottom) - use Z-path with vertical first
          else if (!isStartHorizontal && !isEndHorizontal) {
            for (let offset = 0; offset <= 100; offset += CHANNEL_SPACING) {
              for (const dir of [1, -1]) {
                const midY = (startY + endY) / 2 + offset * dir;
                paths.push([[startX, startY], [startX, midY], [endX, midY], [endX, endY]]);
              }
            }
          }
          // Mixed sides - use L-path
          else if (isStartHorizontal && !isEndHorizontal) {
            // Go horizontal first, then vertical
            paths.push([[startX, startY], [endX, startY], [endX, endY]]);
            // Or go to intermediate point
            for (let offset = 0; offset <= 80; offset += CHANNEL_SPACING) {
              for (const dir of [1, -1]) {
                paths.push([[startX, startY], [endX + offset * dir, startY], [endX + offset * dir, endY], [endX, endY]]);
              }
            }
          }
          else if (!isStartHorizontal && isEndHorizontal) {
            // Go vertical first, then horizontal
            paths.push([[startX, startY], [startX, endY], [endX, endY]]);
            // Or go to intermediate point
            for (let offset = 0; offset <= 80; offset += CHANNEL_SPACING) {
              for (const dir of [1, -1]) {
                paths.push([[startX, startY], [startX, endY + offset * dir], [endX, endY + offset * dir], [endX, endY]]);
              }
            }
          }

          // Add fallback paths that go around edges
          if (isStartHorizontal) {
            paths.push([
              [startX, startY],
              [startX + (startSide === 'right' ? 30 : -30), startY],
              [startX + (startSide === 'right' ? 30 : -30), minTableY - 20],
              [endX + (endSide === 'right' ? 30 : endSide === 'left' ? -30 : 0), minTableY - 20],
              [endX + (endSide === 'right' ? 30 : endSide === 'left' ? -30 : 0), endY],
              [endX, endY]
            ]);
          } else {
            paths.push([
              [startX, startY],
              [startX, startY + (startSide === 'bottom' ? 30 : -30)],
              [minTableX - 20, startY + (startSide === 'bottom' ? 30 : -30)],
              [minTableX - 20, endY + (endSide === 'bottom' ? 30 : endSide === 'top' ? -30 : 0)],
              [endX, endY + (endSide === 'bottom' ? 30 : endSide === 'top' ? -30 : 0)],
              [endX, endY]
            ]);
          }

          return paths;
        };

        // Determine preferred connection sides based on relative position
        // Priority: connect from the side that faces the target table
        const preferredStartSides = [];
        const preferredEndSides = [];
        
        if (Math.abs(dx) > Math.abs(dy)) {
          // Tables are more horizontal - prefer left/right connections
          if (dx > 0) {
            preferredStartSides.push('right', 'bottom', 'top', 'left');
            preferredEndSides.push('left', 'top', 'bottom', 'right');
          } else {
            preferredStartSides.push('left', 'bottom', 'top', 'right');
            preferredEndSides.push('right', 'top', 'bottom', 'left');
          }
        } else {
          // Tables are more vertical - prefer top/bottom connections
          if (dy > 0) {
            preferredStartSides.push('bottom', 'right', 'left', 'top');
            preferredEndSides.push('top', 'left', 'right', 'bottom');
          } else {
            preferredStartSides.push('top', 'right', 'left', 'bottom');
            preferredEndSides.push('bottom', 'left', 'right', 'top');
          }
        }
        
        // Try all connection point combinations in priority order
        outer: for (const startSide of preferredStartSides) {
          for (const endSide of preferredEndSides) {
            const startPt = getConnectionPoint(fromBox, startSide);
            const endPt = getConnectionPoint(toBox, endSide);
            
            const candidatePaths = generatePaths(startPt.x, startPt.y, endPt.x, endPt.y, startSide, endSide);
            
            for (const path of candidatePaths) {
              if (isPathValid(path, rel.from_table, rel.to_table)) {
                // Calculate path length for scoring
                let pathLength = 0;
                for (let i = 0; i < path.length - 1; i++) {
                  pathLength += Math.abs(path[i+1][0] - path[i][0]) + Math.abs(path[i+1][1] - path[i][1]);
                }
                
                if (pathLength < bestScore) {
                  bestPath = path;
                  bestScore = pathLength;
                  // If we found a good path with preferred sides, use it
                  if (startSide === preferredStartSides[0] && endSide === preferredEndSides[0]) {
                    break outer;
                  }
                }
              }
            }
          }
        }

        // Fallback to simple path if nothing works
        if (!bestPath) {
          const startPt = getConnectionPoint(fromBox, preferredStartSides[0]);
          const endPt = getConnectionPoint(toBox, preferredEndSides[0]);
          
          if (Math.abs(dx) > Math.abs(dy)) {
            const midX = (startPt.x + endPt.x) / 2;
            bestPath = [[startPt.x, startPt.y], [midX, startPt.y], [midX, endPt.y], [endPt.x, endPt.y]];
          } else {
            const midY = (startPt.y + endPt.y) / 2;
            bestPath = [[startPt.x, startPt.y], [startPt.x, midY], [endPt.x, midY], [endPt.x, endPt.y]];
          }
        }

        // Simplify path - remove redundant points
        const simplifiedPath = [bestPath[0]];
        for (let i = 1; i < bestPath.length - 1; i++) {
          const prev = bestPath[i - 1];
          const curr = bestPath[i];
          const next = bestPath[i + 1];
          // Keep point only if direction changes
          const sameX = Math.abs(prev[0] - curr[0]) < 1 && Math.abs(curr[0] - next[0]) < 1;
          const sameY = Math.abs(prev[1] - curr[1]) < 1 && Math.abs(curr[1] - next[1]) < 1;
          if (!sameX && !sameY) {
            simplifiedPath.push(curr);
          } else if (!sameX || !sameY) {
            simplifiedPath.push(curr);
          }
        }
        simplifiedPath.push(bestPath[bestPath.length - 1]);

        addPathSegments(simplifiedPath);

        newLines.push({
          path: simplifiedPath,
          fromTable: rel.from_table,
          fromCol: rel.from_column,
          toTable: rel.to_table,
          toCol: rel.to_column,
          inferred: rel.inferred,
          id: `${rel.from_table}.${rel.from_column}-${rel.to_table}.${rel.to_column}`,
        });
      }

      setLines(newLines);
    };

    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [schema, positions, updateTrigger, allRels, zoom]);

  // Drag handlers
  const handleMouseDown = (tableName, e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = positions[tableName] || { x: 0, y: 0 };
    setDragState({ tableName, startX, startY, startPos });
  };

  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e) => {
      // Adjust for zoom level
      const dx = (e.clientX - dragState.startX) / zoom;
      const dy = (e.clientY - dragState.startY) / zoom;
      setPositions(prev => ({
        ...prev,
        [dragState.tableName]: {
          x: Math.max(0, dragState.startPos.x + dx),
          y: Math.max(0, dragState.startPos.y + dy),
        }
      }));
      setUpdateTrigger(t => t + 1);
    };

    const handleMouseUp = () => {
      setDragState(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState, zoom]);

  // Drag-to-connect handlers
  const handleConnectStart = (tableName, colName, e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!canvasRef.current) return;
    const cRect = canvasRef.current.getBoundingClientRect();
    setConnectDrag({
      fromTable: tableName,
      fromCol: colName,
      startX: (e.clientX - cRect.left) / zoom,
      startY: (e.clientY - cRect.top) / zoom,
      x: (e.clientX - cRect.left) / zoom,
      y: (e.clientY - cRect.top) / zoom,
    });
  };

  useEffect(() => {
    if (!connectDrag) return;

    const handleConnectMove = (e) => {
      if (!canvasRef.current) return;
      const cRect = canvasRef.current.getBoundingClientRect();
      setConnectDrag(prev => ({
        ...prev,
        x: (e.clientX - cRect.left) / zoom,
        y: (e.clientY - cRect.top) / zoom,
      }));
    };

    const handleConnectEnd = (e) => {
      // Find if we're over a column
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const colEl = target?.closest('[data-col-id]');
      
      if (colEl) {
        const toTable = colEl.dataset.tableName;
        const toCol = colEl.dataset.colName;
        
        // Don't connect to same column
        if (toTable !== connectDrag.fromTable || toCol !== connectDrag.fromCol) {
          // Check if relationship already exists
          const exists = allRels.some(r => 
            (r.from_table === connectDrag.fromTable && r.from_column === connectDrag.fromCol && 
             r.to_table === toTable && r.to_column === toCol) ||
            (r.to_table === connectDrag.fromTable && r.to_column === connectDrag.fromCol && 
             r.from_table === toTable && r.from_column === toCol)
          );
          
          if (!exists) {
            setUserRelationships(prev => [...prev, {
              from_table: connectDrag.fromTable,
              from_column: connectDrag.fromCol,
              to_table: toTable,
              to_column: toCol,
            }]);
            setUpdateTrigger(t => t + 1);
          }
        }
      }
      
      setConnectDrag(null);
    };

    window.addEventListener("mousemove", handleConnectMove);
    window.addEventListener("mouseup", handleConnectEnd);
    return () => {
      window.removeEventListener("mousemove", handleConnectMove);
      window.removeEventListener("mouseup", handleConnectEnd);
    };
  }, [connectDrag, zoom, allRels]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Legend bar */}
      <div style={styles.legendBar}>
        <div style={styles.legendLeft}>
          <span style={styles.legendTitle}>Entity Relationship Diagram</span>
          <span style={styles.legendCount}>{schema.tables.length} tables · {allRels.length} relationships</span>
        </div>
        <div style={styles.legendCenter}>
          <span style={styles.legendItem}>
            <svg width="36" height="14">
              <path d="M 2 7 L 8 3 M 2 7 L 8 7 M 2 7 L 8 11" stroke="#6366f1" strokeWidth="1.5" fill="none" />
              <line x1="8" y1="7" x2="28" y2="7" stroke="#6366f1" strokeWidth="1.5" />
              <path d="M 28 3 L 28 11" stroke="#6366f1" strokeWidth="1.5" fill="none" />
            </svg>
            <span>Many-to-One</span>
          </span>
          <span style={styles.legendItem}>
            <svg width="36" height="14">
              <line x1="2" y1="7" x2="34" y2="7" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="3,2" />
            </svg>
            <span>Inferred</span>
          </span>
        </div>
        <div style={styles.legendRight}>
          {/* Zoom controls */}
          <div style={styles.zoomControls}>
            <button onClick={handleZoomOut} style={styles.zoomBtn} title="Zoom out">−</button>
            <button onClick={handleZoomReset} style={styles.zoomLabel} title="Reset zoom">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={handleZoomIn} style={styles.zoomBtn} title="Zoom in">+</button>
            <button onClick={handleZoomFit} style={styles.zoomBtnFit} title="Fit to view">Fit</button>
          </div>
        </div>
      </div>

      {/* Canvas area — occupies remaining space */}
      <div style={{ ...styles.erdContainer, flex: 1 }}>
      {/* Scrollable canvas container */}
      <div ref={containerRef} style={styles.canvasScroller}>
        {/* Zoomable content */}
        <div 
          ref={canvasRef}
          style={{ 
            ...styles.canvas, 
            width: canvasSize.width,
            height: canvasSize.height,
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
            cursor: dragState ? "grabbing" : "default",
          }}
        >
          {/* SVG for relationship lines */}
          <svg style={styles.svgOverlay} width={canvasSize.width} height={canvasSize.height}>
            <defs>
              {/* Crow's foot markers - smaller and cleaner */}
            <marker id="cf-many" markerWidth="12" markerHeight="12" refX="0" refY="6" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M 0 6 L 8 2 M 0 6 L 8 6 M 0 6 L 8 10" stroke="#6366f1" strokeWidth="1.5" fill="none" />
            </marker>
            <marker id="cf-many-i" markerWidth="12" markerHeight="12" refX="0" refY="6" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M 0 6 L 8 2 M 0 6 L 8 6 M 0 6 L 8 10" stroke="#94a3b8" strokeWidth="1.5" fill="none" />
            </marker>
            <marker id="cf-one" markerWidth="10" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M 6 2 L 6 10" stroke="#6366f1" strokeWidth="1.5" fill="none" />
            </marker>
            <marker id="cf-one-i" markerWidth="10" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M 6 2 L 6 10" stroke="#94a3b8" strokeWidth="1.5" fill="none" />
            </marker>
          </defs>
          {lines.map((l) => (
            <RelationshipLine 
              key={l.id} 
              line={l} 
              isHovered={hoveredLine === l.id}
              onHover={() => setHoveredLine(l.id)}
              onLeave={() => setHoveredLine(null)}
            />
          ))}
          {/* Temporary connection line while dragging */}
          {connectDrag && (
            <line
              x1={connectDrag.startX}
              y1={connectDrag.startY}
              x2={connectDrag.x}
              y2={connectDrag.y}
              stroke="#8b5cf6"
              strokeWidth={2}
              strokeDasharray="5,3"
              pointerEvents="none"
            />
          )}
        </svg>

        {/* Table cards */}
        {schema.tables.map((table) => (
          <TableCard
            key={table.name}
            table={table}
            position={positions[table.name] || { x: 0, y: 0 }}
            onMouseDown={(e) => handleMouseDown(table.name, e)}
            onConnectStart={handleConnectStart}
            cardRef={(el) => { cardRefs.current[table.name] = el; }}
            isDragging={dragState?.tableName === table.name}
            isConnecting={!!connectDrag}
            allRels={allRels}
          />
        ))}
        </div>
      </div>

      {/* Zoom hint */}
      <div style={styles.zoomHint}>
        Hold <kbd style={styles.kbd}>⌘</kbd> or <kbd style={styles.kbd}>Ctrl</kbd> + scroll to zoom
      </div>
      </div>
    </div>
  );
}

// ── Relationship line (smooth bezier with hover tooltip) ─────────────────────

function RelationshipLine({ line, isHovered, onHover, onLeave }) {
  const { path, fromTable, fromCol, toTable, toCol, inferred } = line;
  const color = isHovered ? "#4f46e5" : inferred ? "#94a3b8" : "#6366f1";
  const strokeWidth = isHovered ? 2.5 : 1.5;
  
  if (!path || path.length < 2) return null;

  // Build orthogonal path with rounded corners
  const CORNER_RADIUS = 6;
  
  const buildPathWithCorners = () => {
    if (path.length === 2) {
      // Simple line
      return `M ${path[0][0]} ${path[0][1]} L ${path[1][0]} ${path[1][1]}`;
    }
    
    let d = `M ${path[0][0]} ${path[0][1]}`;
    
    for (let i = 1; i < path.length - 1; i++) {
      const [px, py] = path[i - 1];
      const [cx, cy] = path[i];
      const [nx, ny] = path[i + 1];
      
      // Calculate corner start before this point
      const dx1 = cx - px;
      const dy1 = cy - py;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const dx2 = nx - cx;
      const dy2 = ny - cy;
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      
      const r = Math.min(CORNER_RADIUS, len1 / 2, len2 / 2);
      
      if (r > 0 && len1 > 0 && len2 > 0) {
        // Corner start point
        const csX = cx - (dx1 / len1) * r;
        const csY = cy - (dy1 / len1) * r;
        // Corner end point
        const ceX = cx + (dx2 / len2) * r;
        const ceY = cy + (dy2 / len2) * r;
        
        d += ` L ${csX} ${csY}`;
        d += ` Q ${cx} ${cy} ${ceX} ${ceY}`;
      } else {
        d += ` L ${cx} ${cy}`;
      }
    }
    
    // Final point
    const last = path[path.length - 1];
    d += ` L ${last[0]} ${last[1]}`;
    
    return d;
  };

  const d = buildPathWithCorners();
  
  // Calculate midpoint for tooltip
  const midIdx = Math.floor(path.length / 2);
  const midX = path.length > 2 
    ? (path[midIdx - 1][0] + path[midIdx][0]) / 2 
    : (path[0][0] + path[1][0]) / 2;
  const midY = path.length > 2 
    ? (path[midIdx - 1][1] + path[midIdx][1]) / 2 
    : (path[0][1] + path[1][1]) / 2;

  return (
    <g style={{ cursor: "pointer" }} onMouseEnter={onHover} onMouseLeave={onLeave}>
      {/* Invisible wider path for easier hovering */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={12} style={{ pointerEvents: "stroke" }} />
      
      {/* Visible path */}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={inferred ? "5,3" : "none"}
        markerStart={inferred ? "url(#cf-many-i)" : "url(#cf-many)"}
        markerEnd={inferred ? "url(#cf-one-i)" : "url(#cf-one)"}
        style={{ transition: "stroke 0.15s, stroke-width 0.15s" }}
      />
      
      {/* Tooltip on hover */}
      {isHovered && (
        <g>
          <rect
            x={midX - 70}
            y={midY - 12}
            width={140}
            height={24}
            rx={4}
            fill="#1e293b"
            stroke={color}
            strokeWidth={1}
          />
          <text
            x={midX}
            y={midY + 4}
            textAnchor="middle"
            fontSize={11}
            fontWeight={500}
            fontFamily="system-ui, sans-serif"
            fill="#fff"
          >
            {fromTable}.{fromCol} → {toCol}
          </text>
        </g>
      )}
    </g>
  );
}

// ── Table card ──────────────────────────────────────────────────────────────

function TableCard({ table, position, onMouseDown, onConnectStart, cardRef, isDragging, isConnecting, allRels }) {
  const [hoveredCol, setHoveredCol] = useState(null);
  
  // Find which columns are involved in relationships
  const fkCols = new Set();
  const pkCols = new Set(table.primary_key || []);
  
  allRels?.forEach(r => {
    if (r.from_table === table.name) fkCols.add(r.from_column);
  });

  return (
    <div
      ref={cardRef}
      style={{
        ...styles.card,
        position: "absolute",
        left: position?.x || 0,
        top: position?.y || 0,
        boxShadow: isDragging 
          ? "0 8px 24px rgba(99, 102, 241, 0.25)" 
          : "0 2px 8px rgba(0,0,0,0.06)",
        transform: isDragging ? "scale(1.02)" : "scale(1)",
        zIndex: isDragging ? 100 : 2,
        transition: isDragging ? "none" : "box-shadow 0.2s, transform 0.2s",
      }}
    >
      <div 
        style={styles.cardHeader}
        onMouseDown={onMouseDown}
      >
        <span style={styles.cardTitle}>{table.name}</span>
        <span style={styles.cardCount}>{table.columns.length}</span>
      </div>
      <div style={styles.cardBody}>
        {table.columns.slice(0, 8).map((col) => {
          const isPk = pkCols.has(col.name);
          const isFk = fkCols.has(col.name);
          const isHovered = hoveredCol === col.name;
          return (
            <div
              key={col.name}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", col.name);
                e.dataTransfer.setData("application/x-table-name", table.name);
                e.dataTransfer.setData("application/x-col-type", col.type || "TEXT");
                e.dataTransfer.effectAllowed = "copy";
              }}
              data-col-id={`${table.name}.${col.name}`}
              data-table-name={table.name}
              data-col-name={col.name}
              onMouseEnter={() => setHoveredCol(col.name)}
              onMouseLeave={() => setHoveredCol(null)}
              style={{
                ...styles.colRow,
                background: isConnecting && isHovered
                  ? "#3d2f6e"
                  : isPk ? "#2d2554" : isFk ? "#2a2040" : "transparent",
                cursor: isConnecting ? "crosshair" : "grab",
              }}
            >
              {/* Connection handle on left */}
              <span 
                style={{
                  ...styles.connectHandle,
                  opacity: isHovered && !isConnecting ? 1 : 0,
                }}
                onMouseDown={(e) => onConnectStart?.(table.name, col.name, e)}
                title="Drag to connect"
              >
                ○
              </span>
              <span style={styles.colIndicator}>
                {isPk && <span style={styles.pkDot} />}
                {isFk && <span style={styles.fkDot} />}
              </span>
              <span style={{ ...styles.colName, color: isFk ? "#c4b5fd" : isPk ? "#818cf8" : "#e8ecf4" }}>
                {col.name}
              </span>
              <span style={styles.colType}>{col.type}</span>
            </div>
          );
        })}
        {table.columns.length > 8 && (
          <div style={styles.moreRows}>
            +{table.columns.length - 8} more columns
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  wrapper: { 
    height: "100%",
    display: "flex",
    flexDirection: "column",
  },

  // CSV
  csvCenter: { 
    display: "flex", 
    justifyContent: "center", 
    alignItems: "center",
    padding: "40px 20px",
    flex: 1,
  },

  // ERD container
  erdContainer: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#1a1d2e",
  },

  // Legend bar at top — sits above the ERD canvas
  legendBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 16px",
    background: "#212538",
    borderBottom: "1px solid #363c56",
    flexShrink: 0,
  },
  legendLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  legendTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#e8ecf4",
  },
  legendCount: {
    fontSize: 12,
    color: "#a0a8c0",
  },
  legendCenter: {
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  legendRight: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: "#a0a8c0",
    fontWeight: 500,
  },

  // Zoom controls
  zoomControls: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    background: "#2a2f45",
    borderRadius: 6,
    padding: 2,
  },
  zoomBtn: {
    width: 28,
    height: 28,
    border: "none",
    background: "transparent",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 16,
    fontWeight: 600,
    color: "#e8ecf4",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 0.15s",
  },
  zoomLabel: {
    minWidth: 44,
    height: 28,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    color: "#e8ecf4",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  zoomBtnFit: {
    height: 28,
    padding: "0 10px",
    border: "none",
    background: "transparent",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    color: "#a78bfa",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 0.15s",
  },

  // Zoom hint
  zoomHint: {
    padding: "6px 12px",
    background: "#1a1d2e",
    borderTop: "1px solid #363c56",
    fontSize: 11,
    color: "#7a82a0",
    textAlign: "center",
    flexShrink: 0,
  },
  kbd: {
    display: "inline-block",
    padding: "1px 5px",
    background: "#2a2f45",
    borderRadius: 3,
    fontSize: 10,
    fontFamily: "system-ui, sans-serif",
    fontWeight: 600,
    color: "#a0a8c0",
    marginLeft: 2,
    marginRight: 2,
  },

  // Scrollable canvas container
  canvasScroller: {
    flex: 1,
    overflow: "auto",
    position: "relative",
    background: "#1a1d2e",
  },

  // Zoomable canvas content
  canvas: {
    position: "relative",
    padding: 24,
    background: `
      radial-gradient(circle at 1px 1px, #363c56 1px, transparent 0)
    `,
    backgroundColor: "#1a1d2e",
    backgroundSize: "24px 24px",
  },

  // SVG overlay
  svgOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    pointerEvents: "none",
    overflow: "visible",
    zIndex: 1,
  },

  // Entity card
  card: {
    border: "1px solid #363c56",
    borderRadius: 8,
    overflow: "hidden",
    width: 200,
    background: "#2a2f45",
    userSelect: "none",
  },
  cardHeader: {
    background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
    padding: "10px 12px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    cursor: "grab",
  },
  cardTitle: {
    color: "#fff",
    fontWeight: 600,
    fontSize: 13,
    letterSpacing: "-0.01em",
  },
  cardCount: {
    background: "rgba(255,255,255,0.2)",
    color: "#fff",
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 6px",
    borderRadius: 10,
  },
  cardBody: {
    maxHeight: 280,
    overflowY: "auto",
  },
  colRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderBottom: "1px solid #363c56",
    fontSize: 12,
    position: "relative",
    transition: "background 0.15s",
  },
  connectHandle: {
    width: 14,
    height: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    color: "#8b5cf6",
    cursor: "crosshair",
    flexShrink: 0,
    transition: "opacity 0.1s",
    marginLeft: -4,
  },
  colIndicator: {
    width: 8,
    display: "flex",
    flexShrink: 0,
  },
  pkDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#4f46e5",
  },
  fkDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#8b5cf6",
  },
  colName: { 
    flex: 1, 
    fontWeight: 500,
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  colType: { 
    color: "#7a82a0", 
    fontSize: 10, 
    fontFamily: "monospace",
    flexShrink: 0,
  },
  moreRows: {
    padding: "8px 10px",
    fontSize: 11,
    color: "#7a82a0",
    textAlign: "center",
    background: "#212538",
    fontStyle: "italic",
  },
};
