/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
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
import config from '@cocreate/config';
import { getValueFromObject, dotNotationToObject } from '@cocreate/utils';
import { getCloudProvider } from './geoScaling.js';

// Guard clause verification to ensure cluster API abstraction integrity
const isPrimary = cluster.isPrimary || cluster.isMaster;

let server = null;

let autoscaleConfig = {
    clouds: {},
    scaleOut: {
        cpuThreshold: 85,
        memoryThreshold: 85,
        consecutiveFlushes: 3,
        maxClusterSize: 0
    },
    scaleIn: {
        cpuThreshold: 10,
        memoryThreshold: 45,
        consecutiveFlushes: 10,
        preservation: "continent",
        minClusterSize: 2,
        decommissionStrategy: "oldest"
    },
    geoScale: {
        enabled: true,
        sheddingThreshold: 20,
        densityBy: "continent"
    },
    vertical: {
        enabled: true,
        maxNodesPerTier: 2,
        tiers: [
            { vCPU: 1, memoryGb: 2 },
            { vCPU: 2, memoryGb: 8 },
            { vCPU: 4, memoryGb: 16 },
            { vCPU: 8, memoryGb: 32 },
            { vCPU: 16, memoryGb: 64 },
            { vCPU: 32, memoryGb: 128 },
            { vCPU: 64, memoryGb: 256 }
        ]
    }
};

/**
 * Loads system configuration using @cocreate/config, queries the database's 'servers_config'
 * collection via config.query for matching 'autoscaler' entries, and processes standard
 * objects as well as dot-notation paths using `dotNotationToObject`.
 * 
 * Autoscaler is the sole module responsible for loading and resolving configuration early
 * in the pipeline before passing the resolved object to downstream modules like GeoScaling.
 * 
 * @returns {Promise<Object>} The resolved autoscale configuration
 */
export async function loadAutoscaleConfig() {
    const sysConfig = await config.get('autoscaler');

    const dbConfig = await config.query({
        type: 'autoscaler',
        organization_id: server.organization_id,
        server: server.host,
        cluster: server.cluster_id
    });

    // Expand & merge system configuration directly into autoscaleConfig
    if (sysConfig) {
        dotNotationToObject(autoscaleConfig, sysConfig);
    }

    // Expand & merge database overrides directly into autoscaleConfig
    if (dbConfig) {
        dotNotationToObject(autoscaleConfig, dbConfig);
    }

    return autoscaleConfig;
}

/**
 * Queries the database via CRUD for active servers matching given filter query where master is running.
 * 
 * @param {Object} [query={}] - Optional query filters to merge with default master status
 * @returns {Promise<Object>} Cluster snapshot including averages and raw active servers array
 */
async function getClusterDetails(query = {}) {
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

    const activeServers = readResponse.object || [];

    let totalCpu = 0;
    let totalMem = 0;

    for (const serverRecord of activeServers) {
        const peerTelemetry = serverRecord.telemetry || {};
        totalCpu += peerTelemetry.cpu?.totalUsage || 0;
        totalMem += peerTelemetry.memory?.percentage || 0;
    }

    const count = activeServers.length || 1;

    return {
        avgCpu: totalCpu / count,
        avgMemory: totalMem / count,
        totalCpu,
        totalMem,
        totalCount: activeServers.length,
        servers: activeServers
    };
}

/**
 * Evaluates the vertical tiering policy and determines the target tier requirements
 * (vCPU and Memory) for scaling in a given region based on current active nodes in that region.
 * 
 * @param {string} targetRegion - Target region identifier (e.g. 'us-east-1')
 * @param {Array<Object>} activeClusterServers - Active servers running in cluster
 * @returns {Object} Target tier specifications { vCPU, memoryGb, tierIndex }
 */
function determineTargetTier(targetRegion, activeClusterServers) {
    const isVerticalEnabled = getValueFromObject(autoscaleConfig, 'vertical.enabled');
    const tiers = getValueFromObject(autoscaleConfig, 'vertical.tiers');
    const maxNodesPerTier = parseInt(getValueFromObject(autoscaleConfig, 'vertical.maxNodesPerTier'), 10);

    if (!isVerticalEnabled) {
        return { ...tiers[0], tierIndex: 0 };
    }

    const regionalServers = activeClusterServers.filter(s => s.region === targetRegion || s.location?.region === targetRegion);

    if (regionalServers.length === 0) {
        return { ...tiers[0], tierIndex: 0 };
    }

    let currentTierIndex = 0;
    let nodesAtCurrentTier = 0;

    for (const serverNode of regionalServers) {
        const nodeCpu = serverNode.vCPU;
        const nodeMem = serverNode.memoryGb;

        const matchedIndex = tiers.findIndex(t => t.vCPU === nodeCpu && t.memoryGb === nodeMem);
        if (matchedIndex > currentTierIndex) {
            currentTierIndex = matchedIndex;
            nodesAtCurrentTier = 1;
        } else if (matchedIndex === currentTierIndex) {
            nodesAtCurrentTier++;
        }
    }

    if (nodesAtCurrentTier < maxNodesPerTier) {
        return { ...tiers[currentTierIndex], tierIndex: currentTierIndex };
    }

    const nextTierIndex = Math.min(currentTierIndex + 1, tiers.length - 1);
    console.log(`[@cocreate/server-autoscaler] [VERTICAL TIERING] Region [${targetRegion}] reached ${nodesAtCurrentTier}/${maxNodesPerTier} nodes at tier ${currentTierIndex}. Stepping up to tier ${nextTierIndex} (${tiers[nextTierIndex].vCPU} vCPU, ${tiers[nextTierIndex].memoryGb}GB RAM).`);

    return { ...tiers[nextTierIndex], tierIndex: nextTierIndex };
}

