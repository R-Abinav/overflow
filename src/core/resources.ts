import si from 'systeminformation';
import { ENV } from '../config/env.config';

export interface ResourceStatus {
    cpuLoadPercent: number;  // used CPU % (0–100), not free
    freeRamMB: number;
    ollamaReachable: boolean;
    availableModels: string[];
    isConstrained: boolean;
}

export async function getResources(): Promise<ResourceStatus> {
    //fetch CPU and Memory info concurrently for speed
    const [load, mem] = await Promise.all([
        si.currentLoad(),
        si.mem()
    ]);

    const cpuLoadPercent = load.currentLoad; // used CPU %, was incorrectly 100-currentLoad before

    //mem.available is more accurate than mem.free for what's actually usable by applications.
    //systeminformation returns values in bytes, so we divide by 1024^2 for MB
    const freeRamMB = mem.available / (1024 * 1024);

    let ollamaReachable = false;
    let availableModels: string[] = [];

    try {
        //try hitting the default local API endpoint for Ollama
        const ollamaUrl = `http://localhost:11434/api/tags`

        const response = await fetch(ollamaUrl);
        if (response.ok) {
            ollamaReachable = true;
            const data = await response.json();
            if (data.models && Array.isArray(data.models)) {
                //parse the models response
                availableModels = data.models.map((m: any) => m.name);
            }
        }
    } catch (err) {
        // If fetch throws, ollama is not reachable. We leave defaults as false / []
    }

    // Determine if the node is constrained based on the provided thresholds.
    // For the demo, set FREE_RAM_THRESHOLD_MB=999999 in .env to reliably trigger
    // the real detection path on any hardware without bypassing the check.
    const isConstrained = freeRamMB < ENV.FREE_RAM_THRESHOLD_MB || cpuLoadPercent > ENV.FREE_CPU_THRESHOLD_PERCENT;

    return {
        cpuLoadPercent,
        freeRamMB,
        ollamaReachable,
        availableModels,
        isConstrained
    };
}
