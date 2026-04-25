import { Graph } from '@cosmos.gl/graph'

export class GitGraph {
  constructor(containerId) {
    this.containerEl = document.getElementById(containerId);
    this.nodes  = [];
    this.links  = [];
    this.nodeIndexMap = new Map(); // id → array index
    this.selectedNode = null;
    this.onNodeClick    = null;
    this.onNodeDblClick = null;
    this.paused = false;

    // Double-click detection
    this._lastClickTime  = 0;
    this._lastClickIndex = -1;

    // Tooltip mouse tracking
    this._mouseX = 0;
    this._mouseY = 0;

    this.colorMap = {
      user:        '#e6edf3',
      org:         '#e6edf3',
      repo:        '#58a6ff',
      contributor: '#3fb950',
      language:    '#d2a8ff',
      topic:       '#f0883e',
    };

    this._rgbaCache = {};
    for (const [k, hex] of Object.entries(this.colorMap)) {
      this._rgbaCache[k] = hexToFloats(hex);
    }

    this._createTooltip();
    this._createGraph();
  }

  _createTooltip() {
    this._tooltip = document.createElement('div');
    this._tooltip.className = 'graph-tooltip';
    this._tooltip.style.cssText = 'display:none;position:fixed;z-index:50;pointer-events:none;' +
      'background:rgba(22,27,34,.95);border:1px solid #30363d;border-radius:6px;padding:4px 10px;' +
      'font-size:12px;color:#e6edf3;white-space:nowrap;backdrop-filter:blur(4px);';
    document.body.appendChild(this._tooltip);

    this.containerEl.addEventListener('mousemove', e => {
      this._mouseX = e.clientX;
      this._mouseY = e.clientY;
      if (this._tooltip.style.display === 'block') {
        this._tooltip.style.left = (e.clientX + 14) + 'px';
        this._tooltip.style.top  = (e.clientY - 6) + 'px';
      }
    });
  }

  _createGraph() {
    this.graph = new Graph(this.containerEl, {
      backgroundColor: '#0d1117',
      pointDefaultColor: '#888888',
      linkDefaultColor: '#ffffff',
      linkOpacity: 0.12,
      linkDefaultWidth: 1,
      linkGreyoutOpacity: 0.03,
      enableDrag: true,
      fitViewOnInit: true,
      fitViewDelay: 600,
      fitViewPadding: 0.12,
      fitViewDuration: 500,
      spaceSize: 8192,
      enableSimulation: true,
      simulationGravity: 0.15,
      simulationRepulsion: 0.8,
      simulationLinkSpring: 0.4,
      simulationLinkDistance: 12,
      simulationFriction: 0.85,
      simulationDecay: 4000,
      simulationRepulsionTheta: 1.2,
      pointSizeScale: 1,
      scalePointsOnZoom: true,
      hoveredPointCursor: 'pointer',
      renderHoveredPointRing: true,
      hoveredPointRingColor: 'white',

      onPointClick: (index) => {
        if (index === undefined || index === null) return;
        const now = Date.now();

        // Double-click detection (cosmos has no native dblclick)
        if (index === this._lastClickIndex && now - this._lastClickTime < 400) {
          this._lastClickTime = 0;
          this._lastClickIndex = -1;
          const node = this.nodes[index];
          if (node && this.onNodeDblClick) this.onNodeDblClick(node);
          return;
        }
        this._lastClickTime = now;
        this._lastClickIndex = index;

        const node = this.nodes[index];
        if (node) {
          this._select(node, index);
          if (this.onNodeClick) this.onNodeClick(node);
        }
      },

      onBackgroundClick: () => {
        this._deselect();
        if (this.onNodeClick) this.onNodeClick(null);
      },

      onPointMouseOver: (index) => {
        if (index === undefined || index === null) return;
        const node = this.nodes[index];
        if (!node) return;
        this._tooltip.textContent = node.label;
        this._tooltip.style.display = 'block';
        this._tooltip.style.left = (this._mouseX + 14) + 'px';
        this._tooltip.style.top  = (this._mouseY - 6) + 'px';
      },

      onPointMouseOut: () => {
        this._tooltip.style.display = 'none';
      },
    });
  }

  // ── Data ──────────────────────────────────────────────

  update(nodes, links) {
    this.nodes = nodes;
    this.links = links;

    this.nodeIndexMap.clear();
    for (let i = 0; i < nodes.length; i++) {
      this.nodeIndexMap.set(nodes[i].id, i);
    }

    // Positions — random initial spread
    const positions = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      positions[i * 2]     = (Math.random() - 0.5) * 4096;
      positions[i * 2 + 1] = (Math.random() - 0.5) * 4096;
    }

    // Colors — RGBA floats 0-1
    const colors = new Float32Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
      const c = this._rgbaCache[nodes[i].type] || [0.5, 0.5, 0.5, 1];
      colors[i * 4]     = c[0];
      colors[i * 4 + 1] = c[1];
      colors[i * 4 + 2] = c[2];
      colors[i * 4 + 3] = c[3];
    }

    // Sizes
    const sizes = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      sizes[i] = nodes[i].radius * 2;
    }

    // Links — index pairs
    const linkArr = [];
    const linkColors = [];
    for (const l of links) {
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      const si = this.nodeIndexMap.get(srcId);
      const ti = this.nodeIndexMap.get(tgtId);
      if (si !== undefined && ti !== undefined) {
        linkArr.push(si, ti);
        if (l._type === 'shared-contributor') {
          linkColors.push(0.25, 0.73, 0.31, 0.35);
        } else {
          linkColors.push(1, 1, 1, 0.12);
        }
      }
    }

    this.graph.setPointPositions(positions);
    this.graph.setPointColors(colors);
    this.graph.setPointSizes(sizes);
    this.graph.setLinks(new Float32Array(linkArr));
    if (linkColors.length) this.graph.setLinkColors(new Float32Array(linkColors));

    this._deselect();
    if (!this.paused) this.graph.start();
  }

  // ── Selection ─────────────────────────────────────────

  _select(node, index) {
    this.selectedNode = node;

    // Highlight this node + its neighbors
    const neighbors = this.graph.getNeighboringPointIndices(index) || [];
    const highlighted = [index, ...neighbors];

    this.graph.setConfigPartial({
      highlightedPointIndices: highlighted,
      pointGreyoutOpacity: 0.08,
      focusedPointIndex: index,
    });
  }

  _deselect() {
    this.selectedNode = null;
    this.graph.setConfigPartial({
      highlightedPointIndices: undefined,
      pointGreyoutOpacity: undefined,
      focusedPointIndex: undefined,
    });
  }

  // ── Camera ────────────────────────────────────────────

  fitView() {
    this.graph.setConfigPartial({
      fitViewByPointIndices: undefined,
      fitViewDuration: 500,
    });
  }

  zoomBy(factor) {
    // Cosmos handles zoom via scroll wheel; buttons are approximate
    this.graph.setConfigPartial({
      initialZoomLevel: (this.graph.getZoomLevel?.() || 1) * factor,
    });
  }

  togglePause() {
    this.paused = !this.paused;
    if (this.paused) {
      this.graph.pause();
    } else {
      this.graph.unpause();
    }
    return this.paused;
  }
}

function hexToFloats(hex) {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1,
  ];
}
