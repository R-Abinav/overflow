import { ENV } from '../config/env.config';
import { askLLM, ChatMessage } from './llm';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SandboxAttempt {
    attemptNumber: number;
    source: 'requester-original' | 'cold-start-generated' | 'self-corrected';
    code: string;
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface SandboxResult {
    success: boolean;
    finalOutput: string;
    finalCode: string;
    attempts: SandboxAttempt[];
    durationMs: number;
    usedFallbackApproach: boolean;
}

// Shared between the provider's cold-start generation and the requester's
// local pre-generation step (agent.ts) — both must assume the identical
// sandbox environment, or a "missing dependency" failure on the provider
// would be an inconsistency bug instead of a legitimate cross-machine
// mismatch worth demoing.
export const SANDBOX_SYSTEM_PROMPT = `You are a code-execution agent running inside a sandboxed environment with Python 3 standard library only — no third-party packages are installed. Given a task, write a single self-contained Python script that accomplishes it using only the standard library, and prints its result to stdout. Respond with ONLY a python code block.`;

function extractCode(rawResponse: string): string {
    const codeMatch = rawResponse.match(/```(?:python)?\n([\s\S]*?)```/);
    return codeMatch ? codeMatch[1].trim() : rawResponse.trim();
}

/**
 * Generates one candidate Python script for an objective, without executing it.
 * Used both by the provider's cold-start attempt 1 and by the requester's
 * local pre-generation step, so a script generated on either machine assumes
 * the same stdlib-only constraint.
 */
export async function generateCandidateCode(objective: string, inputData?: string): Promise<string> {
    const messages: ChatMessage[] = [
        {
            role: 'user',
            content: `Task Objective: ${objective}${inputData ? `\n\nInput Data:\n${inputData}` : ''}`
        }
    ];
    const rawResponse = await askLLM(SANDBOX_SYSTEM_PROMPT, messages);
    return extractCode(rawResponse);
}

const SANDBOX_TIMEOUT_MS = 20000; // 20s

async function runScript(code: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overflow-'));
    const scriptPath = path.join(tempDir, 'script.py');
    fs.writeFileSync(scriptPath, code);

    try {
        return await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
            execFile('python3', [scriptPath], { timeout: SANDBOX_TIMEOUT_MS, cwd: tempDir }, (error, stdout, stderr) => {
                resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: error ? (error as any).code || 1 : 0
                });
            });
        });
    } catch (execErr: any) {
        return { stdout: '', stderr: execErr.message || 'Unknown execution error', exitCode: 1 };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

// No dependency installation is ever offered as a fix — the sandbox stays
// stdlib-only always. A ModuleNotFoundError is fixed by rewriting the
// approach with stdlib equivalents, never by suggesting pip.
function selfCorrectionInstruction(stdout: string, stderr: string, exitCode: number): string {
    return `Execution failed with exit code ${exitCode}.\n\nStdout:\n${stdout}\n\nStderr:\n${stderr}\n\nFix the code so it works using ONLY the Python standard library. Do not suggest or attempt to install any package (no pip, no package managers — the sandbox has no ability to install anything, now or ever). If the failure is a missing third-party package (e.g. ModuleNotFoundError), rewrite that functionality using stdlib equivalents instead.`;
}

export async function runSandboxedTask(
    objective: string,
    language: 'python' = 'python',
    inputData?: string,
    code?: string
): Promise<SandboxResult> {
    const startTime = Date.now();
    const attempts: SandboxAttempt[] = [];
    const maxAttempts = ENV.SANDBOX_MAX_ATTEMPTS || 3;

    let success = false;
    let finalOutput = '';
    let finalCode = '';

    // Conversation history for self-correction turns. Seeded with the
    // objective; attempt 1's code (whichever source it came from) is added
    // once we know it, so a later self-correction call sees the right history.
    let messages: ChatMessage[] = [
        {
            role: 'user',
            content: `Task Objective: ${objective}${inputData ? `\n\nInput Data:\n${inputData}` : ''}`
        }
    ];

    for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
        let attemptCode: string;
        let source: SandboxAttempt['source'];

        if (attemptNum === 1 && code) {
            // Fast path — the requester already generated this code and just
            // couldn't run it locally. Try it as-is first, no LLM call.
            attemptCode = code;
            source = 'requester-original';
            console.log(`[sandbox] Attempt 1: running requester-supplied code directly, no LLM call`);
        } else if (attemptNum === 1) {
            // Cold start — unchanged from prior behavior when no code is supplied.
            console.log(`[sandbox] Attempt ${attemptNum} of ${maxAttempts} for objective: "${objective.substring(0, 30)}..."`);
            try {
                attemptCode = await generateCandidateCode(objective, inputData);
            } catch (e: any) {
                console.error(`[sandbox] LLM call failed: ${e.message}`);
                finalOutput = `Error calling LLM: ${e.message}`;
                break;
            }
            source = 'cold-start-generated';
        } else {
            console.log(`[sandbox] Attempt ${attemptNum} of ${maxAttempts} — self-correcting`);
            let rawResponse: string;
            try {
                rawResponse = await askLLM(SANDBOX_SYSTEM_PROMPT, messages);
            } catch (e: any) {
                console.error(`[sandbox] LLM call failed: ${e.message}`);
                finalOutput = `Error calling LLM: ${e.message}`;
                break;
            }
            attemptCode = extractCode(rawResponse);
            source = 'self-corrected';
        }

        finalCode = attemptCode;
        console.log(`\n[sandbox] --- Executing Python Code ---`);
        console.log(attemptCode);
        console.log(`[sandbox] -----------------------------\n`);
        const { stdout, stderr, exitCode } = await runScript(attemptCode);

        attempts.push({ attemptNumber: attemptNum, source, code: attemptCode, stdout, stderr, exitCode });

        if (exitCode === 0) {
            success = true;
            finalOutput = stdout;
            if (source === 'requester-original') {
                console.log(`[sandbox] Attempt ${attemptNum} succeeded — ran requester's code unmodified, succeeded on first try`);
            } else {
                console.log(`[sandbox] Attempt ${attemptNum} succeeded`);
            }
            break;
        }

        console.log(`[sandbox] Attempt ${attemptNum} failed. Exit code: ${exitCode}`);
        finalOutput = stdout + (stderr ? `\nError:\n${stderr}` : '');

        // Seed this attempt's code into history (as an assistant turn) before
        // asking for a fix, regardless of which source produced it.
        messages.push({ role: 'assistant', content: `\`\`\`python\n${attemptCode}\n\`\`\`` });
        messages.push({ role: 'user', content: selfCorrectionInstruction(stdout, stderr, exitCode) });
    }

    return {
        success,
        finalOutput,
        finalCode,
        attempts,
        durationMs: Date.now() - startTime,
        usedFallbackApproach: attempts.length > 1
    };
}
