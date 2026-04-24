class GraphVisualizer {
  constructor(svgId) {
    this.svgEl = document.getElementById(svgId);
    this.nodes = [];
    this.links = [];
    this.simulation = null;
    this.selectedNode = null;

    // Callbacks set by App
    this.onNodeClick = null;
    this.onNodeDblClick = null;

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

    // Deselect on background click
    svg.on('click', (e) => {
      if (e.target === this.svgEl || e.target.tagName === 'rect') {
        this._deselect();
        if (this.onNodeClick) this.onNodeClick(null);
      }
    });

    // Zoom / pan
    this.zoom = d3.zoom()
      .scaleExtent([0.04, 10])
      .on('zoom', (e) => this.root.attr('transform', e.transform));

    svg.call(this.zoom)
       .on('dblclick.zoom', null); // reserve dblclick for nodes

    // Defs
    const defs = svg.append('defs');
    this._addGlowFilter(defs);
    this._addBgGradient(defs);

    // Background rect (catch click events)
    svg.append('rect')
      .attr('width', '100%').attr('height', '100%')
      .attr('fill', 'url(#bg-grad)');

    // Layered groups
    this.root      = svg.append('g').attr('class', 'graph-root');
    this.linkLayer = this.root.append('g').attr('class', 'links');
    this.nodeLayer = this.root.append('g').attr('class', 'nodes');

    // Force simulation
    this.simulation = d3.forceSimulation()
      .force('link', d3.forceLink()
        .id(d => d.id)
        .distance(l => {
          const st = (l.source.type || l.source);
          if (st === 'user' || st === 'org') return 180;
          return 95;
        })
        .strength(0.35)
      )
      .force('charge', d3.forceManyBody()
        .strength(d => {
          if (d.type === 'user' || d.type === 'org') return -700;
          if (d.type === 'repo')                     return -320;
          return -180;
        })
      )
      .force('center',  d3.forceCenter(this.W / 2, this.H / 2))
      .force('collide', d3.forceCollide().radius(d => d.radius + 10).strength(0.85))
      .on('tick', () => this._tick());
  }

  _addGlowFilter(defs) {
    const f = defs.append('filter')
      .attr('id', 'glow')
      .attr('x', '-60%').attr('y', '-60%')
      .attr('width', '220%').attr('height', '220%');

    f.append('feGaussianBlur')
      .attr('in', 'SourceGraphic')
      .attr('stdDeviation', '5')
      .attr('result', 'blur');

    const m = f.append('feMerge');
    m.append('feMergeNode').attr('in', 'blur');
    m.append('feMergeNode').attr('in', 'SourceGraphic');
  }

  _addBgGradient(defs) {
    const g = defs.append('radialGradient')
      .attr('id', 'bg-grad')
      .attr('cx', '50%').attr('cy', '50%').attr('r', '75%');
    g.append('stop').attr('offset', '0%' ).attr('stop-color', '#182030');
    g.append('stop').attr('offset', '100%').attr('stop-color', '#0d1117');
  }

  _bindResize() {
    new ResizeObserver(() => {
      if (this.simulation) {
        this.simulation
          .force('center', d3.forceCenter(this.W / 2, this.H / 2))
          .alpha(0.1).restart();
      }
    }).observe(this.svgEl.parentElement);
  }

  // ── Render ─────────────────────────────────────────────

  update(nodes, links) {
    this.nodes = nodes;
    this.links = links;

    // ── Links ──
    this.linkLayer.selectAll('line.link')
      .data(links, d => d._key)
      .join(
        enter => enter.append('line')
          .attr('class', 'link')
          .attr('stroke', 'rgba(255,255,255,0.1)')
          .attr('stroke-width', 1)
          .attr('opacity', 0)
          .call(s => s.transition().duration(500).attr('opacity', 1)),
        update => update,
        exit => exit.transition().duration(250).attr('opacity', 0).remove()
      );

    // ── Nodes ──
    this.nodeLayer.selectAll('g.node')
      .data(nodes, d => d.id)
      .join(
        enter => {
          const g = enter.append('g').attr('class', 'node').attr('opacity', 0);

          // Ambient glow circle
          g.append('circle')
            .attr('class', 'node-glow')
            .attr('r', d => d.radius * 2.2)
            .attr('fill', d => this.colors[d.type] || '#888')
            .attr('opacity', 0.08)
            .attr('filter', 'url(#glow)');

          // Main circle
          g.append('circle')
            .attr('class', 'node-circle')
            .attr('r', d => d.radius)
            .attr('fill', d => this.colors[d.type] || '#888')
            .attr('stroke', '#0d1117')
            .attr('stroke-width', 1.5);

          // Label
          g.append('text')
            .attr('class', 'node-label')
            .attr('dy', d => d.radius + 13)
            .attr('text-anchor', 'middle')
            .attr('fill', '#adb5bd')
            .attr('font-size', d => (d.type === 'user' || d.type === 'org') ? '12px' : '10px')
            .attr('font-weight', d => (d.type === 'user' || d.type === 'org') ? '600' : '400')
            .text(d => {
              const max = (d.type === 'user' || d.type === 'org') ? 22 : 16;
              return d.label.length > max ? d.label.slice(0, max - 1) + '…' : d.label;
            });

          // Interactions
          g.call(this._drag());
          g.on('click',    (e, d) => { e.stopPropagation(); this._select(d); if (this.onNodeClick)    this.onNodeClick(d); });
          g.on('dblclick', (e, d) => { e.stopPropagation();                  if (this.onNodeDblClick) this.onNodeDblClick(d); });
          g.on('mouseover', (e, d) => d3.select(e.currentTarget).select('.node-glow').attr('opacity', 0.22));
          g.on('mouseout',  (e, d) => d3.select(e.currentTarget).select('.node-glow').attr('opacity', this.selectedNode === d ? 0.22 : 0.08));

          g.transition().duration(450).attr('opacity', 1);
          return g;
        },
        update => update,
        exit => exit.transition().duration(280).attr('opacity', 0).remove()
      );

    // Restart simulation
    this.simulation.nodes(nodes);
    this.simulation.force('link').links(links);
    this.simulation.alpha(0.45).restart();
  }

  _tick() {
    this.linkLayer.selectAll('line.link')
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);

    this.nodeLayer.selectAll('g.node')
      .attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
  }

  // ── Selection / highlight ──────────────────────────────

  _select(node) {
    this.selectedNode = node;

    const linked = new Set([node.id]);
    this.links.forEach(l => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (s === node.id || t === node.id) { linked.add(s); linked.add(t); }
    });

    this.nodeLayer.selectAll('g.node')
      .attr('opacity', d => linked.has(d.id) ? 1 : 0.15);

    this.linkLayer.selectAll('line.link')
      .attr('stroke', d => {
        const s = d.source?.id ?? d.source, t = d.target?.id ?? d.target;
        return (s === node.id || t === node.id) ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.03)';
      })
      .attr('stroke-width', d => {
        const s = d.source?.id ?? d.source, t = d.target?.id ?? d.target;
        return (s === node.id || t === node.id) ? 2 : 1;
      });
  }

  _deselect() {
    this.selectedNode = null;
    this.nodeLayer.selectAll('g.node').attr('opacity', 1);
    this.linkLayer.selectAll('line.link')
      .attr('stroke', 'rgba(255,255,255,0.1)')
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
    const scale = Math.min(
      (this.W - pad * 2) / box.width,
      (this.H - pad * 2) / box.height,
      2
    );
    const tx = this.W / 2 - scale * (box.x + box.width  / 2);
    const ty = this.H / 2 - scale * (box.y + box.height / 2);
    d3.select(this.svgEl).transition().duration(650).call(
      this.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  }

  zoomBy(factor) {
    d3.select(this.svgEl).transition().duration(220).call(this.zoom.scaleBy, factor);
  }
}
