class GitHubAPI {
  constructor() {
    this.base = 'https://api.github.com';
    this.token = null;
    this.rateLimitRemaining = 60;
    this.rateLimitReset = null;
  }

  setToken(token) {
    this.token = token ? token.trim() : null;
  }

  _headers(extraAccept) {
    const h = { 'Accept': extraAccept || 'application/vnd.github.v3+json' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async _fetch(path, extraAccept) {
    const res = await fetch(this.base + path, { headers: this._headers(extraAccept) });

    const remaining = res.headers.get('X-RateLimit-Remaining');
    if (remaining !== null) this.rateLimitRemaining = parseInt(remaining, 10);
    const reset = res.headers.get('X-RateLimit-Reset');
    if (reset) this.rateLimitReset = new Date(parseInt(reset, 10) * 1000);

    if (res.status === 404) throw new Error(`Not found: ${path}`);
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      const msg = body.message || '';
      if (msg.includes('rate limit')) {
        const resetAt = this.rateLimitReset ? ` Resets at ${this.rateLimitReset.toLocaleTimeString()}.` : '';
        throw new Error(`Rate limit exceeded.${resetAt} Add a GitHub token to get 5000 req/hr.`);
      }
      throw new Error(`GitHub API 403: ${msg}`);
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
    return res.json();
  }

  async getEntity(name) {
    // Try user first, fall back to org
    try {
      return await this._fetch(`/users/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e.message.startsWith('Not found')) {
        return await this._fetch(`/orgs/${encodeURIComponent(name)}`);
      }
      throw e;
    }
  }

  getRepos(login, type, page = 1) {
    const base = type === 'Organization' ? `/orgs/${login}` : `/users/${login}`;
    return this._fetch(`${base}/repos?per_page=30&sort=stars&direction=desc&page=${page}`);
  }

  getContributors(owner, repo) {
    return this._fetch(`/repos/${owner}/${repo}/contributors?per_page=8&anon=false`);
  }

  getLanguages(owner, repo) {
    return this._fetch(`/repos/${owner}/${repo}/languages`);
  }

  async getTopics(owner, repo) {
    try {
      const data = await this._fetch(
        `/repos/${owner}/${repo}/topics`,
        'application/vnd.github.mercy-preview+json'
      );
      return data.names || [];
    } catch {
      return [];
    }
  }
}
