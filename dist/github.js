const DEFAULT_API_URL = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_FILE_BYTES = 100 * 1024;
/** REST client restricted to the configured repository and GitHub API origin. */
export class GitHub {
    token;
    repository;
    fetchImpl;
    apiUrl;
    #trees = new Map();
    constructor({ token, repository, fetchImpl = fetch, apiUrl = DEFAULT_API_URL }) {
        if (!token || typeof token !== 'string')
            throw new TypeError('GitHub token is required');
        if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
            throw new TypeError('repository must be an "owner/repository" string');
        }
        if (typeof fetchImpl !== 'function')
            throw new TypeError('fetchImpl must be a function');
        if (!/^https?:\/\//.test(apiUrl))
            throw new TypeError('apiUrl must be an HTTP(S) URL');
        this.token = token;
        this.repository = repository;
        this.fetchImpl = fetchImpl;
        this.apiUrl = apiUrl.replace(/\/+$/, '');
    }
    async request(method, path, body) {
        return (await this.#request(method, path, body)).data;
    }
    async getPull(number) {
        return parsePullRequest(await this.request('GET', `/repos/${this.repository}/pulls/${positiveInteger(number, 'pull number')}`));
    }
    async actorLogin(fallback = 'github-actions[bot]') {
        try {
            return parseGitHubUser(await this.request('GET', '/user')).login;
        }
        catch (error) {
            if (error instanceof GitHubHttpError && [401, 403].includes(error.status))
                return fallback;
            throw error;
        }
    }
    // A permission-service failure must remain visible, not masquerade as an authorization denial.
    async canWrite(login) {
        const value = await this.request('GET', `/repos/${this.repository}/collaborators/${encodeURIComponent(login)}/permission`);
        if (!value || typeof value !== 'object' || !('permission' in value) || typeof value.permission !== 'string') {
            throw new Error('GitHub returned invalid collaborator permissions');
        }
        return ['admin', 'maintain', 'write'].includes(value.permission);
    }
    listPullFiles(number) {
        return this.#paginate(`/repos/${this.repository}/pulls/${positiveInteger(number, 'pull number')}/files?per_page=100`, parsePullFile);
    }
    getTree(sha) {
        const existing = this.#trees.get(sha);
        if (existing)
            return existing;
        const pending = this.request('GET', `/repos/${this.repository}/git/trees/${encodeURIComponent(requiredString(sha, 'sha'))}?recursive=1`).then(parseGitTree);
        this.#trees.set(sha, pending);
        return pending;
    }
    async listFiles(sha) {
        const data = await this.getTree(sha);
        if (data.truncated)
            throw new Error(`GitHub tree for ${sha} is truncated; refusing incomplete repository context`);
        return data.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
    }
    async readFile(path, sha) {
        const safePath = encodePath(path);
        // The Contents API dereferences symlinks and may report the excluded target as type=file.
        const tree = await this.getTree(sha);
        const entry = tree.tree.find(file => file.path === path);
        if (tree.truncated || !entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
            throw new Error(`Refusing to read ${path}: not a verified regular file in the immutable Git tree`);
        }
        const data = await this.request('GET', `/repos/${this.repository}/contents/${safePath}?ref=${encodeURIComponent(requiredString(sha, 'sha'))}`);
        if (!data || typeof data !== 'object' || Array.isArray(data) || !('type' in data) || data.type !== 'file') {
            throw new Error(`Refusing to read ${path}: contents response is not a regular file`);
        }
        if (!('size' in data) || typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0)
            throw new Error(`Refusing to read ${path}: invalid file size`);
        if (data.size > MAX_FILE_BYTES)
            throw new Error(`Refusing to read ${path}: file exceeds ${MAX_FILE_BYTES} byte limit`);
        if (!('encoding' in data) || data.encoding !== 'base64' || !('content' in data) || typeof data.content !== 'string') {
            throw new Error(`Refusing to read ${path}: GitHub did not return base64 file content`);
        }
        const bytes = decodeBase64(data.content, path);
        if (bytes.byteLength > MAX_FILE_BYTES || bytes.byteLength !== data.size) {
            throw new Error(`Refusing to read ${path}: file size does not match GitHub content`);
        }
        if (bytes.includes(0))
            throw new Error(`Refusing to read ${path}: binary content is not supported`);
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        catch {
            throw new Error(`Refusing to read ${path}: content is not valid UTF-8`);
        }
    }
    listComments(number) {
        return this.#paginate(`/repos/${this.repository}/issues/${positiveInteger(number, 'pull number')}/comments?per_page=100`, parseGitHubComment);
    }
    listReviewComments(number) {
        return this.#paginate(`/repos/${this.repository}/pulls/${positiveInteger(number, 'pull number')}/comments?per_page=100`, parseGitHubComment);
    }
    async createComment(number, body) {
        return parseGitHubComment(await this.request('POST', `/repos/${this.repository}/issues/${positiveInteger(number, 'pull number')}/comments`, { body: requiredString(body, 'comment body') }));
    }
    async updateComment(id, body) {
        return parseGitHubComment(await this.request('PATCH', `/repos/${this.repository}/issues/comments/${positiveInteger(id, 'comment id')}`, { body: requiredString(body, 'comment body') }));
    }
    createReview(number, { commit_id, body, event, comments }) {
        return this.request('POST', `/repos/${this.repository}/pulls/${positiveInteger(number, 'pull number')}/reviews`, {
            commit_id: requiredString(commit_id, 'commit_id'), body: requiredString(body, 'review body'),
            event: requiredString(event, 'review event'), comments: Array.isArray(comments) ? comments : [],
        });
    }
    async getRef(branch) {
        try {
            return parseRef(await this.request('GET', `/repos/${this.repository}/git/ref/heads/${encodeRef(branch)}`));
        }
        catch (error) {
            if (error instanceof GitHubHttpError && error.status === 404)
                return null;
            throw error;
        }
    }
    createRef(branch, sha) {
        return this.request('POST', `/repos/${this.repository}/git/refs`, { ref: `refs/heads/${validateRef(branch)}`, sha: requiredString(sha, 'sha') });
    }
    updateRef(branch, sha) {
        return this.request('PATCH', `/repos/${this.repository}/git/refs/heads/${encodeRef(branch)}`, { sha: requiredString(sha, 'sha'), force: false });
    }
    async createTree(baseTree, entries) {
        for (const entry of entries)
            validatePath(entry.path);
        return parseSha(await this.request('POST', `/repos/${this.repository}/git/trees`, { base_tree: requiredString(baseTree, 'baseTree'), tree: entries }));
    }
    async getCommit(sha) {
        return parseCommit(await this.request('GET', `/repos/${this.repository}/git/commits/${encodeURIComponent(requiredString(sha, 'sha'))}`));
    }
    async createCommit(message, tree, parents) {
        if (!Array.isArray(parents) || !parents.length || parents.some((parent) => typeof parent !== 'string' || !parent)) {
            throw new TypeError('parents must be a non-empty SHA array');
        }
        return parseCommit(await this.request('POST', `/repos/${this.repository}/git/commits`, { message: requiredString(message, 'commit message'), tree: requiredString(tree, 'tree'), parents }));
    }
    listPulls(head) {
        return this.#paginate(`/repos/${this.repository}/pulls?state=all&head=${encodeURIComponent(requiredString(head, 'head'))}&per_page=100`, parsePullRequest);
    }
    async createPull(data) {
        if (!data || typeof data !== 'object')
            throw new TypeError('pull request data must be an object');
        return parsePullRequest(await this.request('POST', `/repos/${this.repository}/pulls`, data));
    }
    async updatePull(number, data) {
        if (!data || typeof data !== 'object')
            throw new TypeError('pull request data must be an object');
        return parsePullRequest(await this.request('PATCH', `/repos/${this.repository}/pulls/${positiveInteger(number, 'pull number')}`, data));
    }
    async #paginate(initialPath, parse) {
        const results = [];
        let path = initialPath;
        while (path) {
            const response = await this.#request('GET', path);
            if (!Array.isArray(response.data))
                throw new Error(`GitHub returned a non-array paginated response for ${path}`);
            for (const item of response.data)
                results.push(parse(item));
            path = nextLink(response.headers.get('link'), this.apiUrl);
        }
        return results;
    }
    async #request(method, path, body) {
        if (!/^[A-Z]+$/.test(method))
            throw new TypeError('method must be an uppercase HTTP method');
        if (!path.startsWith('/') || path.startsWith('//'))
            throw new TypeError('path must be an API-relative path');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let response;
        let text;
        try {
            response = await this.fetchImpl(`${this.apiUrl}${path}`, {
                method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
                    'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
            });
            text = await responseText(response, method, path);
        }
        catch (error) {
            if (controller.signal.aborted)
                throw new Error(`GitHub request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
            if (error instanceof Error && error.message.startsWith('GitHub'))
                throw error;
            throw new Error(`GitHub request failed: ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            clearTimeout(timeout);
        }
        if (!response.ok) {
            let detail = text.slice(0, 500);
            try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string') {
                    detail = parsed.message;
                }
            }
            catch { /* retain bounded text */ }
            throw new GitHubHttpError(response.status, method, path, detail);
        }
        return { data: parseJson(text, method, path), headers: response.headers };
    }
}
export class GitHubHttpError extends Error {
    status;
    constructor(status, method, path, detail) {
        super(`GitHub API ${status} for ${method} ${path}${detail ? `: ${detail}` : ''}`);
        this.name = 'GitHubHttpError';
        this.status = status;
    }
}
export function parsePullRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !('number' in value) || typeof value.number !== 'number' || !Number.isSafeInteger(value.number) ||
        !('state' in value) || typeof value.state !== 'string' ||
        !('draft' in value) || typeof value.draft !== 'boolean' ||
        !('title' in value) || typeof value.title !== 'string' ||
        !('body' in value) || (typeof value.body !== 'string' && value.body !== null) ||
        !('html_url' in value) || typeof value.html_url !== 'string' ||
        !('user' in value) || !('head' in value) || !('base' in value) ||
        !value.head || typeof value.head !== 'object' || Array.isArray(value.head) ||
        !('sha' in value.head) || typeof value.head.sha !== 'string' ||
        !('ref' in value.head) || typeof value.head.ref !== 'string' ||
        !('repo' in value.head) ||
        !value.base || typeof value.base !== 'object' || Array.isArray(value.base) ||
        !('repo' in value.base) || !('ref' in value.base) || typeof value.base.ref !== 'string' ||
        !('sha' in value.base) || typeof value.base.sha !== 'string')
        throw new Error('GitHub returned an invalid pull request');
    return {
        number: value.number, state: value.state, draft: value.draft, title: value.title, body: value.body, html_url: value.html_url,
        user: parseGitHubUser(value.user),
        head: { sha: value.head.sha, ref: value.head.ref, repo: value.head.repo === null ? null : parseGitHubRepository(value.head.repo) },
        base: { sha: value.base.sha, ref: value.base.ref, repo: parseGitHubRepository(value.base.repo) },
    };
}
function parseGitHubUser(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('login' in value) || typeof value.login !== 'string' || !('type' in value) || typeof value.type !== 'string') {
        throw new Error('GitHub returned an invalid user');
    }
    return { login: value.login, type: value.type };
}
function parseGitHubRepository(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('full_name' in value) || typeof value.full_name !== 'string' ||
        !('owner' in value) || !value.owner || typeof value.owner !== 'object' || !('login' in value.owner) || typeof value.owner.login !== 'string') {
        throw new Error('GitHub returned an invalid repository');
    }
    return { full_name: value.full_name, owner: { login: value.owner.login } };
}
function parsePullFile(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('filename' in value) || typeof value.filename !== 'string' || !('status' in value) || typeof value.status !== 'string') {
        throw new Error('GitHub returned an invalid pull file');
    }
    const file = { path: value.filename, status: value.status };
    if ('patch' in value && typeof value.patch === 'string')
        file.patch = value.patch;
    return file;
}
function parseGitHubComment(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('id' in value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) {
        throw new Error('GitHub returned an invalid comment');
    }
    const comment = { id: value.id };
    if ('body' in value && typeof value.body === 'string')
        comment.body = value.body;
    if ('user' in value && value.user !== null)
        comment.user = parseGitHubUser(value.user);
    return comment;
}
function parseGitTree(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('tree' in value) || !Array.isArray(value.tree)) {
        throw new Error('GitHub returned an invalid tree');
    }
    const tree = [];
    const rawEntries = value.tree;
    for (const valueEntry of rawEntries) {
        if (!valueEntry || typeof valueEntry !== 'object' || Array.isArray(valueEntry) ||
            !('path' in valueEntry) || typeof valueEntry.path !== 'string' ||
            !('mode' in valueEntry) || typeof valueEntry.mode !== 'string' ||
            !('type' in valueEntry) || typeof valueEntry.type !== 'string' ||
            !('sha' in valueEntry) || (typeof valueEntry.sha !== 'string' && valueEntry.sha !== null)) {
            throw new Error('GitHub returned an invalid tree entry');
        }
        const entry = {
            path: valueEntry.path,
            mode: valueEntry.mode,
            type: valueEntry.type,
            sha: valueEntry.sha,
        };
        if ('content' in valueEntry && typeof valueEntry.content === 'string')
            entry.content = valueEntry.content;
        tree.push(entry);
    }
    const result = { tree };
    if ('truncated' in value && typeof value.truncated === 'boolean')
        result.truncated = value.truncated;
    if ('sha' in value && typeof value.sha === 'string')
        result.sha = value.sha;
    if ('url' in value && typeof value.url === 'string')
        result.url = value.url;
    return result;
}
function parseSha(value) {
    if (!value || typeof value !== 'object' || !('sha' in value) || typeof value.sha !== 'string') {
        throw new Error('GitHub returned an invalid SHA');
    }
    return { sha: value.sha };
}
function parseCommit(value) {
    const { sha } = parseSha(value);
    if (!value || typeof value !== 'object' || !('tree' in value))
        throw new Error('GitHub returned an invalid commit');
    return { sha, tree: parseSha(value.tree) };
}
function parseRef(value) {
    if (!value || typeof value !== 'object' || !('ref' in value) || typeof value.ref !== 'string' || !('object' in value)) {
        throw new Error('GitHub returned an invalid ref');
    }
    return { ref: value.ref, object: parseSha(value.object) };
}
function positiveInteger(value, name) { if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive integer`); return value; }
function requiredString(value, name) { if (typeof value !== 'string' || !value)
    throw new TypeError(`${name} must be a non-empty string`); return value; }
function validatePath(path) {
    if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0'))
        throw new TypeError('path must be a non-empty slash-separated path');
    if (path.split('/').some((part) => !part || part === '.' || part === '..'))
        throw new TypeError('path must not contain empty, dot, or dot-dot segments');
    return path;
}
function encodePath(path) { return validatePath(path).split('/').map(encodeURIComponent).join('/'); }
function validateRef(branch) {
    if (typeof branch !== 'string' || !branch || branch.startsWith('/') || branch.endsWith('/') || branch.includes('..') || /[~^:?*\\[\s]/.test(branch))
        throw new TypeError('branch must be a valid git branch name');
    return branch;
}
function encodeRef(branch) { return validateRef(branch).split('/').map(encodeURIComponent).join('/'); }
function decodeBase64(content, path) {
    const encoded = content.replace(/\s/g, '');
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
        throw new Error(`Refusing to read ${path}: invalid base64 content`);
    return Buffer.from(encoded, 'base64');
}
async function responseText(response, method, path) {
    if (!response || typeof response.ok !== 'boolean')
        throw new Error(`GitHub returned an invalid response for ${method} ${path}`);
    if (!response.body)
        return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error(`GitHub response exceeds ${MAX_RESPONSE_BYTES} byte limit: ${method} ${path}`);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
function parseJson(text, method, path) {
    if (!text)
        return null;
    try {
        const value = JSON.parse(text);
        return value;
    }
    catch {
        throw new Error(`GitHub returned invalid JSON for ${method} ${path}`);
    }
}
function nextLink(header, apiUrl) {
    if (!header)
        return null;
    const match = header.match(/<([^>]+)>;\s*rel="next"/);
    if (!match)
        return null;
    const url = new URL(match[1], apiUrl);
    if (url.origin !== new URL(apiUrl).origin)
        throw new Error('GitHub returned an unsafe pagination link');
    return `${url.pathname}${url.search}`;
}
