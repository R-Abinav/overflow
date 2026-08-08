import * as fs from 'fs';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import { runDelegationFlow } from '../src/core/agent';
import { askLLM, ChatMessage } from '../src/core/llm';
import { getBranchSha, createBranch, getFileContent, updateFile, createPullRequest } from './github';

// Standalone RCA reference client. Deliberately does NOT reimplement any
// constraint-check / code-generation / delegation logic — it constructs an
// objective + inputData describing the RCA task and hands it to the exact
// same runDelegationFlow() the requester CLI (src/core/agent.ts) uses. This
// is a client of the generic delegation pipeline, not a special case inside it.

const LOG_PATH = path.join(__dirname, 'rca-demo', 'auth-service.log');
const PATCH_PATH = path.join(__dirname, 'rca-demo', 'patch.diff');
const TARGET_FILE = 'connection_pool.py';
const BASE_BRANCH = 'main';

const RCA_OBJECTIVE = `You are a site reliability engineer performing root cause analysis on a production incident. Below (in the input data) is a real auth-service log covering the minutes leading up to a crash.

Analyze the log and write a Python script that:
1. Parses the log lines (they are plain text, one event per line, format: "<ISO timestamp> <LEVEL> [component] [subcomponent] message").
2. Extracts real evidence: count of failed login attempts per targeted username, the distinct source IPs involved, the connection pool utilization trend over time, the timestamp where the pool first shows status=EXHAUSTED, and the final FATAL error.
3. Prints a concise root cause analysis to stdout, in this structure:
   - TRIGGER: what started the incident (cite actual counts/usernames/IPs from the log, not generic language)
   - CASCADE: how the trigger led to the resource exhaustion and the crash (cite actual timestamps and error messages)
   - ROOT CAUSE: one sentence, specific to this incident
Do not fabricate evidence that is not in the log. Use only the Python standard library.
When extracting a field like a timestamp from a matching line, parse it robustly: do not assume a fixed number of spaces or exact field ordering across the whole line in a single rigid regex. Prefer checking for a stable substring/key and then deriving the value separately (e.g. the line's leading token) over one regex that must match the entire line's layout at once.
Every count or specific number cited anywhere in the printed analysis (TRIGGER, CASCADE, ROOT CAUSE, or any other summary line) must be produced by printing the actual computed variable (e.g. an f-string referencing the real dict/counter/list you built while parsing) — never hand-written as a literal number in the summary text. If you are not counting something with code, do not state a count for it.
The input data may be large. Read it via sys.stdin.read() rather than copying or embedding it as a literal string in your script.`;

// Second, separate LLM call — not part of the sandbox/generic-delegation
// pipeline (a patch isn't something that gets *executed* in the sandbox), so
// this reuses askLLM() directly rather than generateCandidateCode(), which is
// specifically for stdlib-only Python sandbox code.
//
// This produces a *blind* diff (no real file in context) — kept exactly as
// verified in Phase 4.3 (5/5 correctly targets connection_pool.py). It is
// NOT what gets committed to the real PR below, since an LLM writing diff
// hunk syntax against a file it has never seen is unreliable at exact line
// numbers. It's demo-narration output only at this point.
const PATCH_SYSTEM_PROMPT = `You are a senior software engineer proposing a minimal, concrete fix for a production incident, given a root cause analysis someone else already performed. Output ONLY a single unified diff (standard format: "--- a/<path>", "+++ b/<path>", "@@ ... @@" hunk headers, context lines, +/- changed lines) that directly addresses the SPECIFIC root cause described — not a generic best-practices patch. The fix must be minimal: the smallest concrete change that addresses the trigger and/or the resource exhaustion described, not a rewrite.
The fix must target the file connection_pool.py exactly — use "--- a/connection_pool.py" and "+++ b/connection_pool.py" as the diff paths, no other file. This is the actual connection pool implementation for the service; queue/connection-pool exhaustion is the root cause of this incident, so the fix belongs there specifically (contributing signals like login attempt volume are not the primary cause and should not redirect the fix elsewhere). Write the patch in Python. Respond with ONLY a diff code block, no prose before or after.`;

// Grounded fix — given the REAL current file content, output the complete
// corrected file (not a diff). This is what actually gets committed; the
// real diff for the PR is computed mechanically below via createTwoFilesPatch
// against the true before/after content, not hand-written by the model.
const FIX_FILE_SYSTEM_PROMPT = `You are a senior software engineer. You will be given the current content of a Python file and a root cause analysis describing a production incident caused by a bug in that file. Output ONLY the complete, corrected version of the ENTIRE file — the full file content with a minimal, concrete fix applied, not a diff, not an explanation, not markdown formatting outside the code block. Keep everything else in the file unchanged. Respond with ONLY a single python code block containing the entire corrected file.`;

