import { getResources, ResourceStatus } from "./resources";
import { generateCandidateCode, runScript } from "./sandbox";
import { ENV } from "../config/env.config";

// localError is logging/demo narration only — never fed into execution logic.
function buildLocalError(
    reason: 'force-delegate' | 'constrained' | 'local-execution-failed',
    resources: ResourceStatus
): string {
    switch (reason) {
        case 'force-delegate':
            return 'force-delegate flag set — local execution skipped intentionally';
        case 'constrained':
            return `local resource constraint: ${resources.freeRamMB.toFixed(0)}MB free RAM (threshold ${ENV.FREE_RAM_THRESHOLD_MB}MB), ${resources.cpuLoadPercent.toFixed(1)}% CPU load (threshold ${ENV.FREE_CPU_THRESHOLD_PERCENT}%)`;
        case 'local-execution-failed':
            return 'local code generation/execution attempt failed';
    }
}

export interface DelegationFlowParams {
    objective: string;
    language?: string;
    inputData?: string | undefined;
    forceDelegate?: boolean;
}

export interface DelegationFlowResult {
    ranLocally: boolean;
    output: string;
    raw?: any; // full /delegate JSON response, present only when delegated
}

// The core requester flow: check constraint -> try local generation+execution
// if unconstrained -> otherwise generate candidate code and delegate over AXL.
// Shared by the CLI (below) and any other reference client (e.g. examples/rca-agent.ts)
// so there is exactly one implementation of this decision path, not two.
export async function runDelegationFlow(params: DelegationFlowParams): Promise<DelegationFlowResult> {
    const { objective, inputData } = params;
    const language = params.language || "python";
    const forceDelegate = params.forceDelegate ?? false;

    //check local resources
    const resources = await getResources();

    const delegateUrl = `http://localhost:3002/delegate`;

    let localError: string | undefined;

    //if not constrained - generate real code and actually run it locally,
    //via the same generateCandidateCode() + runScript() sandbox.ts uses for
    //the provider's cold-start path. No mocked stub, no separate mechanism.
    if (!forceDelegate && !resources.isConstrained) {
        console.log('[agent] Unconstrained — generating code locally...');
        try {
            const localCode = await generateCandidateCode(objective, inputData);
            console.log('[agent] Generated code, executing locally...');
            const { stdout, stderr, exitCode } = await runScript(localCode, inputData);

            if (exitCode === 0) {
                console.log('[agent] Completed locally');
                console.log('[agent] Output:', stdout);
                return { ranLocally: true, output: stdout };
            }

            //if fail -> fall through to delegate
            console.log(`[agent] Local execution failed (exit code ${exitCode}), delegating...`);
            if (stderr) console.log('[agent] Local stderr:', stderr);
            localError = buildLocalError('local-execution-failed', resources);
        } catch (e: any) {
            console.warn('[agent] Local code generation failed, delegating:', e.message);
            localError = buildLocalError('local-execution-failed', resources);
        }
    } else if (forceDelegate) {
        localError = buildLocalError('force-delegate', resources);
    } else if (resources.isConstrained) {
        localError = buildLocalError('constrained', resources);
    }

    // Generate the code we would have run, so the provider can try it directly
    // instead of re-solving the task blind. Generation is a cheap network call,
    // not the constrained resource — only *execution* was the problem — so it's
    // fine to do here even though we can't run the result locally.
    let code: string | undefined;
    try {
        console.log('[agent] Generating candidate code locally (will not execute it here)...');
        code = await generateCandidateCode(objective, inputData);
        console.log('[agent] Candidate code generated, sending it along with delegation.');
    } catch (e: any) {
        console.warn('[agent] Local code generation failed, delegating with objective only:', e.message);
    }

    //if constrained, force-delegated, or local execution failed -> delegate
    const delegate_response = await fetch(delegateUrl, {
        method: 'POST',
        headers: {
            'Content-type': 'application/json'
        },
        body: JSON.stringify({
            objective,
            language,
            inputData,
            code,
            localError
        })
    });

    const data = await delegate_response.json();
    console.log('[agent] Delegated result:', data);
    return { ranLocally: false, output: data?.finalOutput ?? JSON.stringify(data), raw: data };
}

// ── CLI entrypoint — unchanged behavior from before the refactor ──────────────

async function runAgentCli() {
    const args = process.argv.slice(2);

    const forceDelegate = args.includes('--force-delegate');
    if (forceDelegate) {
        console.log('[agent] Force delegating...');
    }

    const objectiveArg = args.find(a => a.startsWith('--objective='));
    const objective = (objectiveArg ? objectiveArg.split('=')[1] : null) || "compute the 20th Fibonacci number";

    const languageArg = args.find(a => a.startsWith('--language='));
    const language = (languageArg ? languageArg.split('=')[1] : null) || "python";

    const inputDataArg = args.find(a => a.startsWith('--inputData='));
    const inputData = inputDataArg ? inputDataArg.split('=')[1] : undefined;

    await runDelegationFlow({ objective, language, inputData, forceDelegate });
}

// Only auto-run when executed directly (e.g. `npx tsx src/core/agent.ts`),
// not when imported as a module by another reference client.
if (require.main === module) {
    runAgentCli().catch(console.error);
}
