class App {
  constructor() {
    this.api   = new GitHubAPI();
    this.graph = new GitGraph('graph');

    // Canonical data — node objects are reused across renders so D3 keeps positions
    this.nodeMap  = new Map();  // id → node object
    this.linkList = [];         // { _key, _src, _tgt }  (regular edges only)
    this.linkSet  = new Set();  // deduplicate regular edges

    this.loading = false;

    this.graph.onNodeClick = n => n ? this._showInfo(n) : this._hideInfo();

    // Double-click a user/org/contributor → expand their repos INTO the current graph
    // Double-click a repo → dive in and show its contributors, languages, and topics
    this.graph.onNodeDblClick = n => {
      if (n.type === 'repo') {
        this._expandRepo(n);
      } else {
        const login = n.data?.login;
        if (login && (n.type === 'user' || n.type === 'org' || n.type === 'contributor')) {
          this._expand(login);
        }
      }
    };

    this._bindUI();
    this._checkUrl();
  }

  // ── UI wiring ──────────────────────────────────────────

  _bindUI() {
    const inp = document.getElementById('search');
    document.getElementById('search-btn').addEventListener('click', () => this._search(inp.value.trim()));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') this._search(inp.value.trim()); });

    document.getElementById('token').addEventListener('change', e => this.api.setToken(e.target.value));

    ['show-contributors', 'show-languages', 'show-topics', 'hide-forks'].forEach(id =>
      document.getElementById(id).addEventListener('change', () => this._render())
    );

    document.getElementById('zoom-in') .addEventListener('click', () => this.graph.zoomBy(1.45));
    document.getElementById('zoom-out').addEventListener('click', () => this.graph.zoomBy(0.69));
    document.getElementById('fit-btn') .addEventListener('click', () => this.graph.fitView());
    document.getElementById('info-close').addEventListener('click', () => { this._hideInfo(); this.graph._deselect(); });

    document.querySelectorAll('.ex-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        document.getElementById('search').value = btn.dataset.user;
        this._search(btn.dataset.user);
      })
    );
  }

  _checkUrl() {
    const q = new URLSearchParams(location.search).get('user') || new URLSearchParams(location.search).get('q');
    if (q) { document.getElementById('search').value = q; this._search(q); }
  }

  // ── Fresh search (resets graph) ────────────────────────

  async _search(username) {
    if (!username || this.loading) return;
    this.loading = true;

    this.nodeMap.clear();
    this.linkList = [];
    this.linkSet.clear();
    this._hideInfo();
    document.getElementById('empty-state').style.display = 'none';
    this._setError('');
    this._setLoading(true, 'Fetching profile…');

    const url = new URL(location.href);
    url.searchParams.set('user', username);
    history.replaceState({}, '', url);

    try {
      const entity = await this.api.getEntity(username);
      const type   = entity.type === 'Organization' ? 'org' : 'user';
      const rootId = `${type}:${entity.login}`;

      this.nodeMap.set(rootId, {
        id: rootId, type, label: entity.name || entity.login,
        radius: 28, data: entity,
      });

      this._setLoading(true, 'Fetching repositories…');
      const repos = await this._fetchAndAddRepos(entity, rootId);

      this._render();
      await this._enrichRepos(repos, entity.login);
      this._render();

      setTimeout(() => this.graph.fitView(), 500);

    } catch (e) {
      this._setError(e.message);
      if (this.nodeMap.size === 0) document.getElementById('empty-state').style.display = 'flex';
    } finally {
      this.loading = false;
      this._setLoading(false);
      this._updateRateLimit();
    }
  }

  // ── Additive expand (keeps existing graph intact) ──────

  async _expand(username) {
    if (this.loading) return;
    this.loading = true;
    this._setLoading(true, `Expanding ${username}…`);
    this._setError('');

    try {
      const entity = await this.api.getEntity(username);

      // Find the anchor node in the graph (contributor:login or user:login)
      const anchorId =
        this.nodeMap.has(`contributor:${entity.login}`) ? `contributor:${entity.login}` :
        this.nodeMap.has(`user:${entity.login}`)        ? `user:${entity.login}`        :
        this.nodeMap.has(`org:${entity.login}`)         ? `org:${entity.login}`         : null;

      if (anchorId) {
        // Upgrade the node data with the full profile and mark it expanded
        const node = this.nodeMap.get(anchorId);
        node.data     = entity;
        node.expanded = true;
        // Slightly enlarge the anchor node so the expansion is visually obvious
        if (node.type === 'contributor') node.radius = 14;
      } else {
        // Node not yet in graph — add it fresh
        const type = entity.type === 'Organization' ? 'org' : 'user';
        const id   = `${type}:${entity.login}`;
        this.nodeMap.set(id, {
          id, type, label: entity.name || entity.login,
          radius: 24, data: entity, expanded: true,
        });
      }

      const effectiveAnchor = anchorId || (entity.type === 'Organization' ? `org:${entity.login}` : `user:${entity.login}`);

      this._setLoading(true, 'Fetching repositories…');
      const repos = await this._fetchAndAddRepos(entity, effectiveAnchor, 15);

      this._render();
      await this._enrichRepos(repos, entity.login, 8);
      this._render();

    } catch (e) {
      this._setError(e.message);
    } finally {
      this.loading = false;
      this._setLoading(false);
      this._updateRateLimit();
    }
  }

  // ── Expand a repo (dive in) ────────────────────────────

  async _expandRepo(node) {
    if (this.loading || node.expanded) return;
    this.loading = true;
    const repo = node.data;
    this._setLoading(true, `Diving into ${repo.name}…`);
    this._setError('');

    try {
      node.expanded = true;
      node.radius = Math.max(node.radius, 16);
      const repoId = node.id;
      const owner  = repo.owner.login;

      const [langs, contribs, topics] = await Promise.allSettled([
        this.api.getLanguages(owner, repo.name),
        this.api.getContributors(owner, repo.name),
        this.api.getTopics(owner, repo.name),
      ]);

      if (langs.status === 'fulfilled') {
        for (const lang of Object.keys(langs.value).slice(0, 5)) {
          const id = `lang:${lang}`;
          if (!this.nodeMap.has(id)) {
            this.nodeMap.set(id, { id, type: 'language', label: lang, radius: 7, data: { name: lang } });
          }
          this._addLink(repoId, id);
        }
      }

      if (contribs.status === 'fulfilled') {
        for (const c of contribs.value.slice(0, 6)) {
          if (c.type === 'Bot') continue;
          const id = `contributor:${c.login}`;
          if (!this.nodeMap.has(id)) {
            this.nodeMap.set(id, { id, type: 'contributor', label: c.login, radius: 9, data: c });
          }
          this._addLink(repoId, id);
        }
      }

      if (topics.status === 'fulfilled') {
        for (const topic of topics.value.slice(0, 5)) {
          const id = `topic:${topic}`;
          if (!this.nodeMap.has(id)) {
            this.nodeMap.set(id, { id, type: 'topic', label: topic, radius: 7, data: { name: topic } });
          }
          this._addLink(repoId, id);
        }
      }

      this._render();
    } catch (e) {
      this._setError(e.message);
    } finally {
      this.loading = false;
      this._setLoading(false);
      this._updateRateLimit();
    }
  }

  // ── Shared helpers ─────────────────────────────────────

  async _fetchAndAddRepos(entity, anchorId, limit = 25) {
    const allRepos  = await this.api.getRepos(entity.login, entity.type);
    const hideForks = document.getElementById('hide-forks').checked;
    const repos     = allRepos.filter(r => !r.private && (!hideForks || !r.fork)).slice(0, limit);

    for (const repo of repos) {
      const id = `repo:${repo.full_name}`;
      if (!this.nodeMap.has(id)) {
        const stars = repo.stargazers_count || 0;
        this.nodeMap.set(id, {
          id, type: 'repo', label: repo.name,
          radius: Math.max(8, Math.min(22, 8 + Math.log10(stars + 1) * 5)),
          data: repo,
        });
      }
      this._addLink(anchorId, id);
    }
    return repos;
  }

  async _enrichRepos(repos, skipLogin, limit = 12) {
    const wantContribs  = document.getElementById('show-contributors').checked;
    const wantLanguages = document.getElementById('show-languages').checked;
    const wantTopics    = document.getElementById('show-topics').checked;
    if (!wantContribs && !wantLanguages && !wantTopics) return;

    this._setLoading(true, 'Fetching details…');
    await Promise.allSettled(repos.slice(0, limit).map(async repo => {
      const repoId = `repo:${repo.full_name}`;
      const jobs   = [];
      if (wantLanguages) jobs.push(this._enrichLanguages(repo, repoId));
      if (wantContribs)  jobs.push(this._enrichContributors(repo, repoId, skipLogin));
      if (wantTopics)    jobs.push(this._enrichTopics(repo, repoId));
      await Promise.allSettled(jobs);
    }));
  }

  // ── Enrichment ─────────────────────────────────────────

  async _enrichLanguages(repo, repoId) {
    const langs = await this.api.getLanguages(repo.owner.login, repo.name);
    for (const lang of Object.keys(langs).slice(0, 3)) {
      const id = `lang:${lang}`;
      if (!this.nodeMap.has(id)) {
        this.nodeMap.set(id, { id, type: 'language', label: lang, radius: 7, data: { name: lang } });
      }
      this._addLink(repoId, id);
    }
  }

  async _enrichContributors(repo, repoId, skipLogin) {
    const list = await this.api.getContributors(repo.owner.login, repo.name);
    for (const c of list.slice(0, 4)) {
      if (c.login === skipLogin || c.type === 'Bot') continue;
      const id = `contributor:${c.login}`;
      if (!this.nodeMap.has(id)) {
        this.nodeMap.set(id, { id, type: 'contributor', label: c.login, radius: 9, data: c });
      }
      this._addLink(repoId, id);
    }
  }

  async _enrichTopics(repo, repoId) {
    const topics = await this.api.getTopics(repo.owner.login, repo.name);
    for (const topic of topics.slice(0, 4)) {
      const id = `topic:${topic}`;
      if (!this.nodeMap.has(id)) {
        this.nodeMap.set(id, { id, type: 'topic', label: topic, radius: 7, data: { name: topic } });
      }
      this._addLink(repoId, id);
    }
  }

  _addLink(src, tgt) {
    const key = `${src}→${tgt}`;
    if (!this.linkSet.has(key)) {
      this.linkSet.add(key);
      this.linkList.push({ _key: key, _src: src, _tgt: tgt });
    }
  }

  // ── Shared-contributor edge computation ────────────────

  _computeSharedContribLinks(nodeIds) {
    // Build map: contributorId → [repoId, ...]
    const contribRepos = new Map();
    for (const l of this.linkList) {
      if (!l._tgt.startsWith('contributor:')) continue;
      if (!nodeIds.has(l._src) || !nodeIds.has(l._tgt)) continue;
      if (!contribRepos.has(l._tgt)) contribRepos.set(l._tgt, []);
      contribRepos.get(l._tgt).push(l._src);
    }

    const result = [];
    const seen   = new Set();
    for (const repos of contribRepos.values()) {
      if (repos.length < 2) continue;
      for (let i = 0; i < repos.length; i++) {
        for (let j = i + 1; j < repos.length; j++) {
          // Canonical sort so A↔B and B↔A produce the same key
          const [a, b] = repos[i] < repos[j] ? [repos[i], repos[j]] : [repos[j], repos[i]];
          const key = `shared:${a}↔${b}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push({ source: a, target: b, _key: key, _type: 'shared-contributor' });
          }
        }
      }
    }
    return result;
  }

  // ── Render ─────────────────────────────────────────────

  _render() {
    const showC     = document.getElementById('show-contributors').checked;
    const showL     = document.getElementById('show-languages').checked;
    const showT     = document.getElementById('show-topics').checked;
    const hideForks = document.getElementById('hide-forks').checked;

    const visible = new Set(['user', 'org', 'repo']);
    if (showC) visible.add('contributor');
    if (showL) visible.add('language');
    if (showT) visible.add('topic');

    // Nodes linked to expanded repos should always be visible
    const expandedRepoIds = new Set();
    for (const n of this.nodeMap.values()) {
      if (n.type === 'repo' && n.expanded) expandedRepoIds.add(n.id);
    }
    const expandedChildren = new Set();
    for (const l of this.linkList) {
      if (expandedRepoIds.has(l._src)) expandedChildren.add(l._tgt);
      if (expandedRepoIds.has(l._tgt)) expandedChildren.add(l._src);
    }

    const nodes = Array.from(this.nodeMap.values()).filter(n => {
      if (hideForks && n.type === 'repo' && n.data?.fork) return false;
      if (visible.has(n.type)) return true;
      if (expandedChildren.has(n.id)) return true;
      return false;
    });
    const nodeIds = new Set(nodes.map(n => n.id));

    // Fresh link objects each render (D3 mutates them; we don't want accumulation)
    const links = this.linkList
      .filter(l => nodeIds.has(l._src) && nodeIds.has(l._tgt))
      .map(l => ({ source: l._src, target: l._tgt, _key: l._key }));

    // Shared-contributor repo↔repo edges (dashed, green)
    if (showC) links.push(...this._computeSharedContribLinks(nodeIds));

    this.graph.update(nodes, links);
  }

  // ── Info panel ─────────────────────────────────────────

  _showInfo(node) {
    const d = node.data;
    let html = '';

    if (node.type === 'user' || node.type === 'org') {
      const isOrg = node.type === 'org';
      html = `
        <div class="info-head">
          <img class="info-avatar" src="${d.avatar_url}&s=80" alt="">
          <div>
            <div class="info-name">${esc(d.name || d.login)}</div>
            <div class="info-login">@${esc(d.login)}</div>
            <span class="badge ${node.type}">${isOrg ? 'Organization' : 'User'}</span>
          </div>
        </div>
        ${d.bio ? `<div class="info-bio">${esc(d.bio)}</div>` : ''}
        <div class="info-stats">
          <div class="stat"><div class="stat-val">${fmt(d.public_repos)}</div><div class="stat-lbl">Repos</div></div>
          <div class="stat"><div class="stat-val">${fmt(d.followers)}</div><div class="stat-lbl">Followers</div></div>
          ${d.following != null ? `<div class="stat"><div class="stat-val">${fmt(d.following)}</div><div class="stat-lbl">Following</div></div>` : ''}
        </div>
        ${d.location ? `<div class="info-meta">📍 ${esc(d.location)}</div>` : ''}
        ${d.blog     ? `<div class="info-meta">🔗 <a href="${href(d.blog)}" target="_blank" rel="noopener">${esc(d.blog)}</a></div>` : ''}
        ${d.email    ? `<div class="info-meta">✉ ${esc(d.email)}</div>` : ''}
        <a class="info-link" href="${d.html_url}" target="_blank" rel="noopener">View on GitHub →</a>
      `;
    } else if (node.type === 'repo') {
      html = `
        <div class="info-head">
          <div class="info-icon">📦</div>
          <div>
            <div class="info-name">${esc(d.name)}</div>
            <div class="info-login">${esc(d.full_name)}</div>
            <span class="badge repo">Repository</span>
            ${d.fork ? ` <span class="badge" style="background:rgba(255,166,87,.14);color:var(--topic)">Fork</span>` : ''}
          </div>
        </div>
        ${d.description ? `<div class="info-bio">${esc(d.description)}</div>` : ''}
        <div class="info-stats">
          <div class="stat"><div class="stat-val">⭐ ${fmt(d.stargazers_count)}</div><div class="stat-lbl">Stars</div></div>
          <div class="stat"><div class="stat-val">🍴 ${fmt(d.forks_count)}</div><div class="stat-lbl">Forks</div></div>
          ${d.open_issues_count ? `<div class="stat"><div class="stat-val">${fmt(d.open_issues_count)}</div><div class="stat-lbl">Issues</div></div>` : ''}
        </div>
        ${d.language   ? `<div class="info-meta"><span class="lang-pip" style="background:var(--language)"></span>${esc(d.language)}</div>` : ''}
        ${d.license?.spdx_id ? `<div class="info-meta">📄 ${esc(d.license.spdx_id)}</div>` : ''}
        ${d.topics?.length ? `<div class="info-topics">${d.topics.slice(0,6).map(t => `<span class="topic-chip">${esc(t)}</span>`).join('')}</div>` : ''}
        <a class="info-link" href="${d.html_url}" target="_blank" rel="noopener">View on GitHub →</a>
        ${node.expanded ? `<div class="action-hint">expanded</div>` : `<div class="action-hint">double-click to dive in</div>`}
      `;
    } else if (node.type === 'contributor') {
      html = `
        <div class="info-head">
          <img class="info-avatar" src="${d.avatar_url}&s=80" alt="">
          <div>
            <div class="info-name">${esc(d.login)}</div>
            <span class="badge contributor">Contributor</span>
            ${node.expanded ? `<span class="expanded-badge">expanded</span>` : ''}
          </div>
        </div>
        <div class="info-stats">
          <div class="stat"><div class="stat-val">${fmt(d.contributions)}</div><div class="stat-lbl">Commits</div></div>
        </div>
        <a class="info-link" href="https://github.com/${encodeURIComponent(d.login)}" target="_blank" rel="noopener">View on GitHub →</a>
        <div class="action-row">
          <button class="action-btn expand" data-login="${esc(d.login)}">➕ Expand into graph</button>
          <button class="action-btn search"  data-login="${esc(d.login)}">🔍 New search</button>
        </div>
        <div class="action-hint">or double-click the node to expand</div>
      `;
    } else if (node.type === 'language') {
      html = `
        <div class="info-head">
          <div class="info-icon" style="font-size:28px">💻</div>
          <div>
            <div class="info-name">${esc(d.name)}</div>
            <span class="badge language">Language</span>
          </div>
        </div>
      `;
    } else if (node.type === 'topic') {
      html = `
        <div class="info-head">
          <div class="info-icon" style="font-size:28px">#</div>
          <div>
            <div class="info-name">${esc(d.name)}</div>
            <span class="badge topic">Topic</span>
          </div>
        </div>
        <a class="info-link" href="https://github.com/topics/${encodeURIComponent(d.name)}" target="_blank" rel="noopener">Browse topic on GitHub →</a>
      `;
    }

    document.getElementById('info-content').innerHTML = html;
    document.getElementById('info-panel').classList.add('visible');

    // Wire action buttons — done here to avoid inline onclick (XSS-safe)
    document.querySelector('.action-btn.expand')?.addEventListener('click', e =>
      this._expand(e.currentTarget.dataset.login)
    );
    document.querySelector('.action-btn.search')?.addEventListener('click', e =>
      this._search(e.currentTarget.dataset.login)
    );
  }

  _hideInfo() {
    document.getElementById('info-panel').classList.remove('visible');
  }

  // ── UI helpers ─────────────────────────────────────────

  _setLoading(on, text = '') {
    const el = document.getElementById('loading');
    el.style.display = on ? 'flex' : 'none';
    if (text) document.getElementById('loading-text').textContent = text;
  }

  _setError(msg) {
    const el = document.getElementById('error-banner');
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
    if (msg) setTimeout(() => { el.style.display = 'none'; }, 9000);
  }

  _updateRateLimit() {
    const n   = this.api.rateLimitRemaining;
    const col = n < 10 ? '#f85149' : n < 25 ? '#ffa657' : '#484f58';
    document.getElementById('rate-display').innerHTML = `<span style="color:${col}">${n}</span>/60 API`;
  }
}

// ── Utilities ──────────────────────────────────────────

function fmt(n) { return (n ?? 0).toLocaleString(); }

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function href(url) {
  return String(url).startsWith('http') ? url : 'https://' + url;
}

// ── Boot ───────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
