/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 ********************************************************************************/

import cluster from 'node:cluster';
import Config from '@cocreate/config';
import { getValueFromObject } from '@cocreate/utils';
import { getCloudProvider } from './geoScaling.js';

// Guard clause verification to ensure cluster API abstraction integrity
const isMaster = cluster.isMaster;

let server = null;                // Central reference to CoCreateServer Master instance
let autoscaleConfig = null;       // Configured thresholds and duration constants
let isRunning = false;            // Execution loop flag

// Consecutive tracking counters to filter transient CPU spikes
let consecutiveCpuSpikes = 0;
let consecutiveLowLoadFlushes = 0;

// Default operational values for telemetry-driven autoscale thresholds
const defaults = {
    scaleUpCpuThreshold: 95,             // CPU usage percentage trigger for Scaling Up (Sustained over flushes)
    scaleDownCpuThreshold: 60,           // CPU usage percentage trigger for Scaling Down (Sustained over flushes)
    scaleUpMemoryThreshold: 85,          // Heap memory utilization trigger for Scaling Up (Instant Per Tick)
    scaleDownMemoryThreshold: 60,        // Heap memory utilization trigger for Scaling Down (Sustained over flushes)
    consecutiveCpuSpikesRequired: 3,     // Require 3 consecutive flushes of high CPU (e.g. 3 flush windows)
    consecutiveLowFlushesRequired: 10,   // Require 10 consecutive flushes of low load (~10-minute debounced check window)
    minClusterSize: 2,                   // Minimum cluster floor
    /**
     * Optional hard ceiling for total active cluster nodes.
     * Default: 0 (Disabled / Uncapped).
     * 
     * WARNING: Setting maxClusterSize > 0 can be dangerous in production.
     * Capping cluster growth under sudden, severe traffic spikes prevents the autoscaler
     * from provisioning necessary compute, potentially leading to load starvation, high latency,
     * or cascading OOM crashes across capped nodes. Use primarily for budget caps or testing/dev environments.
     */
    maxClusterSize: 0,
    /**
     * Geo-Aware Auto Scaling flag.
     * Default: true.
     * 
     * When enabled, the autoscaler aggregates active client locations/timezones across nodes
     * to determine the optimal geographical region for new server instances, allowing 
     * infrastructure orchestrators to deploy nodes at the edge nearest to high-density user clusters.
     */
    geoScaling: true
};

/**
 * Issues an immediate cordon command for a specific worker thread to halt incoming traffic routing.
 * Executed instantly on memory peak ticks or sustained CPU flushes.
 * 
 * @param {Object} telemetry - Current telemetry payload
 */
function cordonWorkerNode(telemetry) {
    const workerId = telemetry.workerId || telemetry.worker_id || process.pid;
    console.warn(`[@cocreate/server-autoscaler] High load threshold detected on worker ${workerId}. Cordoning worker immediately...`);

    // Standardized single-worker IPC Cordon dispatch
    if (typeof cordon === 'function') {
        cordon({
            worker: workerId,
            reason: 'Autoscaler threshold breached',
            timestamp: Date.now()
        });
    } else if (server?.cordon) {
        server.cordon({
            worker: workerId,
            reason: 'Autoscaler threshold breached',
            timestamp: Date.now()
        });
    }
}

/**
 * Calculates average CPU and Memory utilization across all workers on the local node.
 * 
 * @param {Object} telemetry - Current telemetry payload
 * @returns {Object} Node averages for CPU and Memory
 */
function calculateNodeAverage(telemetry) {
    if (telemetry.workers && Array.isArray(telemetry.workers) && telemetry.workers.length > 0) {
        let totalCpu = 0;
        let totalMem = 0;
        
        telemetry.workers.forEach(w => {
            totalCpu += (w.cpu?.usage || w.cpu || 0);
            totalMem += (w.memory?.percentage || w.memory?.used_pct || 0);
        });

        return {
            avgCpu: totalCpu / telemetry.workers.length,
            avgMemory: totalMem / telemetry.workers.length
        };
    }

    return {
        avgCpu: telemetry.cpu?.avg || telemetry.cpu?.totalUsage || 0,
        avgMemory: telemetry.memory?.avg_used_pct || telemetry.memory?.percentage || 0
    };
}

/**
 * Queries the database via CRUD for all active servers where master process is running
 * and extracts their latest telemetry data to compute overall cluster averages.
 * Includes all active servers for simple, direct cluster-wide average calculations.
 * 
 * @returns {Object|null} Telemetry averages and total load across active servers
 */
