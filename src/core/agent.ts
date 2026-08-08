import { getResources, ResourceStatus } from "./resources";
import { runInference } from "./executor";
import { generateCandidateCode } from "./sandbox";
import { ENV } from "../config/env.config";

//global vars (Can change later) - can push to env vars later
const OLLAMA_MODEL = "tinyllama";
const OLLAMA_MAX_TOKENS = 500;

// localError is logging/demo narration only — never fed into execution logic.
function buildLocalError(
    reason: 'force-delegate' | 'constrained' | 'no-ollama' | 'local-inference-failed',
    resources: ResourceStatus
): string {
    switch (reason) {
        case 'force-delegate':
            return 'force-delegate flag set — local execution skipped intentionally';
        case 'constrained':
            return `local resource constraint: ${resources.freeRamMB.toFixed(0)}MB free RAM (threshold ${ENV.FREE_RAM_THRESHOLD_MB}MB), ${resources.cpuLoadPercent.toFixed(1)}% CPU load (threshold ${ENV.FREE_CPU_THRESHOLD_PERCENT}%)`;
        case 'no-ollama':
            return 'local ollama endpoint unreachable — no local model available';
        case 'local-inference-failed':
            return 'local inference attempt failed';
    }
}

export async function runAgent() {
    const args = process.argv.slice(2);

    //if force delegation present - skip local inference!
    const forceDelegate = args.includes('--force-delegate');
    if (forceDelegate) {
        console.log('[agent] Force delegating...');
    }

    //extract objective
    const objectiveArg = args.find(a => a.startsWith('--objective='));
    const objective = (objectiveArg ? objectiveArg.split('=')[1] : null) || "compute the 20th Fibonacci number";

    //extract language
    const languageArg = args.find(a => a.startsWith('--language='));
    const language = (languageArg ? languageArg.split('=')[1] : null) || "python";

    //extract inputData
    const inputDataArg = args.find(a => a.startsWith('--inputData='));
    const inputData = inputDataArg ? inputDataArg.split('=')[1] : undefined;

    //check local resources
    const resources = await getResources();

    const delegateUrl = `http://localhost:3002/delegate`;

    let localError: string | undefined;

    // Explicit FORCE_CONSTRAINED=false means "treat this node as unconstrained
    // for this demo/topology run" — bypass the real ollamaReachable check too,
    // since runInference() is a fully mocked stub that doesn't actually call
    // Ollama, and these containers don't have Ollama installed. Default
    // (unset) behavior is unchanged: still requires a real reachable Ollama.
    const forcedUnconstrained = process.env.FORCE_CONSTRAINED === 'false';

    //if not constrained and can run ollama inference - try locally
    if (!forceDelegate && !resources.isConstrained && (resources.ollamaReachable || forcedUnconstrained)) {
        //run the inference locally
        const result = await runInference(OLLAMA_MODEL, objective);

        //if success -> print result, return
        if (result) {
            console.log('[agent] Completed locally');
            console.log('[agent] Output:', result.output);
            console.log('[agent] Hash:', result.outputHash);
            return; // ← early return, done
        }

        //if fail -> fall through to delegate
        console.log('[agent] Local inference failed, delegating...');
        localError = buildLocalError('local-inference-failed', resources);
    } else if (forceDelegate) {
        localError = buildLocalError('force-delegate', resources);
    } else if (resources.isConstrained) {
        localError = buildLocalError('constrained', resources);
    } else if (!resources.ollamaReachable) {
        localError = buildLocalError('no-ollama', resources);
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

    //if no resources, no ollama, or local inference failed -> delegate
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
}

runAgent().catch(console.error);