/**
 * Searches the provider's `instances` array (returned by geoScaling) for an instance name
 * that best matches or satisfies the target tier's vCPU and memory specifications.
 * 
 * @param {Array<Object>} instances - Instance catalog array from cloud provider config
 * @param {Object} targetTier - Target tier specifications { vCPU, memoryGb }
 * @returns {string} Matching instance type string (e.g. 't3a.medium', 'e2-standard-4')
 */
function selectInstanceType(instances = [], targetTier) {
    const requiredCpu = targetTier.vCPU;
    const requiredMem = targetTier.memoryGb;

    const exactMatch = instances.find(inst => inst.vCPU === requiredCpu && inst.memoryGb === requiredMem);
    if (exactMatch) {
        return exactMatch.name;
    }

    const suitable = instances
        .filter(inst => inst.vCPU >= requiredCpu && inst.memoryGb >= requiredMem)
        .sort((a, b) => (a.vCPU - b.vCPU) || (a.memoryGb - b.memoryGb));

    if (suitable.length > 0) {
        return suitable[0].name;
    }

    return instances[instances.length - 1]?.name || 'default';
}

/**
 * Calculates scale-out targeting details: provider, region, instanceType, vCPU, memoryGb,
 * datacenterName, countryCode, and geo latency metadata based on client traffic distribution.
 * 
 * @param {Array<Object>} clientLocations - Active client traffic distribution points
 * @returns {Promise<Object>} Target specification object calculated for scale-out
 */
export async function determineScaleOutTarget(clientLocations) {
    if (!autoscaleConfig) await loadAutoscaleConfig();

    const isGeoEnabled = getValueFromObject(autoscaleConfig, 'geoScale.enabled');
    const sheddingThreshold = getValueFromObject(autoscaleConfig, 'geoScale.sheddingThreshold');
    const preferredProviders = getValueFromObject(autoscaleConfig, 'preferredProviders');

    const geoTarget = await getCloudProvider(clientLocations, {
        geoScaleByContinent: isGeoEnabled,
        sheddingThreshold,
        preferredProviders,
        autoscaleConfig
    }, server);

    const cloudRegion = geoTarget.nearestCloudRegion;
    const provider = cloudRegion.provider;
    const region = cloudRegion.region;
    const providerInstances = cloudRegion.instances;

    const clusterData = await getClusterDetails();
    const activeServers = clusterData.servers;

    const targetTier = determineTargetTier(region, activeServers);
    const instanceType = selectInstanceType(providerInstances, targetTier);

    const result = {
        provider,
        region,
        instanceType,
        vCPU: targetTier.vCPU,
        memoryGb: targetTier.memoryGb,
        targetTier,
        datacenterName: cloudRegion.datacenterName,
        countryCode: cloudRegion.countryCode,
        coordinates: cloudRegion.coordinates,
        distanceKm: cloudRegion.distanceKm,
        geoScaleByContinent: geoTarget.geoScaleByContinent,
        targetContinent: geoTarget.targetContinent,
        isSheddingTarget: geoTarget.isSheddingTarget,
        targetPercentage: geoTarget.targetPercentage,
        totalActiveClients: geoTarget.totalActiveClients,
        timestamp: Date.now()
    };

    console.log("[@cocreate/server-autoscaler] Resolved scale-out target decision:", JSON.stringify(result, null, 2));
    return result;
}

/**
 * Triggers horizontal scale-out provisioning workflow:
 * 1. Computes optimal cloud provider, region, instance type, vCPU, memory, datacenter, and country code via determineScaleOutTarget.
 * 2. Fetches static configurations (spot, startupScript, os, application, create endpoint) directly from autoscaleConfig.
 * 3. Dispatches instance creation API call via server.api.send.
 * 
 * @param {Array<Object>} clientLocations - Active client traffic location points
 * @returns {Promise<Object>} API execution result payload
 */