async function getClusterLatestFlushAverages() {
    if (!server?.crud) {
        console.warn("[@cocreate/server-autoscaler] CRUD layer unavailable. Skipping cluster-wide database check.");
        return null;
    }

    try {
        // Query servers array for all active servers where master is running
        const readResponse = await server.crud.send({
            method: 'object.read',
            array: 'servers',
            $filter: {
                query: {
                    'master.status': 'running'
                }
            },
            organization_id: server.organization_id,
            host: server.host
        });

        const activeServers = Array.isArray(readResponse?.object) ? readResponse.object : [];
        
        let totalCpu = 0;
        let totalMem = 0;
        let count = 0;

        for (const serverRecord of activeServers) {
            const peerTelemetry = serverRecord.telemetry || serverRecord.serverTelemetry;
            if (peerTelemetry) {
                const peerCpu = peerTelemetry.cpu?.avg || peerTelemetry.cpu?.totalUsage || 0;
                const peerMem = peerTelemetry.memory?.avg_used_pct || peerTelemetry.memory?.percentage || 0;
                
                totalCpu += peerCpu;
                totalMem += peerMem;
                count++;
            }
        }

        if (count === 0) return null;

        return {
            avgCpu: totalCpu / count,
            avgMemory: totalMem / count,
            totalCpu,
            totalMem,
            totalCount: count
        };
    } catch (err) {
        console.error("[@cocreate/server-autoscaler] Error querying cluster server telemetries from DB:", err.message);
        return null;
    }
}



/**
 * Validates whether scaling up is necessary by checking Node-level average first,
 * followed by single-flush Cluster capacity from active server records in the database.
 * Also enforces maxClusterSize if explicitly configured (> 0).
 * 
 * @param {Object} telemetry - Telemetry payload frame
 * @returns {boolean} True if scaling up is authorized, False if cordoning alone is sufficient or max cap reached
 */
async function shouldScaleUpCluster(telemetry) {
    const scaleUpCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleUpCpuThreshold'), 10) || defaults.scaleUpCpuThreshold;
    const targetMemory = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleUpMemoryThreshold'), 10) || defaults.scaleUpMemoryThreshold;
    const maxClusterSize = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.maxClusterSize'), 10) || defaults.maxClusterSize;

    // STEP 1: Evaluate local Node average across workers
    const nodeAvg = calculateNodeAverage(telemetry);
    console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 1] Node Average -> CPU: ${nodeAvg.avgCpu.toFixed(1)}%, Memory: ${nodeAvg.avgMemory.toFixed(1)}%`);

    const isNodeOverloaded = nodeAvg.avgCpu >= scaleUpCpu || nodeAvg.avgMemory >= targetMemory;

    if (!isNodeOverloaded) {
        console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 1] Node average is below thresholds. Cordoning worker is sufficient. Scaling up CANCELLED.`);
        return false;
    }

    // STEP 2: Evaluate Cluster capacity across all running servers in DB
    console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Node is overloaded. Querying DB for active server telemetries...`);
    const clusterAvg = await getClusterLatestFlushAverages();

    if (clusterAvg && clusterAvg.totalCount > 0) {
        console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Cluster Average (${clusterAvg.totalCount} servers) -> CPU: ${clusterAvg.avgCpu.toFixed(1)}%, Memory: ${clusterAvg.avgMemory.toFixed(1)}%`);
        
        // Check optional hard cluster size ceiling (if configured)
        if (maxClusterSize > 0 && clusterAvg.totalCount >= maxClusterSize) {
            console.warn(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Max cluster size ceiling reached (${clusterAvg.totalCount}/${maxClusterSize}). Scaling up CANCELLED.`);
            return false;
        }

        const isClusterOverloaded = clusterAvg.avgCpu >= scaleUpCpu || clusterAvg.avgMemory >= targetMemory;

        if (!isClusterOverloaded) {
            console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Remaining cluster has adequate capacity. Cordoning will rebalance traffic. Scaling up CANCELLED.`);
            return false;
        }
    } else {
        console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Server telemetries unavailable in DB. Proceeding with node-based scaling decision.`);
    }

    console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Average cluster threshold met. Scaling up authorized.`);
    return true;
}

/**
 * Queries the shared servers directory database to ensure we can safely remove this node 
 * without bringing the remaining active nodes below our configured minimum bounds
 * and verifies that redistributing all load across remaining nodes will not breach thresholds.
 * 
 * @param {Object} telemetry - Current telemetry snapshot
 * @returns {boolean} Verified consensus state allowing scale-down
 */