function extractDiff(rawResponse: string): string {
    const diffMatch = rawResponse.match(/```(?:diff)?\n([\s\S]*?)```/);
    return diffMatch ? diffMatch[1].trim() : rawResponse.trim();
}

function extractPythonFile(rawResponse: string): string {
    const match = rawResponse.match(/```(?:python)?\n([\s\S]*?)```/);
    const code = match?.[1] ?? rawResponse;
    return code.endsWith('\n') ? code : code + '\n';
}

async function generatePatch(diagnosis: string): Promise<string> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: `Root Cause Analysis:\n${diagnosis}\n\nPropose a minimal, concrete patch (as a unified diff) that addresses the root cause above.`
        }
    ];
    const rawResponse = await askLLM(PATCH_SYSTEM_PROMPT, messages);
    return extractDiff(rawResponse);
}

async function generateFixedFile(diagnosis: string, currentContent: string): Promise<string> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: `Current content of ${TARGET_FILE}:\n\`\`\`python\n${currentContent}\`\`\`\n\nRoot Cause Analysis:\n${diagnosis}\n\nOutput the complete corrected file with a minimal, concrete fix for the root cause above.`
        }
    ];
    const rawResponse = await askLLM(FIX_FILE_SYSTEM_PROMPT, messages);
    return extractPythonFile(rawResponse);
}

// Halts the pipeline loudly the moment a step's output can't be trusted,
// instead of letting a failed/malformed step cascade into a real branch/PR.
// The bug this exists for: /delegate's own timeout resolves normally with
// { "error": "Task timeout" } rather than rejecting — runDelegationFlow()
// falls back to JSON.stringify(data) for that shape, so a failed diagnosis
// looks like an ordinary (if odd) string to any caller that doesn't check.
class PipelineValidationError extends Error {
    constructor(step: string, reason: string) {
        super(`PIPELINE HALTED at step "${step}": ${reason}`);
        this.name = 'PipelineValidationError';
    }
}

function looksLikeErrorResponse(text: string): boolean {
    const trimmed = text.trim();
    if (/^\{\s*"error"\s*:/.test(trimmed)) return true;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && 'error' in parsed) return true;
    } catch {
        // Not JSON — fine, not this failure mode.
    }
    return false;
}

function validateDiagnosis(diagnosis: string): void {
    if (!diagnosis || diagnosis.trim().length === 0) {
        throw new PipelineValidationError('diagnosis', 'empty output from the delegation pipeline');
    }
    if (looksLikeErrorResponse(diagnosis)) {
        throw new PipelineValidationError('diagnosis', `delegation pipeline returned an error instead of a diagnosis: ${diagnosis.slice(0, 200)}`);
    }
    const requiredMarkers = ['TRIGGER:', 'CASCADE:', 'ROOT CAUSE:'];
    const missing = requiredMarkers.filter(m => !diagnosis.includes(m));
    if (missing.length > 0) {
        throw new PipelineValidationError('diagnosis', `missing required section(s) [${missing.join(', ')}] — does not match the RCA_OBJECTIVE's required structure, likely malformed or an error passthrough: ${diagnosis.slice(0, 300)}`);
    }
    // The objective requires the exhaustion timestamp to be cited verbatim —
    // a real diagnosis always contains a real ISO timestamp somewhere.
    if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(diagnosis)) {
        throw new PipelineValidationError('diagnosis', `no ISO-8601 timestamp found anywhere in the diagnosis — expected a real timestamp cited from the log: ${diagnosis.slice(0, 300)}`);
    }
}

function validateFixedFile(fixedContent: string, currentContent: string): void {
    if (!fixedContent || fixedContent.trim().length === 0) {
        throw new PipelineValidationError('grounded-fix', 'empty fixed file content returned');
    }
    if (looksLikeErrorResponse(fixedContent)) {
        throw new PipelineValidationError('grounded-fix', `LLM call returned an error instead of file content: ${fixedContent.slice(0, 200)}`);
    }
    if (fixedContent.trim() === currentContent.trim()) {
        throw new PipelineValidationError('grounded-fix', 'fixed file is byte-identical to the current file — no fix was actually produced');
    }
    if (!fixedContent.includes('class ConnectionPool') && !fixedContent.includes('def ')) {
        throw new PipelineValidationError('grounded-fix', `fixed file doesn't look like valid Python (no class/def found): ${fixedContent.slice(0, 300)}`);
    }
}

