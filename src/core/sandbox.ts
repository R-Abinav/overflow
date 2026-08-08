import { ENV } from '../config/env.config';
import { askLLM, ChatMessage } from './llm';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SandboxAttempt {
    attemptNumber: number;
    code: string;
    stdout: string;
    stderr: string;
    exitCode: number;
}

export async function runSandboxedTask(
    objective: string,
    language: 'python' = 'python',
    inputData?: string
): Promise<{
    success: boolean;
    finalOutput: string;
    finalCode: string;
    attempts: SandboxAttempt[];
    durationMs: number;
}> {
    const startTime = Date.now();
    const attempts: SandboxAttempt[] = [];
    
    let systemPrompt = `You are a code-execution agent running inside a sandboxed environment with Python 3 standard library only — no third-party packages are installed. Given a task, write a single self-contained Python script that accomplishes it using only the standard library, and prints its result to stdout. Respond with ONLY a python code block.`;
    
    let messages: ChatMessage[] = [
        {
            role: 'user',
            content: `Task Objective: ${objective}${inputData ? `\n\nInput Data:\n${inputData}` : ''}`
        }
    ];

    let success = false;
    let finalOutput = '';
    let finalCode = '';

    const maxAttempts = ENV.SANDBOX_MAX_ATTEMPTS || 3;
    const timeoutMs = 20000; // 20s

    for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
        console.log(`[sandbox] Attempt ${attemptNum} of ${maxAttempts} for objective: "${objective.substring(0, 30)}..."`);
        
        // 1. Get code from LLM
        let rawResponse = '';
        try {
            rawResponse = await askLLM(systemPrompt, messages);
        } catch (e: any) {
            console.error(`[sandbox] LLM call failed: ${e.message}`);
            finalOutput = `Error calling LLM: ${e.message}`;
            break;
        }

        // 2. Extract code block
        const codeMatch = rawResponse.match(/```(?:python)?\n([\s\S]*?)```/);
        const code = codeMatch ? codeMatch[1].trim() : rawResponse.trim();
        finalCode = code;

        // 3. Create temp dir and write script
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overflow-'));
        const scriptPath = path.join(tempDir, 'script.py');
        fs.writeFileSync(scriptPath, code);

        // 4. Run script
        let stdout = '';
        let stderr = '';
        let exitCode = 1;

        try {
            const result = await new Promise<{stdout: string, stderr: string, code: number}>((resolve) => {
                execFile('python3', [scriptPath], { timeout: timeoutMs, cwd: tempDir }, (error, stdout, stderr) => {
                    resolve({
                        stdout: stdout.toString(),
                        stderr: stderr.toString(),
                        code: error ? (error as any).code || 1 : 0
                    });
                });
            });
            stdout = result.stdout;
            stderr = result.stderr;
            exitCode = result.code;
        } catch (execErr: any) {
            stderr = execErr.message || 'Unknown execution error';
            exitCode = 1;
        } finally {
            // Clean up temp dir
            fs.rmSync(tempDir, { recursive: true, force: true });
        }

        const attemptRecord: SandboxAttempt = {
            attemptNumber: attemptNum,
            code,
            stdout,
            stderr,
            exitCode
        };
        attempts.push(attemptRecord);

        // 5. Check result
        if (exitCode === 0) {
            success = true;
            finalOutput = stdout;
            console.log(`[sandbox] Attempt ${attemptNum} succeeded`);
            break;
        } else {
            console.log(`[sandbox] Attempt ${attemptNum} failed. Exit code: ${exitCode}`);
            finalOutput = stdout + (stderr ? `\nError:\n${stderr}` : '');
            
            // Add failure to history to let LLM self-correct
            messages.push({
                role: 'assistant',
                content: `\`\`\`python\n${code}\n\`\`\``
            });
            messages.push({
                role: 'user',
                content: `Execution failed with exit code ${exitCode}.\n\nStdout:\n${stdout}\n\nStderr:\n${stderr}\n\nPlease fix the code. Remember you can only use the Python standard library.`
            });
        }
    }

    return {
        success,
        finalOutput,
        finalCode,
        attempts,
        durationMs: Date.now() - startTime
    };
}
