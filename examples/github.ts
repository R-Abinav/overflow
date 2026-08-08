// Minimal GitHub REST API client via raw fetch — consistent with the rest of
// this codebase's style (no SDK client anywhere else either, e.g. axl.ts uses
// fetch directly for its own local API). GITHUB_TOKEN / GITHUB_REPO are read
// from .env at call time, never hardcoded or logged.

const GITHUB_API = 'https://api.github.com';

function ghHeaders() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('[github] GITHUB_TOKEN is not set in .env');
    return {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
    };
}

function repoSlug(): string {
    const repo = process.env.GITHUB_REPO;
    if (!repo) throw new Error('[github] GITHUB_REPO is not set in .env');
    return repo;
}

async function ghFetch(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${GITHUB_API}${path}`, { ...init, headers: ghHeaders() });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[github] ${init?.method || 'GET'} ${path} failed: ${res.status} ${res.statusText} — ${body}`);
    }
    return res.json();
}

export async function getBranchSha(branch: string): Promise<string> {
    const data = await ghFetch(`/repos/${repoSlug()}/git/ref/heads/${branch}`);
    return data.object.sha;
}

export async function createBranch(branchName: string, fromSha: string): Promise<void> {
    await ghFetch(`/repos/${repoSlug()}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
    });
}

export async function getFileContent(path: string, ref: string): Promise<{ content: string; sha: string }> {
    const data = await ghFetch(`/repos/${repoSlug()}/contents/${path}?ref=${ref}`);
    return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha };
}

export async function updateFile(path: string, newContent: string, sha: string, branch: string, message: string): Promise<void> {
    await ghFetch(`/repos/${repoSlug()}/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify({
            message,
            content: Buffer.from(newContent, 'utf-8').toString('base64'),
            sha,
            branch,
        }),
    });
}

export async function createPullRequest(title: string, body: string, head: string, base: string): Promise<{ url: string; number: number }> {
    const data = await ghFetch(`/repos/${repoSlug()}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title, body, head, base }),
    });
    return { url: data.html_url, number: data.number };
}