function extractRootCause(diagnosis: string): string {
    const match = diagnosis.match(/ROOT CAUSE:\s*(.+)/);
    return match?.[1]?.trim() ?? 'address connection pool exhaustion incident';
}

// GitHub's real PR title limit is 256 chars. Truncate at the last word
// boundary within that budget rather than an arbitrary shorter cutoff mid-word.
function truncateAtWordBoundary(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    const cut = text.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

async function main() {
    console.log('[rca-agent] Reading log fixture...');
    const logContents = fs.readFileSync(LOG_PATH, 'utf-8');
    const lineCount = logContents.trim().split('\n').length;
    console.log(`[rca-agent] Loaded ${LOG_PATH} (${lineCount} lines)`);

    console.log('[rca-agent] Handing off to the generic delegation pipeline (runDelegationFlow)...');
    const result = await runDelegationFlow({
        objective: RCA_OBJECTIVE,
        language: 'python',
        inputData: logContents,
        // This client's whole point is to prove the RCA task rides the same
        // real mesh delegation path as any other objective — force it rather
        // than depend on this container's current resource state.
        forceDelegate: true,
    });

    console.log('\n=== RCA DIAGNOSIS ===');
    console.log(result.output);

    validateDiagnosis(result.output);
    console.log('[rca-agent] Diagnosis validated (not an error passthrough, has TRIGGER/CASCADE/ROOT CAUSE, cites a real timestamp) — proceeding.');

    const containerName = result.raw?.containerName;
    console.log(`\n[rca-agent] ranLocally=${result.ranLocally} sandbox executed on: ${containerName ?? '(local — no remote container involved)'}`);

    console.log('\n[rca-agent] Generating blind patch from diagnosis (demo narration only, second LLM call)...');
    const blindPatch = await generatePatch(result.output);
    console.log('\n=== BLIND PATCH (not what gets committed — see grounded fix below) ===');
    console.log(blindPatch);

    console.log('\n[rca-agent] Opening a real PR against the demo repo...');
    console.log(`[rca-agent] Fetching base branch (${BASE_BRANCH}) SHA...`);
    const baseSha = await getBranchSha(BASE_BRANCH);

    const branchName = `rca-fix-${Date.now()}`;
    console.log(`[rca-agent] Creating branch ${branchName}...`);
    await createBranch(branchName, baseSha);

    console.log(`[rca-agent] Fetching current ${TARGET_FILE} content from ${BASE_BRANCH}...`);
    const { content: currentContent, sha: fileSha } = await getFileContent(TARGET_FILE, BASE_BRANCH);

    console.log('[rca-agent] Generating grounded fix (third LLM call, given real file content)...');
    const fixedContent = await generateFixedFile(result.output, currentContent);

    validateFixedFile(fixedContent, currentContent);
    console.log('[rca-agent] Grounded fix validated (not an error passthrough, differs from current file, looks like real Python) — proceeding.');

    const realDiff = createTwoFilesPatch(TARGET_FILE, TARGET_FILE, currentContent, fixedContent, '', '');
    fs.writeFileSync(PATCH_PATH, realDiff);
    console.log(`[rca-agent] Real (mechanically computed) diff written to ${PATCH_PATH}`);
    console.log('\n=== REAL DIFF (what actually gets committed) ===');
    console.log(realDiff);

    const rootCause = extractRootCause(result.output);
    const commitMessage = `fix: ${rootCause}`;
    console.log(`[rca-agent] Committing fix to ${branchName}...`);
    await updateFile(TARGET_FILE, fixedContent, fileSha, branchName, commitMessage);

    const prTitle = truncateAtWordBoundary(`fix: ${rootCause}`, 200);
    const prBody = `## Root Cause Analysis (automated)\n\n${result.output}\n\n## Fix\n\n\`\`\`diff\n${realDiff}\n\`\`\`\n\n---\n_Opened automatically by \`examples/rca-agent.ts\` — diagnosis generated via the Overflow delegation pipeline (sandbox executed on \`${containerName}\`), fix grounded against the real file content on \`${BASE_BRANCH}\`._`;

    console.log('[rca-agent] Opening pull request...');
    const pr = await createPullRequest(prTitle, prBody, branchName, BASE_BRANCH);
    console.log(`\n[rca-agent] PR opened: ${pr.url}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
