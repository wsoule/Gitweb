class GitGraph {
  constructor(svgId) {
    this.svgEl = document.getElementById(svgId);
    this.nodes = [];
    this.links = [];
    this.simulation = null;
    this.selectedNode = null;
    this.onNodeClick = null;
    this.onNodeDblClick = null;

    // Cached DOM arrays for fast tick updates
    this._linkEls = [];
    this._nodeEls = [];

    this.colors = {
      user:        '#f1c40f',
      org:         '#f1c40f',
      repo:        '#58a6ff',
      contributor: '#3fb950',
      language:    '#bc8cff',
      topic:       '#ffa657',
    };

    this._init();
    this._bindResize();
  }

  get W() { return this.svgEl.clientWidth; }
  get H() { return this.svgEl.clientHeight; }

  // ── Setup ─────────────────────────────────────────────

  _init() {
    const svg = d3.select(this.svgEl);

    svg.on('click', (e) => {
      if (e.target === this.svgEl || e.target.tagName === 'rect') {
        this._deselect();
        if (this.onNodeClick) this.onNodeClick(null);
      }
    });

    this.zoom = d3.zoom()
      .scaleExtent([0.04, 10])
      .on('zoom', (e) => this.root.attr('transform', e.transform));

    svg.call(this.zoom).on('dblclick.zoom', null);

    const defs = svg.append('defs');
    this._addGlowFilter(defs);
    this._addBgGradient(defs);

    svg.append('rect')
      .attr('width', '100%').attr('height', '100%')
      .attr('fill', 'url(#bg-grad)');

    this.root      = svg.append('g').attr('class', 'graph-root');
    this.linkLayer = this.root.append('g').attr('class', 'links');
    this.nodeLayer = this.root.append('g').attr('class', 'nodes');

    this.paused = false;

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
      .force('center',  d3.forceCenter(this.W / 2, this.H / 2).strength(0.03))
      .force('collide', d3.forceCollide().radius(d => d.radius + 6).strength(0.3).iterations(1))
      .on('tick', () => this._tick());
  }

  _addGlowFilter(defs) {
    const f = defs.append('filter')
      .attr('id', 'glow')
      .attr('x', '-60%').attr('y', '-60%')
      .attr('width', '220%').attr('height', '220%');
    f.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '5').attr('result', 'blur');
    const m = f.append('feMerge');
    m.append('feMergeNode').attr('in', 'blur');
    m.append('feMergeNode').attr('in', 'SourceGraphic');
  }

  _addBgGradient(defs) {
    const g = defs.append('radialGradient')
      .attr('id', 'bg-grad').attr('cx', '50%').attr('cy', '50%').attr('r', '75%');
    g.append('stop').attr('offset', '0%'  ).attr('stop-color', '#182030');
    g.append('stop').attr('offset', '100%').attr('stop-color', '#0d1117');
  }

  _bindResize() {
    new ResizeObserver(() => {
      if (this.simulation) {
        this.simulation.force('center', d3.forceCenter(this.W / 2, this.H / 2)).alpha(0.1).restart();
      }
    }).observe(this.svgEl.parentElement);
  }

  // ── Render ────────────────────────────────────────────

  update(nodes, links) {
    this.nodes = nodes;
    this.links = links;

    const isLarge = nodes.length > 200;

    // ── Links ──
    this.linkLayer.selectAll('line.link')
      .data(links, d => d._key)
      .join(
        enter => enter.append('line')
          .attr('class', 'link')
          .attr('stroke',           d => _linkStroke(d))
          .attr('stroke-width',     1)
          .attr('stroke-dasharray', d => d._type === 'shared-contributor' ? '5,4' : null)
          .attr('opacity', isLarge ? 1 : 0)
          .call(s => isLarge ? s : s.transition().duration(500).attr('opacity', 1)),
        update => update
          .attr('stroke',           d => _linkStroke(d))
          .attr('stroke-dasharray', d => d._type === 'shared-contributor' ? '5,4' : null),
        exit => isLarge ? exit.remove() : exit.transition().duration(250).attr('opacity', 0).remove()
      );

    // ── Nodes ──
    this.nodeLayer.selectAll('g.node')
      .data(nodes, d => d.id)
      .join(
        enter => {
          const g = enter.append('g').attr('class', 'node').attr('opacity', isLarge ? 1 : 0);

          // Only apply expensive glow filter on primary nodes
          const useGlow = d => d.type === 'user' || d.type === 'org' || d.type === 'repo';

          g.append('circle')
            .attr('class', 'node-glow')
            .attr('r', d => d.radius * 2.2)
            .attr('fill', d => this.colors[d.type] || '#888')
            .attr('opacity', d => d.expanded ? 0.16 : 0.08)
            .attr('filter', d => useGlow(d) ? 'url(#glow)' : null);

          g.append('circle')
            .attr('class', 'node-circle')
            .attr('r', d => d.radius)
            .attr('fill', d => this.colors[d.type] || '#888')
            .attr('stroke', d => d.expanded ? this.colors[d.type] : '#0d1117')
            .attr('stroke-width', d => d.expanded ? 2.5 : 1.5)
            .attr('stroke-dasharray', d => d.expanded ? '4,3' : null);

          g.append('text')
            .attr('class', 'node-label')
            .attr('dy', d => d.radius + 13)
            .attr('text-anchor', 'middle')
            .attr('fill', '#adb5bd')
            .attr('font-size',   d => (d.type === 'user' || d.type === 'org') ? '12px' : '10px')
            .attr('font-weight', d => (d.type === 'user' || d.type === 'org') ? '600'  : '400')
            .text(d => {
              const max = (d.type === 'user' || d.type === 'org') ? 22 : 16;
              return d.label.length > max ? d.label.slice(0, max - 1) + '…' : d.label;
            });

          g.call(this._drag());
          g.on('click',    (e, d) => { e.stopPropagation(); this._select(d); if (this.onNodeClick)    this.onNodeClick(d); });
          g.on('dblclick', (e, d) => { e.stopPropagation();                  if (this.onNodeDblClick) this.onNodeDblClick(d); });
          g.on('mouseover', (e, d) => d3.select(e.currentTarget).select('.node-glow').attr('opacity', 0.26));
          g.on('mouseout',  (e, d) => d3.select(e.currentTarget).select('.node-glow').attr('opacity', this.selectedNode === d ? 0.26 : (d.expanded ? 0.16 : 0.08)));

          if (!isLarge) g.transition().duration(450).attr('opacity', 1);
          return g;
        },
        update => {
          update.select('.node-circle')
            .attr('stroke',           d => d.expanded ? this.colors[d.type] : '#0d1117')
            .attr('stroke-width',     d => d.expanded ? 2.5 : 1.5)
            .attr('stroke-dasharray', d => d.expanded ? '4,3' : null);
          update.select('.node-glow')
            .attr('opacity', d => d.expanded ? 0.16 : 0.08);
          return update;
        },
        exit => isLarge ? exit.remove() : exit.transition().duration(280).attr('opacity', 0).remove()
      );

    // Cache raw DOM elements for fast _tick
    this._linkEls = this.linkLayer.node().children;
    this._nodeEls = this.nodeLayer.node().children;

    // Restart simulation
    this.simulation.nodes(nodes);
    this.simulation.force('link').links(links);
    this.paused = false;
    this.simulation.alpha(0.3).restart();
  }

  _tick() {
    // Direct DOM manipulation — bypasses D3 selection overhead
    const linkEls = this._linkEls;
    const links   = this.links;
    for (let i = 0, n = Math.min(linkEls.length, links.length); i < n; i++) {
      const l  = links[i];
      const el = linkEls[i];
      el.setAttribute('x1', l.source.x);
      el.setAttribute('y1', l.source.y);
      el.setAttribute('x2', l.target.x);
      el.setAttribute('y2', l.target.y);
    }

    const nodeEls = this._nodeEls;
    const nodes   = this.nodes;
    for (let i = 0, n = Math.min(nodeEls.length, nodes.length); i < n; i++) {
      const d = nodes[i];
      nodeEls[i].setAttribute('transform', `translate(${d.x ?? 0},${d.y ?? 0})`);
    }
  }

  // ── Selection ─────────────────────────────────────────

  _select(node) {
    this.selectedNode = node;
    const linked = new Set([node.id]);
    this.links.forEach(l => {
      const s = l.source?.id ?? l.source, t = l.target?.id ?? l.target;
      if (s === node.id || t === node.id) { linked.add(s); linked.add(t); }
    });

    this.nodeLayer.selectAll('g.node').attr('opacity', d => linked.has(d.id) ? 1 : 0.15);

    this.linkLayer.selectAll('line.link').attr('stroke', d => {
      const s = d.source?.id ?? d.source, t = d.target?.id ?? d.target;
      if (s === node.id || t === node.id) return 'rgba(255,255,255,0.55)';
      return d._type === 'shared-contributor' ? 'rgba(63,185,80,0.04)' : 'rgba(255,255,255,0.03)';
    }).attr('stroke-width', d => {
      const s = d.source?.id ?? d.source, t = d.target?.id ?? d.target;
      return (s === node.id || t === node.id) ? 2 : 1;
    });
  }

  _deselect() {
    this.selectedNode = null;
    this.nodeLayer.selectAll('g.node').attr('opacity', 1);
    this.linkLayer.selectAll('line.link')
      .attr('stroke',       d => _linkStroke(d))
      .attr('stroke-width', 1);
  }

  // ── Drag ──────────────────────────────────────────────

  _drag() {
    return d3.drag()
      .on('start', (e, d) => { if (!e.active) this.simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) this.simulation.alphaTarget(0); d.fx = null; d.fy = null; });
  }

  // ── Camera ────────────────────────────────────────────

  fitView() {
    if (!this.nodes.length) return;
    const box = this.root.node().getBBox();
    if (!box.width || !box.height) return;
    const pad = 60;
    const scale = Math.min((this.W - pad * 2) / box.width, (this.H - pad * 2) / box.height, 2);
    const tx = this.W / 2 - scale * (box.x + box.width  / 2);
    const ty = this.H / 2 - scale * (box.y + box.height / 2);
    d3.select(this.svgEl).transition().duration(650).call(
      this.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  }

  zoomBy(factor) {
    d3.select(this.svgEl).transition().duration(220).call(this.zoom.scaleBy, factor);
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

// ── Module-level helpers ───────────────────────────────

function _linkStroke(l) {
  return l._type === 'shared-contributor' ? 'rgba(63,185,80,0.22)' : 'rgba(255,255,255,0.1)';
}
