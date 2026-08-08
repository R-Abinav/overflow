import * as fs from 'fs';
import * as path from 'path';
import { runDelegationFlow } from '../src/core/agent';

// Standalone RCA reference client. Deliberately does NOT reimplement any
// constraint-check / code-generation / delegation logic — it constructs an
// objective + inputData describing the RCA task and hands it to the exact
// same runDelegationFlow() the requester CLI (src/core/agent.ts) uses. This
// is a client of the generic delegation pipeline, not a special case inside it.

const LOG_PATH = path.join(__dirname, 'rca-demo', 'auth-service.log');

const RCA_OBJECTIVE = `You are a site reliability engineer performing root cause analysis on a production incident. Below (in the input data) is a real auth-service log covering the minutes leading up to a crash.

Analyze the log and write a Python script that:
1. Parses the log lines (they are plain text, one event per line, format: "<ISO timestamp> <LEVEL> [component] [subcomponent] message").
2. Extracts real evidence: count of failed login attempts per targeted username, the distinct source IPs involved, the connection pool utilization trend over time, the timestamp where the pool first shows status=EXHAUSTED, and the final FATAL error.
3. Prints a concise root cause analysis to stdout, in this structure:
   - TRIGGER: what started the incident (cite actual counts/usernames/IPs from the log, not generic language)
   - CASCADE: how the trigger led to the resource exhaustion and the crash (cite actual timestamps and error messages)
   - ROOT CAUSE: one sentence, specific to this incident
Do not fabricate evidence that is not in the log. Use only the Python standard library.
When extracting a field like a timestamp from a matching line, parse it robustly: do not assume a fixed number of spaces or exact field ordering across the whole line in a single rigid regex. Prefer checking for a stable substring/key and then deriving the value separately (e.g. the line's leading token) over one regex that must match the entire line's layout at once.`;

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
}

main().catch(console.error);
