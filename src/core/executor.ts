import { ENV } from "../config/env.config";
import { createHash } from 'crypto';

export async function runInference(model: string, prompt: string): Promise<{
    output: string;
    tokensGenerated: number;
    durationMs: number;
    outputHash: string
} | null> {
    const output = "Mocked inference result for Step 1 baseline test.";
    const outputHash = createHash('sha256').update(output).digest('hex');
    
    return {
        output,
        tokensGenerated: 10,
        durationMs: 100,
        outputHash
    };
}