export async function scaleOut(clientLocations) {
    if (!autoscaleConfig) await loadAutoscaleConfig();

    const target = await determineScaleOutTarget(clientLocations);
    const provider = target.provider;

    // Retrieve static provisioning configurations directly from autoscaleConfig
    const spot = getValueFromObject(autoscaleConfig, 'spot');
    const startupScript = getValueFromObject(autoscaleConfig, `clouds.${provider}.startupScript`) || getValueFromObject(autoscaleConfig, 'startupScript');
    const os = getValueFromObject(autoscaleConfig, `clouds.${provider}.os`) || getValueFromObject(autoscaleConfig, 'os');
    const application = getValueFromObject(autoscaleConfig, `clouds.${provider}.application`) || getValueFromObject(autoscaleConfig, 'application');
    const endpoint = getValueFromObject(autoscaleConfig, `clouds.${provider}.endpoint.create`);

    console.log(`[@cocreate/server-autoscaler] [SCALE-OUT] Sending instance creation API request for provider [${provider}] on endpoint [${endpoint}] in region [${target.region}]...`);

    const apiPayload = {
        method: provider,
        endpoint,
        organization_id: server.organization_id,
        host: server.host,
        [provider]: {
            provider: target.provider,
            region: target.region,
            instanceType: target.instanceType,
            vCPU: target.vCPU,
            memoryGb: target.memoryGb,
            datacenterName: target.datacenterName,
            countryCode: target.countryCode,
            cluster_id: server.cluster_id,
            spot,
            startupScript,
            os,
            application
        }
    };

    const response = await server.api.send(apiPayload);
    console.log("[@cocreate/server-autoscaler] [SCALE-OUT] API response received:", response);
    return response;
}

/**
 * Evaluates active cluster servers against autoscale scale-in policies to determine
 * which server candidate should be decommissioned (dry-run preview).
 * 
 * @param {Object} [options] - Optional override parameters
 * @returns {Promise<Object>} Evaluation result containing selected candidate server and reason
 */
export async function determineScaleInTarget(options) {
    if (!autoscaleConfig) await loadAutoscaleConfig();

    const minSize = getValueFromObject(autoscaleConfig, 'scaleIn.minClusterSize');
    const strategy = getValueFromObject(autoscaleConfig, 'scaleIn.decommissionStrategy');

    const clusterData = await getClusterDetails();
    const activeServers = clusterData.servers;

    if (activeServers.length <= minSize) {
        console.log(`[@cocreate/server-autoscaler] [SCALE-IN PREVIEW] Cannot scale in: Active nodes (${activeServers.length}) is at or below cluster floor (${minSize}).`);
        return {
            canScaleIn: false,
            reason: `Cluster size (${activeServers.length}) is at or below minimum floor (${minSize}).`,
            candidateServer: null,
            activeCount: activeServers.length,
            minClusterSize: minSize
        };
    }

    let candidateServer = null;

    if (strategy === "idle") {
        candidateServer = [...activeServers].sort((a, b) => {
            const loadA = (a.telemetry?.cpu?.totalUsage || 0) + (a.telemetry?.memory?.percentage || 0);
            const loadB = (b.telemetry?.cpu?.totalUsage || 0) + (b.telemetry?.memory?.percentage || 0);
            return loadA - loadB;
        })[0];
    } else {
        candidateServer = activeServers[activeServers.length - 1];
    }

    return {
        canScaleIn: true,
        reason: `Candidate node selected using strategy '${strategy}'.`,
        candidateServer,
        activeCount: activeServers.length,
        minClusterSize: minSize,
        decommissionStrategy: strategy
    };
}

/**
 * Triggers horizontal scale-in decommissioning workflow:
 * 1. Resolves target server candidate to scale in using determineScaleInTarget.
 * 2. Dispatches instance termination API call via server.api.send.
 * 
 * @param {Object} [targetServer] - Optional target server document to decommission
 * @returns {Promise<Object>} API execution result payload
 */
export async function scaleIn(targetServer) {
    let candidateServer = targetServer;

    if (!candidateServer) {
        const scaleInTarget = await determineScaleInTarget();
        candidateServer = scaleInTarget.candidateServer;
    }

    if (!candidateServer) {
        console.log("[@cocreate/server-autoscaler] [SCALE-IN] Aborted: No valid scale-in candidate server found.");
        return null;
    }

    const provider = candidateServer.provider;
    const vmId = candidateServer.vmId;

    // Retrieve delete endpoint directly from autoscaleConfig
    const endpoint = getValueFromObject(autoscaleConfig, `clouds.${provider}.endpoint.delete`);

    console.log(`[@cocreate/server-autoscaler] [SCALE-IN] Sending instance termination API request for provider [${provider}] on endpoint [${endpoint}] for node [${vmId}]...`);

    const apiPayload = {
        method: provider,
        endpoint,
        organization_id: server.organization_id,
        host: server.host,
        [provider]: {
            serverId: candidateServer._id,
            vmId: vmId,
            provider: provider,
            region: candidateServer.region
        }
    };

    const response = await server.api.send(apiPayload);
    console.log("[@cocreate/server-autoscaler] [SCALE-IN] API response received:", response);
    return response;
}

export async function init(serverInstance) {
    if (!isPrimary) {
        return;
    }

    server = serverInstance;
    await loadAutoscaleConfig();

    console.log("[@cocreate/server-autoscaler] [MASTER] Autoscaler service initialized successfully.");

    return {
        config: autoscaleConfig,
        scaleOut,
        determineScaleOutTarget,
        scaleIn,
        determineScaleInTarget
    };
}

export default {
    init
};