import { ENV } from './config/env.config';
import { spawnAXL, AXLClient } from './core/axl';
import { getResources } from './core/resources';
import express from 'express';
import path from 'path';
import * as os from 'os';

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { runSandboxedTask } from './core/sandbox';
// integrity.ts (ZK) and payment.ts (KeeperHub/x402) imports removed — Step 2 strip
// escrow.ts kept in place per spec; stakeForJob call gated behind P1 flag below
import { stakeForJob, verifyStake } from './core/escrow';

async function main() {
    //read role from CLI arg
    const args = process.argv.slice(2);
    const roleArg = args.find(a => a.startsWith('--role='));
    const role = roleArg ? roleArg.split('=')[1] : ENV.ROLE;

    console.log(`[overflow] Starting Overflow daemon in '${role}' role...`);

    //pick the right AXL config file and port based on role
    //using node-config-a (port 9002) for provider, node-config-b (port 9012) for requester
    //AXL_CONFIG_PATH, if explicitly set, overrides the role-based default — lets
    //multiple requester instances (each needing a distinct AXL identity/keypair)
    //share the same image while pointing at their own node-config-*.json.
    const configPath = process.env.AXL_CONFIG_PATH || (role === 'provider' ? './node-config-a.json' : './node-config-b.json');
    const apiPort = role === 'provider' ? 9002 : 9012;

    //using 3001 for provider, 3002 for requester to avoid port conflicts during local testing
    const daemonPort = role === 'provider' ? 3001 : 3002;

    console.log(`[overflow] Using config: ${configPath}`);
    console.log(`[overflow] AXL API Port: ${apiPort}`);

    //spawn AXL
    const cleanupAXL = spawnAXL(configPath, apiPort);

    //create AXLClient
    const client = new AXLClient(apiPort);

    const pendingTasks = new Map<string, {
        resolve: (result: any) => void;
        reject: (err: Error) => void;
    }>();

    // Rolling log of last 50 completed/failed jobs — served by /jobs endpoint
    const recentJobs: Array<{
        jobId: string;
        requestId: string;
        status: 'completed' | 'failed';
        durationMs: number;
        timestamp: number;
    }> = [];

    const routerEvents = new EventEmitter();

    //call waitReady() and log
    console.log('[overflow] Waiting for AXL mesh to be ready...');
    await client.waitReady();
    console.log('[overflow] AXL is ready!');

    //log own public key
    const topology = await client.getTopology();
    console.log(`[overflow] Node Public Key: ${topology.ourPublicKey}`);

    //one-time startup advertisement
    const resources = await getResources();
    const peers = await client.getPeers();
    if (peers.length > 0) {
        try {
            for (const peerId of peers) {
                await client.send(peerId, {
                    type: 'resource_ad',
                    nodeId: topology.ourPublicKey,
                    timestamp: Date.now(),
                    resources
                });
            }
            console.log(`[overflow] Sent resource_ad to ${peers.length} peer(s)`);
        } catch (err) {
            console.warn('[overflow] Could not send resource_ad (expected on localhost):', (err as Error).message);
        }
    }

    //loop: Message poll (every 500ms)
    const pollInterval = setInterval(async () => {
        try {
            const msg = await client.recv();
            if (msg) {
                const data = msg.data as any;
                console.log(`[overflow] Received message from ${msg.fromPeerId}: ${data.type || 'unknown'}`);

                // Message router
                switch (data.type) {
                    case 'resource_request': {
                        console.log(`[overflow] Received resource_request from ${msg.fromPeerId}`);
                        const resourcesInfo = await getResources();
                        await client.send(msg.fromPeerId, {
                            type: 'resource_ad',
                            nodeId: topology.ourPublicKey,
                            ensName: ENV.ENS_NAME || 'node.overflow.eth',
                            timestamp: Date.now(),
                            resources: resourcesInfo,
                        });
                        break;
                    }
                    case 'resource_ad': {
                        console.log(`[overflow] Received resource_ad from ${data.ensName || msg.fromPeerId}`);
                        console.log(`[overflow]   RAM free: ${data.resources.freeRamMB?.toFixed(0)}MB  CPU load: ${data.resources.cpuLoadPercent?.toFixed(1)}%`);
                        routerEvents.emit('resource_ad', data);
                        break;
                    }
                    case 'task_request': {
                        console.log(`[overflow] Received task_request from ${msg.fromPeerId}`);

                        // P1: verifyStake(data.jobId) call goes here once escrow is wired
                        // For P0 — skip onchain verification, proceed directly to execution

                        if (data.task.localError) {
                            console.log(`[overflow] Requester reported local failure: ${data.task.localError}`);
                        }

                        try {
                            // Call sandbox instead of inference.
                            // data.task.code, if present, is the requester's own
                            // already-generated code — runSandboxedTask tries it
                            // directly before falling back to self-correction.
                            const result = await runSandboxedTask(
                                data.task.objective,
                                data.task.language || 'python',
                                data.task.inputData,
                                data.task.code
                            );

                            console.log(`[overflow] Sandbox execution complete (${result.durationMs}ms)`);

                            // os.hostname() is the container name in Docker Compose (no
                            // separate mapping needed) — lets a caller of /delegate know
                            // which real peer's sandbox actually ran the code, not guessed.
                            await client.send(msg.fromPeerId, {
                                type: 'task_result',
                                requestId: data.requestId,
                                fromNodeId: topology.ourPublicKey,
                                toNodeId: msg.fromPeerId,
                                timestamp: Date.now(),
                                result: { ...result, containerName: os.hostname() }
                            });
                            console.log(`[overflow] Sent task_result for request ${data.requestId}`);

                        } catch (err: any) {
                            console.error(`[overflow] Task failed:`, err.message);
                        }
                        break;
                    }
                    case 'task_result': {
                        console.log(`[overflow] Received task_result from ${msg.fromPeerId}`);
                        // ZK verify removed (Step 2 strip) — resolve immediately on receipt
                        if (pendingTasks.has(data.requestId)) {
                            pendingTasks.get(data.requestId)!.resolve(data.result);
                            pendingTasks.delete(data.requestId);
                        }

                        // Log the completed job
                        recentJobs.push({
                            jobId: '',
                            requestId: data.requestId,
                            status: 'completed',
                            durationMs: data.result?.durationMs || 0,
                            timestamp: Date.now(),
                        });
                        if (recentJobs.length > 50) recentJobs.shift();
                        break;
                    }
                    // payment_request / payment_confirmed cases removed (Step 2 strip — KeeperHub/x402 cut)
                    default:
                        // Ignore unhandled types
                        break;
                }
            }
        } catch (err) {
            console.error('[overflow] Error polling messages:', err);
        }
    }, 500);


    //HTTP Server
    const app = express();
    app.use(express.json());

    app.post('/delegate', async (req, res) => {
        try {
            // code: the requester's own already-generated code, if it has any
            //   (couldn't run it locally — resource constraint, force-delegate,
            //   or no local model available). Optional.
            // localError: what happened locally, e.g. an OOM/constraint message.
            //   Logging/demo narration only — never used in execution logic.
            const { objective, language, inputData, code, localError } = req.body;
            const availablePeers = await client.getPeers();

            console.log(`[overflow] Broadcasting resource_request to ${availablePeers.length} peer(s)...`);
            if (availablePeers.length === 0) {
                res.status(503).json({ error: 'No peers available' });
                return;
            }

            const requestSentAt = Date.now();
            for (const peer of availablePeers) {
                await client.send(peer, {
                    type: 'resource_request',
                    fromNodeId: topology.ourPublicKey,
                    timestamp: requestSentAt,
                    task: { kind: 'code_exec', objective, language, inputData, code, localError }
                });
            }

            console.log(`[overflow] Waiting for resource_ad...`);
            const targetPeer = await new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    routerEvents.off('resource_ad', handler);
                    reject(new Error('Timeout waiting for resource_ad'));
                }, 5000);

                const handler = (adData: any) => {
                    if (adData.timestamp < requestSentAt) return; // stale, ignore
                    if (!availablePeers.includes(adData.nodeId)) {
                        console.warn('[overflow] resource_ad from unknown peer, ignoring');
                        return;
                    }
                    clearTimeout(timeout);
                    routerEvents.off('resource_ad', handler);
                    resolve(adData.nodeId);
                };
                routerEvents.on('resource_ad', handler);
            });

            const requestId = randomUUID();
            const jobId = '0x' + randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''); // 64 hex chars = 32 bytes

            // P1: stakeForJob(jobId, targetPeer, ENV.PRICE_PER_JOB_USDC) goes here
            // Kept commented out — escrow wiring is P1, not P0
            // await stakeForJob(jobId, targetPeer, ENV.PRICE_PER_JOB_USDC || '0.01');

            const resultPromise = new Promise((resolve, reject) => {
                pendingTasks.set(requestId, { resolve, reject });
            });

            // Timeout budget. Measured directly (not guessed): a single
            // generateCandidateCode() call for the RCA objective (229-line
            // log, multi-field extraction) took 29-38s on Claude across 4
            // real runs — Gemini handled the same objective in ~7s total, so
            // this is provider-dependent, not objective-dependent alone. Up
            // to 2 self-correction rounds can occur server-side if the
            // requester-original code fails (each is its own full LLM call
            // at the same latency), so worst case is ~3x a single call. 180s
            // gives ~1.5x headroom over that worst case while still being a
            // bounded wait for a live demo.
            setTimeout(() => {
                if (pendingTasks.has(requestId)) {
                    pendingTasks.get(requestId)!.reject(new Error('Task timeout'));
                    pendingTasks.delete(requestId);
                }
            }, 180000);

            await client.send(targetPeer, {
                type: 'task_request',
                requestId,
                fromNodeId: topology.ourPublicKey,
                toNodeId: targetPeer,
                jobId,
                timestamp: Date.now(),
                task: { kind: 'code_exec', objective, language, inputData, code, localError }
            });

            console.log(`[overflow] task_request sent to ${targetPeer} for job ${jobId}`);
            const result = await resultPromise;
            res.json(result);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/status', async (req, res) => {
        try {
            const resources = await getResources();
            const peers = await client.getPeers();
            const currentTopology = await client.getTopology();

            res.json({
                nodeId: currentTopology.ourPublicKey,
                role: role,
                resources: resources,
                peers: peers
            });
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch status' });
        }
    });

    app.get('/jobs', (req, res) => {
        res.json(recentJobs.slice(-10).reverse());
    });

    app.get('/dashboard', (req, res) => {
        res.sendFile(path.join(process.cwd(), 'dashboard/index.html'));
    });

    const server = app.listen(daemonPort, () => {
        console.log(`[overflow] HTTP daemon running on port ${daemonPort}`);
    });

    //shutdown handling
    const shutdown = () => {
        console.log('\n[overflow] Shutting down cleanly...');
        clearInterval(pollInterval);
        server.close();
        cleanupAXL();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(console.error);
