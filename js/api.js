class GitHubAPI {
  constructor() {
    this.graphqlUrl = 'https://api.github.com/graphql';
    this.restUrl    = 'https://api.github.com';
    this.token      = null;
    this.rateLimitRemaining = null;
  }

  setToken(token) {
    this.token = token ? token.trim() : null;
  }

  _trackRate(res) {
    const r = res.headers.get('X-RateLimit-Remaining');
    if (r !== null) this.rateLimitRemaining = parseInt(r, 10);
  }

  // ── GraphQL ───────────────────────────────────────────

  async _gql(query, variables = {}) {
    if (!this.token) {
      throw new Error('A GitHub token is required. Create one at Settings → Developer settings → Personal access tokens (no scopes needed for public data).');
    }

    const res = await fetch(this.graphqlUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    this._trackRate(res);

    if (res.status === 401) throw new Error('Invalid or expired GitHub token.');
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);

    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    return json.data;
  }

  // ── REST (contributors only — no GraphQL equivalent) ──

  async _rest(path) {
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const res = await fetch(this.restUrl + path, { headers });
    this._trackRate(res);

    if (res.status === 404) return [];
    if (res.status === 403) return [];
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return res.json();
  }

  // ── Profile + repos (single GraphQL call) ─────────────

  async fetchProfile(login) {
    const query = `
      query ($login: String!) {
        repositoryOwner(login: $login) {
          login
          avatarUrl
          url
          ... on User {
            __typename
            name
            bio
            location
            websiteUrl
            email
            followers  { totalCount }
            following  { totalCount }
          }
          ... on Organization {
            __typename
            name
            description
            location
            websiteUrl
            email
            membersWithRole { totalCount }
          }
          repositories(
            first: 100
            orderBy: { field: STARGAZERS, direction: DESC }
            privacy: PUBLIC
          ) {
            nodes {
              name
              nameWithOwner
              description
              stargazerCount
              forkCount
              isFork
              isPrivate
              url
              owner { login avatarUrl }
              licenseInfo { spdxId }
              primaryLanguage { name }
              languages(first: 20)        { nodes { name } }
              repositoryTopics(first: 30) { nodes { topic { name } } }
              issues(states: OPEN)        { totalCount }
            }
          }
        }
      }
    `;

    const data  = await this._gql(query, { login });
    const owner = data.repositoryOwner;
    if (!owner) throw new Error(`"${login}" not found.`);

    const isOrg = owner.__typename === 'Organization';

    const entity = {
      login:        owner.login,
      name:         owner.name || owner.login,
      type:         isOrg ? 'Organization' : 'User',
      bio:          owner.bio || owner.description || '',
      avatar_url:   owner.avatarUrl,
      html_url:     owner.url,
      location:     owner.location,
      blog:         owner.websiteUrl,
      email:        owner.email,
      public_repos: owner.repositories?.nodes?.length || 0,
      followers:    owner.followers?.totalCount ?? owner.membersWithRole?.totalCount ?? 0,
      following:    owner.following?.totalCount ?? null,
    };

    const repos = (owner.repositories?.nodes || []).map(r => ({
      name:               r.name,
      full_name:          r.nameWithOwner,
      description:        r.description,
      stargazers_count:   r.stargazerCount,
      forks_count:        r.forkCount,
      fork:               r.isFork,
      private:            r.isPrivate,
      html_url:           r.url,
      owner:              r.owner,
      license:            r.licenseInfo ? { spdx_id: r.licenseInfo.spdxId } : null,
      language:           r.primaryLanguage?.name || null,
      open_issues_count:  r.issues?.totalCount || 0,
      languages:          r.languages?.nodes?.map(l => l.name) || [],
      topics:             r.repositoryTopics?.nodes?.map(t => t.topic.name) || [],
    }));

    return { entity, repos };
  }

  // ── Contributors (REST — no GraphQL equivalent) ───────

  getContributors(owner, repo) {
    return this._rest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contributors?per_page=100&anon=false`
    );
  }
}
