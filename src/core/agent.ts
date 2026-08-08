import { getResources } from "./resources";
import { runInference } from "./executor";

//global vars (Can change later) - can push to env vars later 
const OLLAMA_MODEL = "tinyllama";
const OLLAMA_MAX_TOKENS = 500;

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

    //if not constrained and can run ollama inference - try locally
    if (!forceDelegate && !resources.isConstrained && resources.ollamaReachable) {
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
            inputData
        })
    });

    const data = await delegate_response.json();
    console.log('[agent] Delegated result:', data);
}

runAgent().catch(console.error);