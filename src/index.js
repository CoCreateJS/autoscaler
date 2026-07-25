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
    // HORIZONTAL THRESHOLDS & SCALE OUT
    scaleOut: {
        cpuThreshold: 85,          // % CPU trigger
        memoryThreshold: 85,       // % Memory trigger
        consecutiveFlushes: 3,     // Sustained load required
        maxClusterSize: 0          // Global ceiling (0 = uncapped)
    },

    // SCALE IN THRESHOLDS & STRATEGY
    scaleIn: {
        cpuThreshold: 10,          // % CPU low load trigger
        memoryThreshold: 45,       // % Memory low load trigger
        consecutiveFlushes: 10,    // Sustained low load (~10 min window)
        preservation: "continent", // "global" | "continent" | "country" | "region"
        minClusterSize: 2,         // Minimum cluster floor
        decommissionStrategy: "local" // "local" (autonomous self-decommissioning) | "oldest" (target oldest idle node)
    },

    // GEO-SCALING & EDGE SHEDDING
    geoScale: {
        enabled: true,
        sheddingThreshold: 20,     // % unserved traffic required to spawn edge node
        densityBy: "continent"     // "continent" | "country" | "region"
    },

    // REGIONAL VERTICAL TIERING
    vertical: {
        enabled: true,
        maxNodesPerTier: 2,        // Up to 2 horizontal nodes per tier in a region before stepping up to next tier
        tiers: [
            { name: "nano",    vCPU: 1,  memoryGb: 2 },
            { name: "small",   vCPU: 2,  memoryGb: 8 },
            { name: "medium",  vCPU: 4,  memoryGb: 16 },
            { name: "large",   vCPU: 8,  memoryGb: 32 },
            { name: "xlarge",  vCPU: 16, memoryGb: 64 },
            { name: "2xlarge", vCPU: 32, memoryGb: 128 },
            { name: "4xlarge", vCPU: 64, memoryGb: 256 }
        ]
    }
};

/**
 * Queries the database via CRUD for active servers matching given filter query where master is running.
 * Accepts optional query parameters to target specific geographic zones or regions.
 * 
 * @param {Object} [query={}] - Optional query filters to merge with default master status
 * @returns {Object|null} Cluster snapshot including averages and raw active servers array
 */
async function getClusterDetails(query = {}) {
    try {
        // Query servers array for active servers where master is running
        const readResponse = await server.crud.send({
            method: 'object.read',
            array: 'servers',
            $filter: {
                query: {
                    'master.status': 'running',
                    ...query
                }
            },
            organization_id: server.organization_id,
            host: server.host
        });

        const activeServers = Array.isArray(readResponse?.object) ? readResponse.object : [];
        if (activeServers.length === 0) return null;

        let totalCpu = 0;
        let totalMem = 0;

        for (const serverRecord of activeServers) {
            const peerTelemetry = serverRecord.telemetry;
            totalCpu += peerTelemetry?.cpu?.totalUsage || 0;
            totalMem += peerTelemetry?.memory?.percentage || 0;
        }

        const count = activeServers.length;

        return {
            avgCpu: totalCpu / count,
            avgMemory: totalMem / count,
            totalCpu,
            totalMem,
            totalCount: count,
            servers: activeServers // Raw active server array from database
        };
    } catch (err) {
        console.error("[@cocreate/server-autoscaler] Error querying cluster details from DB:", err.message);
        return null;
    }
}

/**
 * Validates whether scaling out is necessary by checking Node-level average first,
 * followed by single-flush Cluster capacity from active server records in the database.
 * Also enforces maxClusterSize if explicitly configured (> 0).
 * 
 * @param {Object} telemetry - Telemetry payload frame
 * @returns {boolean} True if scaling out is authorized, False if cordoning alone is sufficient or max cap reached
 */
