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
const isPrimary = cluster.isPrimary;

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
        min: { vCPU: 1, memoryGb: 2 },
        max: { vCPU: 64, memoryGb: 256 }
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
        filter: {
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
 * Evaluates the vertical tiering policy and determines the target resource requirements
 * for scaling out in a region. After maxNodesPerTier nodes exist at the current size,
 * the next size doubles vCPU and memory without exceeding the configured maximum.
 * 
 * @param {string} targetRegion - Target region identifier (e.g. 'us-east-1')
 * @param {Array<Object>} activeClusterServers - Active servers running in cluster
 * @returns {Object} Target tier specifications { vCPU, memoryGb, tierIndex }
 */
function determineTargetTier(targetRegion, activeClusterServers) {
    const isVerticalEnabled = getValueFromObject(autoscaleConfig, 'vertical.enabled');
    const minimum = getValueFromObject(autoscaleConfig, 'vertical.min') || {};
    const maximum = getValueFromObject(autoscaleConfig, 'vertical.max') || {};
    const minTier = {
        vCPU: Math.max(1, Number(minimum.vCPU) || 1),
        memoryGb: Math.max(1, Number(minimum.memoryGb) || 2)
    };
    const maxTier = {
        vCPU: Math.max(minTier.vCPU, Number(maximum.vCPU) || 64),
        memoryGb: Math.max(minTier.memoryGb, Number(maximum.memoryGb) || 256)
    };
    const maxNodesPerTier = Math.max(
        1,
        parseInt(getValueFromObject(autoscaleConfig, 'vertical.maxNodesPerTier'), 10) || 2
    );

    if (!isVerticalEnabled) {
        return { ...minTier, tierIndex: 0 };
    }

    const regionalServers = activeClusterServers.filter((serverNode) =>
        serverNode.region === targetRegion ||
        serverNode.infrastructure?.region === targetRegion ||
        serverNode.location?.region === targetRegion
    );

    if (regionalServers.length === 0) {
        return { ...minTier, tierIndex: 0 };
    }

    const nodeTiers = regionalServers.map((serverNode) => {
        const infrastructure = serverNode.infrastructure || {};
        const provider = serverNode.provider || infrastructure.provider;
        const instanceType = serverNode.instanceType || serverNode.vmType || infrastructure.vmType;
        const providerInstances = getValueFromObject(
            autoscaleConfig,
            `clouds.${provider}.instances`
        ) || [];
        const instance = providerInstances.find(({ name }) => name === instanceType);

        return {
            vCPU: Math.min(
                maxTier.vCPU,
                Math.max(
                    minTier.vCPU,
                    Number(serverNode.vCPU || infrastructure.vCPU || instance?.vCPU) || minTier.vCPU
                )
            ),
            memoryGb: Math.min(
                maxTier.memoryGb,
                Math.max(
                    minTier.memoryGb,
                    Number(serverNode.memoryGb || infrastructure.memoryGb || instance?.memoryGb) || minTier.memoryGb
                )
            )
        };
    });
    const currentTier = [...nodeTiers].sort((a, b) =>
        b.vCPU - a.vCPU || b.memoryGb - a.memoryGb
    )[0];
    const nodesAtCurrentTier = nodeTiers.filter(({ vCPU, memoryGb }) =>
        vCPU === currentTier.vCPU && memoryGb === currentTier.memoryGb
    ).length;
    const currentTierIndex = Math.max(
        Math.ceil(Math.log2(currentTier.vCPU / minTier.vCPU)),
        Math.ceil(Math.log2(currentTier.memoryGb / minTier.memoryGb)),
        0
    );

    if (nodesAtCurrentTier < maxNodesPerTier) {
        return { ...currentTier, tierIndex: currentTierIndex };
    }

    const nextTier = {
        vCPU: Math.min(maxTier.vCPU, currentTier.vCPU * 2),
        memoryGb: Math.min(maxTier.memoryGb, currentTier.memoryGb * 2)
    };
    const nextTierIndex = currentTierIndex + (
        nextTier.vCPU !== currentTier.vCPU || nextTier.memoryGb !== currentTier.memoryGb ? 1 : 0
    );
    console.log(`[@cocreate/server-autoscaler] [VERTICAL TIERING] Region [${targetRegion}] reached ${nodesAtCurrentTier}/${maxNodesPerTier} nodes at tier ${currentTierIndex}. Stepping up to tier ${nextTierIndex} (${nextTier.vCPU} vCPU, ${nextTier.memoryGb}GB RAM).`);

    return { ...nextTier, tierIndex: nextTierIndex };
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
    const configuredStrategy = getValueFromObject(autoscaleConfig, 'scaleIn.decommissionStrategy');
    const strategy = configuredStrategy === "local" ? "local" : "oldest";

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

    let candidateServer;

    if (strategy === "local") {
        candidateServer = activeServers.find(({ _id }) => String(_id) === String(server.id));
    } else {
        const createdTime = (serverRecord) => {
            const timestamp = new Date(
                serverRecord.created?.on || serverRecord.createdAt || serverRecord.created
            ).getTime();
            if (Number.isFinite(timestamp)) return timestamp;

            const id = String(serverRecord._id || "");
            return /^[a-f\d]{24}$/i.test(id)
                ? parseInt(id.slice(0, 8), 16) * 1000
                : Number.MAX_SAFE_INTEGER;
        };

        candidateServer = [...activeServers].sort((a, b) =>
            createdTime(a) - createdTime(b) ||
            String(a._id || "").localeCompare(String(b._id || ""))
        )[0];
    }

    if (!candidateServer) {
        return {
            canScaleIn: false,
            reason: strategy === "local"
                ? `Local server '${server.id}' was not found among the active cluster nodes.`
                : "No eligible active server was found for scale-in.",
            candidateServer: null,
            activeCount: activeServers.length,
            minClusterSize: minSize,
            decommissionStrategy: strategy
        };
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
