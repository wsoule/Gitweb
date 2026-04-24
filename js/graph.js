class GraphVisualizer {
  constructor(svgId) {
    this.svgEl = document.getElementById(svgId);
    this.nodes = [];
    this.links = [];
    this.simulation = null;
    this.selectedNode = null;
    this._ptimer = null;

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
    this._startParticleTimer();
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
    // Particle layer sits above links but below nodes
    this.pLayer    = this.root.append('g').attr('class', 'particles').attr('pointer-events', 'none');
    this.nodeLayer = this.root.append('g').attr('class', 'nodes');

    this.simulation = d3.forceSimulation()
      .force('link', d3.forceLink()
        .id(d => d.id)
        .distance(l => {
          if (l._type === 'shared-contributor') return 65;
          const st = l.source?.type || l.source;
          if (st === 'user' || st === 'org') return 180;
          return 95;
        })
        .strength(l => l._type === 'shared-contributor' ? 0.1 : 0.35)
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

  // ── Particle animation ────────────────────────────────

  _startParticleTimer() {
    if (this._ptimer) this._ptimer.stop();
    const colors = this.colors;

    this._ptimer = d3.timer(() => {
      const now = Date.now() * 0.001;

      this.pLayer.selectAll('circle.ptcl').each(function(link) {
        // source/target are node objects only after the simulation has run
        if (!link.source?.x || !link.target?.x) return;

        const isShared = link._type === 'shared-contributor';
        const speed    = isShared ? 0.28 : 0.50;
        const phase    = ((now * speed) + link._phaseOffset) % 1;

        const x = link.source.x + (link.target.x - link.source.x) * phase;
        const y = link.source.y + (link.target.y - link.source.y) * phase;
        // Fade in/out at endpoints
        const maxAlpha = isShared ? 0.38 : 0.85;
        const opacity  = Math.sin(Math.PI * phase) * maxAlpha;

        // Raw DOM calls — avoid D3 overhead inside a 60fps loop
        this.setAttribute('cx', x);
        this.setAttribute('cy', y);
        this.setAttribute('opacity', opacity);
      });
    });
  }

  // ── Render ────────────────────────────────────────────

  update(nodes, links) {
    this.nodes = nodes;
    this.links = links;

    // Stamp a stable phase offset on every link so the timer can use it
    // without relying on array index (which shifts as links are added/removed)
    links.forEach(l => {
      if (l._phaseOffset === undefined) l._phaseOffset = _hashPhase(l._key);
    });

    // ── Links ──
    this.linkLayer.selectAll('line.link')
      .data(links, d => d._key)
      .join(
        enter => enter.append('line')
          .attr('class', 'link')
          .attr('stroke',           d => _linkStroke(d))
          .attr('stroke-width',     1)
          .attr('stroke-dasharray', d => d._type === 'shared-contributor' ? '5,4' : null)
          .attr('opacity', 0)
          .call(s => s.transition().duration(500).attr('opacity', 1)),
        update => update
          .attr('stroke',           d => _linkStroke(d))
          .attr('stroke-dasharray', d => d._type === 'shared-contributor' ? '5,4' : null),
        exit => exit.transition().duration(250).attr('opacity', 0).remove()
      );

    // ── Particles (one per link, colour = target node type) ──
    this.pLayer.selectAll('circle.ptcl')
      .data(links, d => d._key)
      .join(
        enter => enter.append('circle')
          .attr('class', 'ptcl')
          .attr('r',    d => d._type === 'shared-contributor' ? 1.5 : 2)
          .attr('fill', d => this.colors[d.target?.type] || '#fff')
          .attr('opacity', 0),
        update => update,
        exit => exit.remove()
      );

    // ── Nodes ──
    this.nodeLayer.selectAll('g.node')
      .data(nodes, d => d.id)
      .join(
        enter => {
          const g = enter.append('g').attr('class', 'node').attr('opacity', 0);

          g.append('circle')
            .attr('class', 'node-glow')
            .attr('r', d => d.radius * 2.2)
            .attr('fill', d => this.colors[d.type] || '#888')
            .attr('opacity', d => d.expanded ? 0.16 : 0.08)
            .attr('filter', 'url(#glow)');

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

          g.transition().duration(450).attr('opacity', 1);
          return g;
        },
        update => {
          // Re-apply expanded styling on existing nodes when state changes
          update.select('.node-circle')
            .attr('stroke',           d => d.expanded ? this.colors[d.type] : '#0d1117')
            .attr('stroke-width',     d => d.expanded ? 2.5 : 1.5)
            .attr('stroke-dasharray', d => d.expanded ? '4,3' : null);
          update.select('.node-glow')
            .attr('opacity', d => d.expanded ? 0.16 : 0.08);
          return update;
        },
        exit => exit.transition().duration(280).attr('opacity', 0).remove()
      );

    // Restart simulation — D3 mutates link.source / link.target to node refs
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
}

// ── Module-level helpers ───────────────────────────────

function _linkStroke(l) {
  return l._type === 'shared-contributor' ? 'rgba(63,185,80,0.22)' : 'rgba(255,255,255,0.1)';
}

// Deterministic [0,1) offset from a string — keeps particles spread regardless of sort order
function _hashPhase(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000;
}