async function shouldScaleOutCluster(telemetry) {
    const scaleOutCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleOut.cpuThreshold'), 10) || defaults.scaleOut.cpuThreshold;
    const targetMemory = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleOut.memoryThreshold'), 10) || defaults.scaleOut.memoryThreshold;
    const maxClusterSize = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleOut.maxClusterSize'), 10) || defaults.scaleOut.maxClusterSize;

    // STEP 1: Evaluate local Node average across workers
    const nodeAvg = calculateNodeAverage(telemetry);
    console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 1] Node Average -> CPU: ${nodeAvg.avgCpu.toFixed(1)}%, Memory: ${nodeAvg.avgMemory.toFixed(1)}%`);

    const isNodeOverloaded = nodeAvg.avgCpu >= scaleOutCpu || nodeAvg.avgMemory >= targetMemory;

    if (!isNodeOverloaded) {
        console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 1] Node average is below thresholds. Cordoning worker is sufficient. Scaling out CANCELLED.`);
        return false;
    }

    // STEP 2: Evaluate Cluster capacity across all running servers in DB
    console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Node is overloaded. Querying DB for active cluster details...`);
    const clusterData = await getClusterDetails();

    if (clusterData && clusterData.totalCount > 0) {
        console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Cluster Average (${clusterData.totalCount} servers) -> CPU: ${clusterData.avgCpu.toFixed(1)}%, Memory: ${clusterData.avgMemory.toFixed(1)}%`);
        
        // Check optional hard cluster size ceiling (if configured)
        if (maxClusterSize > 0 && clusterData.totalCount >= maxClusterSize) {
            console.warn(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Max cluster size ceiling reached (${clusterData.totalCount}/${maxClusterSize}). Scaling out CANCELLED.`);
            return false;
        }

        const isClusterOverloaded = clusterData.avgCpu >= scaleOutCpu || clusterData.avgMemory >= targetMemory;

        if (!isClusterOverloaded) {
            console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Remaining cluster has adequate capacity. Cordoning will rebalance traffic. Scaling out CANCELLED.`);
            return false;
        }
    } else {
        console.log(`[@cocreate/server-autoscaler] [EVALUATION TIER 2] Server telemetries unavailable in DB. Proceeding with node-based scaling decision.`);
    }

    return true;
}

/**
 * Evaluates whether it is safe for a node to scale in.
 * Verifies global minimum limits, regional preservation, and projected cluster capacity.
 * 
 * @param {Object} telemetry - Telemetry context frame
 * @returns {boolean} True if node scale-in is authorized
 */