async function isClusterSafeToScaleDown(telemetry) {
    if (!server?.crud) {
        console.warn("[@cocreate/server-autoscaler] Database access layer is unavailable. Scaling down rejected.");
        return false;
    }

    const minSize = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.minClusterSize'), 10) || defaults.minClusterSize;
    const scaleUpCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleUpCpuThreshold'), 10) || defaults.scaleUpCpuThreshold;
    const targetMemory = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleUpMemoryThreshold'), 10) || defaults.scaleUpMemoryThreshold;

    const clusterData = await getClusterLatestFlushAverages();

    if (!clusterData || clusterData.totalCount <= 1) {
        console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Scale-down rejected. Insufficient active nodes found.`);
        return false;
    }

    if (clusterData.totalCount <= minSize) {
        console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Scale-down rejected. Active nodes (${clusterData.totalCount}) is already at or below the minimum cluster limit (${minSize}).`);
        return false;
    }

    // Calculate projected load on remaining nodes if this node is removed
    const remainingCount = clusterData.totalCount - 1;
    const projectedCpu = clusterData.totalCpu / remainingCount;
    const projectedMemory = clusterData.totalMem / remainingCount;

    console.log(`[@cocreate/server-autoscaler] [SCALE DOWN CHECK] Projected remaining cluster load (${remainingCount} servers) -> CPU: ${projectedCpu.toFixed(1)}%, Memory: ${projectedMemory.toFixed(1)}%`);

    if (projectedCpu >= scaleUpCpu || projectedMemory >= targetMemory) {
        console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Scale-down rejected. Removing this node would push remaining cluster load above scale-up thresholds.`);
        return false;
    }

    console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Average cluster threshold met for scale-down. Scale-down authorized. Node marked for scale down.`);
    return true;
}

/**
 * Triggers external cloud infrastructure provisioning APIs to add or remove node instances.
 * Incorporates geographic edge targeting metadata when scale-up is requested.
 * 
 * @param {string} action - 'up' or 'down'
 * @param {Object} telemetry - Telemetry context frame
 * @param {Object} meta - Optional metadata specs
 */
async function executeScaleAction(action, telemetry, meta = {}) {
    // If scaling up, calculate optimal edge geographic region based on active client density
    if (action === 'up') {
        const clients = Array.from(
            server?.wsManager?.clients?.values() ?? [], 
            client => client?.clientInfo
        ).filter(Boolean);
        
        const geoTarget = getCloudProvider(clients, autoscaleConfig);    
        if (geoTarget) {
            meta.geo = geoTarget;
            console.log(`[@cocreate/server-autoscaler] Geo-Scaling active. Requesting provision in region: ${geoTarget.targetRegion}`);
        }
    }

    console.log(`[@cocreate/server-autoscaler] Requesting infrastructure scale-${action.toUpperCase()}...`, meta);

    // Emit event across server event bus for infrastructure orchestrator
    if (server?.emit) {
        server.emit('telemetry.scaleAction', {
            action,
            telemetry,
            meta,
            timestamp: Date.now()
        });
    }
}

/**
 * Processes telemetry frame payloads.
 * - Memory evaluated INSTANTLY on every TICK to protect against sudden heap OOM crashes.
 * - CPU evaluated across SUSTAINED FLUSHES to avoid over-provisioning on transient spikes.
 * - Scale down evaluated across DEBOUNCED LOW FLUSHES (default 60% CPU / 60% Memory over 10 flushes).
 * 
 * @param {Object} telemetry - Telemetry frame payload received on tick or flush dispatch
 */
