class GitGraph {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx    = this.canvas.getContext('2d');
    this.nodes  = [];
    this.links  = [];
    this.simulation = null;
    this.selectedNode = null;
    this.hoveredNode  = null;
    this.onNodeClick    = null;
    this.onNodeDblClick = null;

    // Transform state (pan + zoom)
    this.tx = 0;
    this.ty = 0;
    this.scale = 1;

    // Drag state
    this._dragNode   = null;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._isPanning  = false;
    this._panStartX  = 0;
    this._panStartY  = 0;

    this.paused = false;
    this._raf   = null;

    this.colors = {
      user:        '#e6edf3',
      org:         '#e6edf3',
      repo:        '#58a6ff',
      contributor: '#3fb950',
      language:    '#d2a8ff',
      topic:       '#f0883e',
    };

    this._glowColors = {};
    for (const [k, v] of Object.entries(this.colors)) {
      this._glowColors[k] = _hexToRgba(v, 0.12);
    }

    this._init();
    this._bindResize();
    this._bindMouse();
    this._startLoop();
  }

  get W() { return this.canvas.width; }
  get H() { return this.canvas.height; }

  // ── Setup ─────────────────────────────────────────────

  _init() {
    this._resize();

    this.simulation = d3.forceSimulation()
      .alphaDecay(0.06)
      .alphaMin(0.008)
      .velocityDecay(0.5)
      .force('link', d3.forceLink()
        .id(d => d.id)
        .distance(l => {
          if (l._type === 'shared-contributor') return 100;
          const st = l.source?.type || l.source;
          if (st === 'user' || st === 'org') return 250;
          return 140;
        })
        .strength(l => l._type === 'shared-contributor' ? 0.04 : 0.12)
        .iterations(1)
      )
      .force('charge', d3.forceManyBody()
        .strength(d => {
          if (d.type === 'user' || d.type === 'org') return -500;
          if (d.type === 'repo')                     return -200;
          return -100;
        })
        .theta(1.2)
        .distanceMax(600)
      )
      .force('center', d3.forceCenter(this.canvas.width / 2, this.canvas.height / 2).strength(0.03))
      .force('collide', d3.forceCollide().radius(d => d.radius + 6).strength(0.3).iterations(1));
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width  = rect.width  + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssW = rect.width;
    this._cssH = rect.height;
  }

  _bindResize() {
    new ResizeObserver(() => {
      this._resize();
      if (this.simulation) {
        this.simulation.force('center', d3.forceCenter(this._cssW / 2, this._cssH / 2));
        this.simulation.alpha(0.1).restart();
      }
    }).observe(this.canvas.parentElement);
  }

  // ── Mouse / touch ────────────────────────────────────

  _bindMouse() {
    const c = this.canvas;

    c.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 0.93;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      this.tx = mx - (mx - this.tx) * factor;
      this.ty = my - (my - this.ty) * factor;
      this.scale *= factor;
    }, { passive: false });

    c.addEventListener('mousedown', e => {
      const [wx, wy] = this._screenToWorld(e.offsetX, e.offsetY);
      const node = this._hitTest(wx, wy);

      if (node) {
        this._dragNode = node;
        this._dragStartX = wx;
        this._dragStartY = wy;
        this._dragMoved = false;
        node.fx = node.x;
        node.fy = node.y;
        this.simulation.alphaTarget(0.3).restart();
      } else {
        this._isPanning = true;
        this._panStartX = e.clientX - this.tx;
        this._panStartY = e.clientY - this.ty;
      }
    });

    c.addEventListener('mousemove', e => {
      if (this._dragNode) {
        const [wx, wy] = this._screenToWorld(e.offsetX, e.offsetY);
        this._dragNode.fx = wx;
        this._dragNode.fy = wy;
        const dx = wx - this._dragStartX;
        const dy = wy - this._dragStartY;
        if (dx * dx + dy * dy > 9) this._dragMoved = true;
      } else if (this._isPanning) {
        this.tx = e.clientX - this._panStartX;
        this.ty = e.clientY - this._panStartY;
      } else {
        const [wx, wy] = this._screenToWorld(e.offsetX, e.offsetY);
        const node = this._hitTest(wx, wy);
        this.hoveredNode = node;
        c.style.cursor = node ? 'pointer' : 'grab';
      }
    });

    c.addEventListener('mouseup', e => {
      if (this._dragNode) {
        if (!this._dragMoved) {
          this._select(this._dragNode);
          if (this.onNodeClick) this.onNodeClick(this._dragNode);
        }
        this._dragNode.fx = null;
        this._dragNode.fy = null;
        this._dragNode = null;
        this.simulation.alphaTarget(0);
      } else if (this._isPanning) {
        this._isPanning = false;
      } else {
        // Click on empty space
        this._deselect();
        if (this.onNodeClick) this.onNodeClick(null);
      }
    });

    c.addEventListener('dblclick', e => {
      const [wx, wy] = this._screenToWorld(e.offsetX, e.offsetY);
      const node = this._hitTest(wx, wy);
      if (node && this.onNodeDblClick) this.onNodeDblClick(node);
    });
  }

  _screenToWorld(sx, sy) {
    return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale];
  }

  _hitTest(wx, wy) {
    // Iterate in reverse so top-drawn nodes are hit first
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n  = this.nodes[i];
      const dx = wx - (n.x ?? 0);
      const dy = wy - (n.y ?? 0);
      const r  = n.radius + 4;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  // ── Render loop ──────────────────────────────────────

  _startLoop() {
    const loop = () => {
      this._draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _draw() {
    const ctx = this.ctx;
    const w   = this._cssW;
    const h   = this._cssH;

    // Clear
    ctx.save();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    // Apply pan/zoom
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const selected  = this.selectedNode;
    const linkedSet = this._linkedSet;

    // ── Links ──
    for (let i = 0, n = this.links.length; i < n; i++) {
      const l = this.links[i];
      const sx = l.source.x, sy = l.source.y;
      const tx = l.target.x, ty = l.target.y;
      if (sx === undefined || tx === undefined) continue;

      let alpha = l._type === 'shared-contributor' ? 0.15 : 0.1;
      let lw = 1;

      if (selected) {
        const sid = l.source.id, tid = l.target.id;
        if (sid === selected.id || tid === selected.id) {
          alpha = 0.55;
          lw = 2;
        } else {
          alpha = 0.03;
        }
      }

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      if (l._type === 'shared-contributor') {
        ctx.strokeStyle = `rgba(63,185,80,${alpha})`;
        ctx.setLineDash([5, 4]);
      } else {
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.setLineDash([]);
      }
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ── Nodes ──
    for (let i = 0, n = this.nodes.length; i < n; i++) {
      const d = this.nodes[i];
      const x = d.x ?? 0;
      const y = d.y ?? 0;
      const color = this.colors[d.type] || '#888';

      let nodeAlpha = 1;
      if (selected && linkedSet && !linkedSet.has(d.id)) nodeAlpha = 0.12;

      ctx.globalAlpha = nodeAlpha;

      // Glow (simple radial gradient — much cheaper than SVG filter)
      if (d.type === 'user' || d.type === 'org' || d.type === 'repo' || d === this.hoveredNode) {
        const gr = d.radius * 2.5;
        const grad = ctx.createRadialGradient(x, y, d.radius * 0.5, x, y, gr);
        grad.addColorStop(0, _hexToRgba(color, d === this.hoveredNode ? 0.25 : 0.12));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(x - gr, y - gr, gr * 2, gr * 2);
      }

      // Circle
      ctx.beginPath();
      ctx.arc(x, y, d.radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Stroke
      if (d.expanded) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = '#0d1117';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Label
      const isPrimary = d.type === 'user' || d.type === 'org';
      const fontSize  = isPrimary ? 12 : 10;
      const fontWeight = isPrimary ? '600' : '400';
      ctx.font = `${fontWeight} ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
      ctx.fillStyle = `rgba(173,181,189,${nodeAlpha})`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const maxLen = isPrimary ? 22 : 16;
      const label  = d.label.length > maxLen ? d.label.slice(0, maxLen - 1) + '…' : d.label;
      ctx.fillText(label, x, y + d.radius + 4);

      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  // ── Update ───────────────────────────────────────────

  update(nodes, links) {
    this.nodes = nodes;
    this.links = links;

    this.simulation.nodes(nodes);
    this.simulation.force('link').links(links);
    this.paused = false;
    this.simulation.alpha(0.3).restart();
  }

  // ── Selection ─────────────────────────────────────────

  _select(node) {
    this.selectedNode = node;
    const linked = new Set([node.id]);
    this.links.forEach(l => {
      const s = l.source?.id ?? l.source, t = l.target?.id ?? l.target;
      if (s === node.id || t === node.id) { linked.add(s); linked.add(t); }
    });
    this._linkedSet = linked;
  }

  _deselect() {
    this.selectedNode = null;
    this._linkedSet   = null;
  }

  // ── Camera ────────────────────────────────────────────

  fitView() {
    if (!this.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x === undefined) continue;
      minX = Math.min(minX, n.x - n.radius);
      minY = Math.min(minY, n.y - n.radius);
      maxX = Math.max(maxX, n.x + n.radius);
      maxY = Math.max(maxY, n.y + n.radius);
    }
    if (!isFinite(minX)) return;
    const bw  = maxX - minX;
    const bh  = maxY - minY;
    const pad = 60;
    const sw  = this._cssW - pad * 2;
    const sh  = this._cssH - pad * 2;
    const s   = Math.min(sw / bw, sh / bh, 2);
    this.scale = s;
    this.tx = this._cssW / 2 - s * (minX + bw / 2);
    this.ty = this._cssH / 2 - s * (minY + bh / 2);
  }

  zoomBy(factor) {
    const cx = this._cssW / 2;
    const cy = this._cssH / 2;
    this.tx = cx - (cx - this.tx) * factor;
    this.ty = cy - (cy - this.ty) * factor;
    this.scale *= factor;
  }

  togglePause() {
    this.paused = !this.paused;
    if (this.paused) {
      this.simulation.stop();
    } else {
      this.simulation.alpha(0.15).restart();
    }
    return this.paused;
  }
}

// ── Helpers ─────────────────────────────────────────────

function _hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