async function shouldScaleInCluster(telemetry) {
    const minSize = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleIn.minClusterSize'), 10) || defaults.scaleIn.minClusterSize;
    const scaleOutCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleOut.cpuThreshold'), 10) || defaults.scaleOut.cpuThreshold;
    const targetMemory = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleOut.memoryThreshold'), 10) || defaults.scaleOut.memoryThreshold;
    const preservation = getValueFromObject(autoscaleConfig, 'autoscale.scaleIn.preservation') ?? defaults.scaleIn.preservation;

    // Evaluate geographic preservation if enabled ("continent" | "country" | "region")
    if (preservation && preservation !== "global") {
        const localZone = server?.location?.[preservation] || server?.[preservation];
        if (localZone) {
            // Targeted query for active servers in this node's geographic zone
            const zoneClusterData = await getClusterDetails({
                [`location.${preservation}`]: localZone
            });

            if (!zoneClusterData || zoneClusterData.totalCount <= 1) {
                console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Scale-in rejected. Removing this node would leave '${localZone}' with no active nodes (Preservation: ${preservation}).`);
                return false;
            }
        }
    }

    const clusterData = await getClusterDetails();

    if (!clusterData || clusterData.totalCount <= 1) {
        console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Scale-in rejected. Insufficient active nodes found.`);
        return false;
    }

    if (clusterData.totalCount <= minSize) {
        console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Scale-in rejected. Active nodes (${clusterData.totalCount}) is already at or below the minimum cluster limit (${minSize}).`);
        return false;
    }

    // Calculate projected load on remaining nodes if this node is removed
    const remainingCount = clusterData.totalCount - 1;
    const projectedCpu = clusterData.totalCpu / remainingCount;
    const projectedMemory = clusterData.totalMem / remainingCount;

    console.log(`[@cocreate/server-autoscaler] [SCALE IN CHECK] Projected remaining cluster load (${remainingCount} servers) -> CPU: ${projectedCpu.toFixed(1)}%, Memory: ${projectedMemory.toFixed(1)}%`);

    if (projectedCpu >= scaleOutCpu || projectedMemory >= targetMemory) {
        console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Scale-in rejected. Removing this node would push remaining cluster load above scale-out thresholds.`);
        return false;
    }

    console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Average cluster threshold met for scale-in. Scale-in authorized. Node marked for scale in.`);
    return true;
}

/**
 * Triggers external cloud infrastructure provisioning APIs to add or remove node instances.
 * Incorporates geographic edge targeting metadata and maxNodesPerTier vertical tier checks.
 * 
 * @param {string} action - 'out' or 'in'
 * @param {Object} telemetry - Telemetry context frame
 * @param {Object} meta - Optional metadata specs
 */
async function executeScaleAction(action, telemetry, meta = {}) {
    // If scaling out, calculate target region and determine spec tier using maxNodesPerTier
    if (action === 'out') {
        const clients = Array.from(
            server?.wsManager?.clients?.values() ?? [], 
            client => client?.clientInfo
        ).filter(Boolean);
        
        const geoTarget = getCloudProvider(clients, autoscaleConfig);    
        if (geoTarget) {
            meta.geo = geoTarget;
            console.log(`[@cocreate/server-autoscaler] Geo-Scaling active. Requesting provision in region: ${geoTarget.targetRegion}`);
        }

        // Check regional tier counts against maxNodesPerTier to decide whether to upgrade tier
        const maxNodesPerTier = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.vertical.maxNodesPerTier'), 10) || defaults.vertical.maxNodesPerTier;
        const tiers = getValueFromObject(autoscaleConfig, 'autoscale.vertical.tiers') || defaults.vertical.tiers;
        
        const targetRegion = geoTarget?.targetRegion || server?.infrastructure?.region || 'default-region';
        
        // Targeted query for servers in the specific target infrastructure region
        const regionalClusterData = await getClusterDetails({
            'infrastructure.region': targetRegion
        });

        if (regionalClusterData && Array.isArray(regionalClusterData.servers)) {
            const regionalTierCounts = {};
            for (const serverRecord of regionalClusterData.servers) {
                const peerTelemetry = serverRecord.telemetry;
                const vCPU = peerTelemetry?.cpu?.cores?.length || serverRecord.totalWorkers || 1;
                const memoryTotalBytes = peerTelemetry?.memory?.total || 0;
                const memoryGb = memoryTotalBytes > 0 ? Math.round(memoryTotalBytes / (1024 * 1024 * 1024)) : 2;

                const tier = matchTierName(vCPU, memoryGb);
                regionalTierCounts[tier] = (regionalTierCounts[tier] || 0) + 1;
            }

            let selectedTier = tiers[0]; // Start at smallest tier (e.g., nano)

            for (const tierSpec of tiers) {
                const countAtTier = regionalTierCounts[tierSpec.name] || 0;
                if (countAtTier < maxNodesPerTier) {
                    selectedTier = tierSpec;
                    break;
                }
                // If maxNodesPerTier reached, step up to next tier spec
                selectedTier = tierSpec;
            }

            meta.tier = selectedTier;
            console.log(`[@cocreate/server-autoscaler] Vertical Tiering selected spec '${selectedTier.name}' (${selectedTier.vCPU} vCPU, ${selectedTier.memoryGb} GB RAM) for region '${targetRegion}'.`);
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
 * - Scale down evaluated across DEBOUNCED LOW FLUSHES.
 * 
 * @param {Object} telemetry - Telemetry frame payload received on tick or flush dispatch
 */
async function processTelemetryFrame(telemetry) {
    if (!isRunning) return;

    const scaleOutCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleOut.cpuThreshold'), 10) || defaults.scaleOut.cpuThreshold;
    const scaleInCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleIn.cpuThreshold'), 10) || defaults.scaleIn.cpuThreshold;
    const targetMemoryThreshold = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleOut.memoryThreshold'), 10) || defaults.scaleOut.memoryThreshold;
    const scaleInMemory = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleIn.memoryThreshold'), 10) || defaults.scaleIn.memoryThreshold;
    const spikesRequired = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleOut.consecutiveFlushes'), 10) || defaults.scaleOut.consecutiveFlushes;
    const lowFlushesRequired = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleIn.consecutiveFlushes'), 10) || defaults.scaleIn.consecutiveFlushes;

    const cpuAvg = telemetry.cpu?.totalUsage || 0;
    const memoryAvg = telemetry.memory?.percentage || 0;

    // TRACK 1: INSTANT PER-TICK MEMORY EVALUATION
    const isMemoryPeaked = memoryAvg >= targetMemoryThreshold;

    if (isMemoryPeaked) {
        console.warn(`[@cocreate/server-autoscaler] [INSTANT TICK] Memory threshold exceeded (${memoryAvg}% >= limit: ${targetMemoryThreshold}%). Triggering immediate worker cordon & scale evaluation...`);
        
        cordonWorkerNode(telemetry);

        const authorized = await shouldScaleOutCluster(telemetry);
        if (authorized) {
            consecutiveCpuSpikes = 0;
            await executeScaleAction('out', telemetry, { spec: 'memory-optimized', trigger: 'memory-instant-tick' });
        }
        return;
    }

    // TRACK 2: SUSTAINED FLUSH-BASED CPU EVALUATION
    if (cpuAvg >= scaleOutCpu) {
        consecutiveCpuSpikes++;
        consecutiveLowLoadFlushes = 0; 
    } else {
        consecutiveCpuSpikes = 0; 
    }

    const isUnderloaded = cpuAvg <= scaleInCpu && memoryAvg <= scaleInMemory;

    if (isUnderloaded) {
        consecutiveLowLoadFlushes++;
    } else {
        consecutiveLowLoadFlushes = 0;
    }

    const isCpuSustainedPeak = consecutiveCpuSpikes >= spikesRequired;

    if (isCpuSustainedPeak) {
        console.warn(`[@cocreate/server-autoscaler] [SUSTAINED FLUSH] Sustained CPU threshold exceeded for ${consecutiveCpuSpikes} consecutive flushes (${cpuAvg}% >= limit: ${scaleOutCpu}%). Triggering worker cordon & scale evaluation...`);

        cordonWorkerNode(telemetry);

        const authorized = await shouldScaleOutCluster(telemetry);
        if (authorized) {
            consecutiveCpuSpikes = 0; 
            await executeScaleAction('out', telemetry, { spec: 'compute-optimized', trigger: 'cpu-sustained-flushes' });
        }
        return;
    }

    // TRACK 3: SCALE IN EVALUATION (SUSTAINED LOW LOAD ACROSS FLUSHES)
    if (consecutiveLowLoadFlushes >= lowFlushesRequired) {
        console.log(`[@cocreate/server-autoscaler] Low load sustained for ${consecutiveLowLoadFlushes} consecutive flushes. Checking cluster state to verify consensus...`);
        
        const safeToScaleIn = await shouldScaleInCluster(telemetry);
        if (safeToScaleIn) {
            consecutiveLowLoadFlushes = 0; 
            
            console.log(`[@cocreate/server-autoscaler] Safe-in consensus verified. Scaling in...`);
            await executeScaleAction('in', telemetry);
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