async function processTelemetryFrame(telemetry) {
    if (!isRunning) return;

    const scaleUpCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleUpCpuThreshold'), 10) || defaults.scaleUpCpuThreshold;
    const scaleDownCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleDownCpuThreshold'), 10) || defaults.scaleDownCpuThreshold;
    const targetMemoryThreshold = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleUpMemoryThreshold'), 10) || defaults.scaleUpMemoryThreshold;
    const scaleDownMemory = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleDownMemoryThreshold'), 10) || defaults.scaleDownMemoryThreshold;
    const spikesRequired = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.consecutiveCpuSpikesRequired'), 10) || defaults.consecutiveCpuSpikesRequired;
    const lowFlushesRequired = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.consecutiveLowFlushesRequired'), 10) || defaults.consecutiveLowFlushesRequired;

    const cpuAvg = telemetry.cpu?.avg || 0;
    const memoryAvg = telemetry.memory?.avg_used_pct || 0;

    // TRACK 1: INSTANT PER-TICK MEMORY EVALUATION
    // Memory is incompressible — if memory peaks on a tick, cordoning & scale verification must trigger IMMEDIATELY
    const isMemoryPeaked = memoryAvg >= targetMemoryThreshold;

    if (isMemoryPeaked) {
        console.warn(`[@cocreate/server-autoscaler] [INSTANT TICK] Memory threshold exceeded (${memoryAvg}% >= limit: ${targetMemoryThreshold}%). Triggering immediate worker cordon & scale evaluation...`);
        
        cordonWorkerNode(telemetry);

        const authorized = await shouldScaleUpCluster(telemetry);
        if (authorized) {
            consecutiveCpuSpikes = 0;
            await executeScaleAction('up', telemetry, { spec: 'memory-optimized', trigger: 'memory-instant-tick' });
        }
        return;
    }

    // TRACK 2: SUSTAINED FLUSH-BASED CPU EVALUATION
    // CPU is bursty — CPU requires consecutive flushes above threshold before triggering scale actions
    if (cpuAvg >= scaleUpCpu) {
        consecutiveCpuSpikes++;
        consecutiveLowLoadFlushes = 0; 
    } else {
        consecutiveCpuSpikes = 0; 
    }

    const isUnderloaded = cpuAvg <= scaleDownCpu && memoryAvg <= scaleDownMemory;

    if (isUnderloaded) {
        consecutiveLowLoadFlushes++;
    } else {
        consecutiveLowLoadFlushes = 0;
    }

    const isCpuSustainedPeak = consecutiveCpuSpikes >= spikesRequired;

    if (isCpuSustainedPeak) {
        console.warn(`[@cocreate/server-autoscaler] [SUSTAINED FLUSH] Sustained CPU threshold exceeded for ${consecutiveCpuSpikes} consecutive flushes (${cpuAvg}% >= limit: ${scaleUpCpu}%). Triggering worker cordon & scale evaluation...`);

        cordonWorkerNode(telemetry);

        const authorized = await shouldScaleUpCluster(telemetry);
        if (authorized) {
            consecutiveCpuSpikes = 0; 
            await executeScaleAction('up', telemetry, { spec: 'compute-optimized', trigger: 'cpu-sustained-flushes' });
        }
        return;
    }

    // TRACK 3: SCALE DOWN EVALUATION (SUSTAINED LOW LOAD ACROSS FLUSHES)
    if (consecutiveLowLoadFlushes >= lowFlushesRequired) {
        console.log(`[@cocreate/server-autoscaler] Low load sustained for ${consecutiveLowLoadFlushes} consecutive flushes. Checking cluster state to verify consensus...`);
        
        const safeToScaleDown = await isClusterSafeToScaleDown(telemetry);
        if (safeToScaleDown) {
            consecutiveLowLoadFlushes = 0; 
            
            console.log(`[@cocreate/server-autoscaler] Safe-down consensus verified. Scaling down...`);
            await executeScaleAction('down', telemetry);
        } else {
            consecutiveLowLoadFlushes = Math.round(lowFlushesRequired / 2); 
        }
    }
}

/**
 * Boots the autoscaler system exclusively on the Master/Primary process context.
 * 
 * @param {Object} serverInstance - Central CoCreateServer instance references
 * @returns {Object} Active autoscale control API
 */
export async function init(serverInstance) {
    server = serverInstance;
    
    if (!isMaster) {
        console.log('[@cocreate/server-autoscaler] Autoscaler initialized on worker node (Standby).');
        return;
    }

    try {
        autoscaleConfig = await Config.get('autoscale');
    } catch (e) {
        console.warn('[@cocreate/server-autoscaler] Failed to load config, falling back to defaults.', e.message);
        autoscaleConfig = {};
    }

    const isEnabled = getValueFromObject(autoscaleConfig, 'autoscale.enabled') !== false && getValueFromObject(autoscaleConfig, 'autoscale.enabled') !== 'false';

    if (!isEnabled) {
        console.log('[@cocreate/server-autoscaler] Autoscaling is disabled by configuration.');
        return;
    }

    isRunning = true;

    // Subscribe to incoming telemetry frame dispatches published by server-telemetry.js
    server.on('telemetry', (telemetry) => {
        processTelemetryFrame(telemetry);
    });

    console.log('[@cocreate/server-autoscaler] Initialized and listening for telemetry on Master node.');
}

/**
 * Halts any active autoscaler processing
 */
export function stop() {
    isRunning = false;
    console.log('[@cocreate/server-autoscaler] Execution loop halted.');
}

export default { 
    init, 
    stop 
};