import * as fs from 'fs';
import * as path from 'path';
import { runDelegationFlow } from '../src/core/agent';
import { askLLM, ChatMessage } from '../src/core/llm';

// Standalone RCA reference client. Deliberately does NOT reimplement any
// constraint-check / code-generation / delegation logic — it constructs an
// objective + inputData describing the RCA task and hands it to the exact
// same runDelegationFlow() the requester CLI (src/core/agent.ts) uses. This
// is a client of the generic delegation pipeline, not a special case inside it.

const LOG_PATH = path.join(__dirname, 'rca-demo', 'auth-service.log');
const PATCH_PATH = path.join(__dirname, 'rca-demo', 'patch.diff');

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
Every count or specific number cited anywhere in the printed analysis (TRIGGER, CASCADE, ROOT CAUSE, or any other summary line) must be produced by printing the actual computed variable (e.g. an f-string referencing the real dict/counter/list you built while parsing) — never hand-written as a literal number in the summary text. If you are not counting something with code, do not state a count for it.`;

// Second, separate LLM call — not part of the sandbox/generic-delegation
// pipeline (a patch isn't something that gets *executed* in the sandbox), so
// this reuses askLLM() directly rather than generateCandidateCode(), which is
// specifically for stdlib-only Python sandbox code.
const PATCH_SYSTEM_PROMPT = `You are a senior software engineer proposing a minimal, concrete fix for a production incident, given a root cause analysis someone else already performed. Output ONLY a single unified diff (standard format: "--- a/<path>", "+++ b/<path>", "@@ ... @@" hunk headers, context lines, +/- changed lines) that directly addresses the SPECIFIC root cause described — not a generic best-practices patch. The fix must be minimal: the smallest concrete change that addresses the trigger and/or the resource exhaustion described, not a rewrite.
The fix must target the file connection_pool.py exactly — use "--- a/connection_pool.py" and "+++ b/connection_pool.py" as the diff paths, no other file. This is the actual connection pool implementation for the service; queue/connection-pool exhaustion is the root cause of this incident, so the fix belongs there specifically (contributing signals like login attempt volume are not the primary cause and should not redirect the fix elsewhere). Write the patch in Python. Respond with ONLY a diff code block, no prose before or after.`;

function extractDiff(rawResponse: string): string {
    const diffMatch = rawResponse.match(/```(?:diff)?\n([\s\S]*?)```/);
    return diffMatch ? diffMatch[1].trim() : rawResponse.trim();
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

    const containerName = result.raw?.containerName;
    console.log(`\n[rca-agent] ranLocally=${result.ranLocally} sandbox executed on: ${containerName ?? '(local — no remote container involved)'}`);

    console.log('\n[rca-agent] Generating patch from diagnosis (second LLM call)...');
    const patch = await generatePatch(result.output);
    fs.writeFileSync(PATCH_PATH, patch);
    console.log(`[rca-agent] Patch written to ${PATCH_PATH}`);
    console.log('\n=== GENERATED PATCH ===');
    console.log(patch);
}

main().catch(console.error);
