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
import { ObjectId, getValueFromObject, dotNotationToObject } from '@cocreate/utils';
import { getCloudProvider, loadCloudProviders } from './geoScaling.js';

// Guard clause verification to ensure cluster API abstraction integrity
const isPrimary = cluster.isPrimary;

let server = null;

let autoscaleConfig = {};
let allowedApis = [];
const workerStreaks = new Map();
let evaluating = false;
let lastActionAt = 0;
let floorLeader = null;
let lastFloorCheckAt = 0;

function isAutoscalingEnabled() {
    return getValueFromObject(autoscaleConfig, 'autoscaling.enabled') === true;
}

/**
 * Uses this server's cluster as the baseline, then applies matching system and
 * servers_config records in their configured order.
 * 
 * Autoscaler is the sole module responsible for loading and resolving configuration early
 * in the pipeline before passing the resolved object to downstream modules like GeoScaling.
 * 
 * @returns {Promise<Object>} The resolved autoscale configuration
 */
export async function loadAutoscaleConfig() {
    const resolved = {};
    if (server.id) {
        const response = await server.crud.send({
            method: 'object.read',
            array: 'servers',
            organization_id: server.organization_id,
            host: server.host,
            filter: { query: { _id: server.id }, limit: 1 }
        });
        server.cluster_id = response?.object?.[0]?.cluster_id || server.cluster_id;
    }
    if (server.cluster_id) {
        const response = await server.crud.send({
            method: 'object.read',
            array: 'clusters',
            organization_id: server.organization_id,
            host: server.host,
            filter: { query: { _id: server.cluster_id }, limit: 1 }
        });
        const clusterConfig = response?.object?.[0];
        if (clusterConfig) dotNotationToObject(clusterConfig, resolved);
    }

    const sysConfig = await config.get('autoscaler');

    const dbConfig = await config.query({
        type: ['startupscript', 'autoscaler'],
        organization_id: server.organization_id,
        server: server.host,
        cluster: server.cluster_id
    }, server.crud);

    // The cluster is the baseline; matching configs overwrite it in query order.
    if (sysConfig) dotNotationToObject(sysConfig, resolved);
    if (dbConfig) dotNotationToObject(dbConfig, resolved);

    const providerIds = resolved.providers;
    allowedApis = [];
    if (Array.isArray(providerIds) && providerIds.length) {
        const responses = await Promise.all(providerIds.map(id => server.crud.send({
            method: 'object.read',
            array: 'apis',
            organization_id: server.organization_id,
            host: server.host,
            filter: { query: { _id: id, type: 'cloud', enabled: true }, limit: 1 }
        })));
        allowedApis = responses.map(response => response?.object?.[0]).filter(Boolean);
    }

    autoscaleConfig = resolved;
    return resolved;
}

/**
 * Queries the database via CRUD for active servers matching given filter query where master is running.
 * 
 * @param {Object} [query={}] - Optional query filters to merge with default master status
 * @returns {Promise<Object>} Cluster snapshot including averages and raw active servers array
 */
async function getClusterDetails(query = {}, currentSample) {
    const readResponse = await server.crud.send({
        method: 'object.read',
        array: 'servers',
        filter: {
            query: {
                'master.status': 'running',
                ...query,
                cluster_id: server.cluster_id
            }
        },
        organization_id: server.organization_id,
        host: server.host
    });

    if (readResponse?.error?.length) throw new Error('Unable to read active cluster servers.');
    const activeServers = readResponse?.object || [];
    const pendingResponse = await server.crud.send({
        method: 'object.read',
        array: 'servers',
        filter: { query: { cluster_id: server.cluster_id, 'master.status': 'provisioning' }, limit: 0 },
        organization_id: server.organization_id,
        host: server.host
    });
    if (pendingResponse?.error?.length) throw new Error('Unable to read provisioning cluster servers.');
    const pendingCount = pendingResponse?.object?.length || 0;

    // Telemetry is written to its own collection, not embedded in servers.
    const interval = Number(currentSample?.interval_seconds) * 1000 || 60000;
    const since = new Date(Date.now() - interval * 2).toISOString();
    const ids = activeServers.map(item => String(item._id));
    const telemetryResponse = ids.length ? await server.crud.send({
        method: 'object.read',
        array: 'servers_telemetry',
        filter: {
            query: { serverId: { $in: ids }, timestamp: { $gte: since } },
            sort: [{ key: 'timestamp', direction: 'desc' }],
            limit: 0
        },
        organization_id: server.organization_id,
        host: server.host
    }) : null;
    if (telemetryResponse?.error?.length) throw new Error('Unable to read cluster telemetry.');
    const latestWorkers = new Map();
    for (const sample of telemetryResponse?.object || []) {
        const key = `${sample.serverId}:${sample.workerId}`;
        if (!latestWorkers.has(key)) latestWorkers.set(key, sample);
    }
    if (currentSample) {
        latestWorkers.set(`${currentSample.serverId}:${currentSample.workerId}`, currentSample);
    }
    const samples = [...latestWorkers.values()];
    const byServer = new Map();
    for (const sample of samples) {
        const id = String(sample.serverId);
        const entry = byServer.get(id) || { cpu: 0, memory: 0, workers: 0, timestamp: '' };
        entry.cpu += Number(sample.cpu?.avg || 0);
        entry.memory += Number(sample.memory?.avg_used_pct || 0);
        entry.workers++;
        if (!entry.timestamp || sample.timestamp < entry.timestamp) entry.timestamp = sample.timestamp;
        byServer.set(id, entry);
    }
    const serverMetrics = new Map([...byServer].map(([id, entry]) => [id, {
        cpu: entry.cpu / entry.workers,
        memory: entry.memory / entry.workers,
        timestamp: entry.timestamp
    }]));
    const totalCpu = samples.reduce((sum, item) => sum + Number(item.cpu?.avg || 0), 0);
    const totalMem = samples.reduce((sum, item) => sum + Number(item.memory?.avg_used_pct || 0), 0);
    const count = samples.length || 1;

    return {
        avgCpu: totalCpu / count,
        avgMemory: totalMem / count,
        totalCpu,
        totalMem,
        totalCount: activeServers.length,
        pendingCount,
        sampledServers: new Set(samples.map(item => String(item.serverId))).size,
        serverMetrics,
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
    const minimum = getValueFromObject(autoscaleConfig, 'vertical.min') || {};
    const maximum = getValueFromObject(autoscaleConfig, 'vertical.max') || {};
    const maxNodesPerTier = Number(getValueFromObject(autoscaleConfig, 'vertical.maxNodesPerTier'));
    if (![minimum.vCPU, minimum.memoryGb, maximum.vCPU, maximum.memoryGb, maxNodesPerTier]
        .every(value => Number.isFinite(Number(value)) && Number(value) > 0)) {
        throw new Error('Vertical scaling requires configured min, max, and maxNodesPerTier values.');
    }
    const minTier = {
        vCPU: Number(minimum.vCPU),
        memoryGb: Number(minimum.memoryGb)
    };
    const maxTier = {
        vCPU: Number(maximum.vCPU),
        memoryGb: Number(maximum.memoryGb)
    };
    if (maxTier.vCPU < minTier.vCPU || maxTier.memoryGb < minTier.memoryGb) {
        throw new Error('Vertical scaling maximum must be at least its minimum.');
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

    throw new Error(`No configured instance satisfies ${requiredCpu} vCPU and ${requiredMem} GB memory.`);
}

/**
 * Calculates scale-out targeting details: provider, region, instanceType, vCPU, memoryGb,
 * datacenterName, countryCode, and geo latency metadata based on client traffic distribution.
 * 
 * @param {Array<Object>} clientLocations - Active client traffic distribution points
 * @param {Array<Object>} [activeServers] - Cluster snapshot, fetched when omitted
 * @returns {Promise<Object>} Target specification object calculated for scale-out
 */
export async function determineScaleOutTarget(clientLocations, activeServers) {
    if (!isAutoscalingEnabled()) throw new Error('Autoscaling is disabled.');
    if (!server.cluster_id) throw new Error('Autoscaling requires a cluster ID.');
    if (!allowedApis.length) throw new Error('Autoscaling requires enabled cloud APIs in cluster providers.');

    const isGeoEnabled = getValueFromObject(autoscaleConfig, 'geoScale.enabled');
    const sheddingThreshold = getValueFromObject(autoscaleConfig, 'geoScale.sheddingThreshold');
    if (isGeoEnabled === true && !Number.isFinite(Number(sheddingThreshold))) {
        throw new Error('Geographic scaling requires a configured shedding threshold.');
    }
    const regions = loadCloudProviders(autoscaleConfig);
    const cloudProviders = allowedApis.flatMap(api =>
        regions.filter(region => region.provider === api.provider).map(region => ({
            ...region,
            provider: api.name,
            providerType: api.provider,
            apiId: api._id
        }))
    );

    const currentServers = activeServers ?? (await getClusterDetails()).servers;
    const geoTarget = await getCloudProvider(clientLocations, {
        geoScaleByContinent: isGeoEnabled,
        sheddingThreshold,
        cloudProviders,
        existingNodes: currentServers.map(item => ({
            continent: item.location?.continent || item.infrastructure?.continent
        })),
        autoscaleConfig
    });

    const cloudRegion = geoTarget?.nearestCloudRegion;
    if (!cloudRegion) throw new Error('No configured region matches the enabled cluster providers.');
    const provider = cloudRegion.provider;
    const providerType = cloudRegion.providerType;
    const region = cloudRegion.region;
    const providerInstances = cloudRegion.instances;

    const defaultInstance = providerInstances.find(instance => instance.default);
    if (defaultInstance && (![defaultInstance.vCPU, defaultInstance.memoryGb]
        .every(value => Number.isFinite(Number(value)) && Number(value) > 0))) {
        throw new Error(`The default instance for ${providerType} needs vCPU and memoryGb.`);
    }
    const targetTier = getValueFromObject(autoscaleConfig, 'vertical.enabled') === true
        ? determineTargetTier(region, currentServers)
        : defaultInstance && {
            vCPU: Number(defaultInstance.vCPU),
            memoryGb: Number(defaultInstance.memoryGb),
            tierIndex: 0
        };
    if (!targetTier) throw new Error(`No default instance is configured for ${providerType}.`);
    const instanceType = getValueFromObject(autoscaleConfig, 'vertical.enabled') === true
        ? selectInstanceType(providerInstances, targetTier)
        : defaultInstance.name;

    const result = {
        provider,
        providerType,
        apiId: cloudRegion.apiId,
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
 * @param {Array<Object>} [activeServers] - Cluster snapshot, fetched when omitted
 * @returns {Promise<Object>} API execution result payload
 */
export async function scaleOut(clientLocations, activeServers) {
    const target = await determineScaleOutTarget(clientLocations, activeServers);
    const provider = target.provider;
    const providerType = target.providerType;

    // Retrieve static provisioning configurations directly from autoscaleConfig
    const spot = getValueFromObject(autoscaleConfig, 'spot');
    const startupScript = getValueFromObject(autoscaleConfig, `clouds.${providerType}.startupScript`) || getValueFromObject(autoscaleConfig, 'startupScript');
    const os = getValueFromObject(autoscaleConfig, `clouds.${providerType}.os`) || getValueFromObject(autoscaleConfig, 'os');
    const application = getValueFromObject(autoscaleConfig, `clouds.${providerType}.application`) || getValueFromObject(autoscaleConfig, 'application');
    const endpoint = getValueFromObject(autoscaleConfig, `clouds.${providerType}.endpoint.create`) ||
        getValueFromObject(autoscaleConfig, 'endpoint.create');
    const method = getValueFromObject(autoscaleConfig, `clouds.${providerType}.method.create`);
    if (!endpoint) throw new Error(`No create endpoint is configured for ${providerType}.`);
    if (!startupScript) throw new Error('Scale-out requires a startup script.');
    const binaryUrl = getValueFromObject(autoscaleConfig, 'binaryUrl');
    const deploymentHost = getValueFromObject(autoscaleConfig, 'host') || server.host;
    if (!binaryUrl || !deploymentHost) {
        throw new Error('Scale-out requires a binary URL and deployment host.');
    }

    const storageId = getValueFromObject(autoscaleConfig, 'storage');
    if (typeof storageId !== 'string' || !storageId.trim()) {
        throw new Error('Scale-out requires the cluster storage API record ID.');
    }

    const serverId = ObjectId().toString();
    const newServer = {
        _id: serverId,
        cluster_id: server.cluster_id,
        api_id: target.apiId,
        host: server.host,
        totalWorkers: 0,
        master: { status: 'provisioning' },
        infrastructure: {
            api_id: target.apiId,
            provider: providerType,
            region: target.region,
            vmType: target.instanceType,
            vCPU: target.vCPU,
            memoryGb: target.memoryGb
        }
    };
    const created = await server.crud.send({
        method: 'object.create',
        array: 'servers',
        object: newServer,
        organization_id: server.organization_id,
        host: server.host
    });
    if (created?.error?.length || !created?.object?.length) {
        throw new Error('Unable to reserve a server record for scale-out.');
    }

    console.log(`[@cocreate/server-autoscaler] [SCALE-OUT] Sending instance creation API request for provider [${provider}] on endpoint [${endpoint}] in region [${target.region}]...`);

    const apiPayload = {
        api: provider,
        ...(method && { method }),
        endpoint,
        organization_id: server.organization_id,
        host: server.host,
        region: target.region,
        data: {
            provider: providerType,
            api_id: target.apiId,
            region: target.region,
            vmType: target.instanceType,
            vCPU: target.vCPU,
            memoryGb: target.memoryGb,
            datacenterName: target.datacenterName,
            countryCode: target.countryCode,
            cluster_id: server.cluster_id,
            server_id: serverId,
            host: deploymentHost,
            binaryUrl,
            environment: `server_id=${serverId}\ncluster_id=${server.cluster_id}`,
            storage: storageId,
            spot,
            startupScript,
            os,
            application
        }
    };

    try {
        const response = await server.api.send(apiPayload);
        if (response?.error?.length || response?.success === false) {
            throw new Error('The cloud API rejected the scale-out request.');
        }
        console.log(`[@cocreate/server-autoscaler] [SCALE-OUT] Provisioning server ${serverId}.`);
        return response;
    } catch (error) {
        await server.crud.send({
            method: 'object.update',
            array: 'servers',
            object: { _id: serverId, master: { status: 'failed' } },
            organization_id: server.organization_id,
            host: server.host
        });
        throw error;
    }
}

/**
 * Evaluates active cluster servers against autoscale scale-in policies to determine
 * which server candidate should be decommissioned (dry-run preview).
 * 
 * @param {Object} [options] - Optional override parameters
 * @returns {Promise<Object>} Evaluation result containing selected candidate server and reason
 */
export async function determineScaleInTarget(options) {
    if (!isAutoscalingEnabled()) {
        return { canScaleIn: false, reason: 'Autoscaling is disabled.', candidateServer: null };
    }
    if (!server.cluster_id) {
        return { canScaleIn: false, reason: 'Autoscaling requires a cluster ID.', candidateServer: null };
    }

    const minSize = Number(getValueFromObject(autoscaleConfig, 'scaleIn.minClusterSize'));
    const configuredStrategy = getValueFromObject(autoscaleConfig, 'scaleIn.decommissionStrategy');
    if (!Number.isFinite(minSize) || minSize < 0 || !['local', 'oldest'].includes(configuredStrategy)) {
        return { canScaleIn: false, reason: 'Scale-in policy is incomplete.', candidateServer: null };
    }
    const strategy = configuredStrategy;

    const clusterData = await getClusterDetails();
    const activeServers = clusterData.servers;
    if (activeServers.some(item => item.decommission?.status === 'draining' ||
        item.decommission?.status === 'terminating')) {
        return { canScaleIn: false, reason: 'A node is already being removed.', candidateServer: null };
    }

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

function checkScaleInCapacity(snapshot, candidateId, observedAfter) {
    const minimum = Number(getValueFromObject(autoscaleConfig, 'scaleIn.minClusterSize'));
    const maxCpu = Number(getValueFromObject(autoscaleConfig, 'scaleOut.cpuThreshold'));
    const maxMemory = Number(getValueFromObject(autoscaleConfig, 'scaleOut.memoryThreshold'));
    const remaining = snapshot.servers.filter(item => String(item._id) !== String(candidateId));
    if (!Number.isInteger(minimum) || minimum < 0 || remaining.length < minimum) {
        return { ok: false, reason: 'Removing this node would breach the cluster minimum.' };
    }
    if (snapshot.pendingCount || remaining.some(item =>
        ['draining', 'terminating'].includes(item.decommission?.status))) {
        return { ok: false, reason: 'Another cluster capacity change is in progress.' };
    }
    if (![maxCpu, maxMemory].every(value => Number.isFinite(value) && value > 0 && value <= 100)) {
        return { ok: false, reason: 'Scale-out capacity thresholds are incomplete.' };
    }

    let cpuDemand = 0;
    let memoryDemand = 0;
    let cpuCapacity = 0;
    let memoryCapacity = 0;
    for (const item of snapshot.servers) {
        const isCandidate = String(item._id) === String(candidateId);
        if (observedAfter && isCandidate) continue;
        const metrics = snapshot.serverMetrics.get(String(item._id));
        const vCPU = Number(item.infrastructure?.vCPU || item.vCPU);
        const memoryGb = Number(item.infrastructure?.memoryGb || item.memoryGb);
        if (!metrics || ![vCPU, memoryGb].every(value => Number.isFinite(value) && value > 0) ||
            ![metrics.cpu, metrics.memory].every(value => Number.isFinite(value) && value >= 0)) {
            return { ok: false, reason: 'Fresh telemetry and instance capacity are required for every node.' };
        }
        if (!isCandidate) {
            if (observedAfter && metrics.timestamp <= observedAfter) {
                return { ok: false, reason: 'Waiting for fresh telemetry from remaining nodes.' };
            }
            cpuCapacity += vCPU;
            memoryCapacity += memoryGb;
            if (observedAfter && (metrics.cpu >= maxCpu || metrics.memory >= maxMemory)) {
                return { ok: false, reason: 'A remaining node is at its capacity threshold.' };
            }
        }
        if (!observedAfter) {
            cpuDemand += metrics.cpu / 100 * vCPU;
            memoryDemand += metrics.memory / 100 * memoryGb;
        }
    }
    if (!cpuCapacity || !memoryCapacity) {
        return { ok: false, reason: 'No remaining capacity is available.' };
    }
    if (!observedAfter &&
        (cpuDemand / cpuCapacity * 100 >= maxCpu ||
            memoryDemand / memoryCapacity * 100 >= maxMemory)) {
        return { ok: false, reason: 'Projected demand exceeds remaining cluster capacity.' };
    }
    return { ok: true };
}

async function setDecommission(serverId, status, startedAt) {
    const result = await server.crud.send({
        method: 'object.update',
        array: 'servers',
        object: {
            _id: serverId,
            decommission: { status, startedAt, by: server.id }
        },
        organization_id: server.organization_id,
        host: server.host
    });
    if (result?.error?.length) throw new Error(`Unable to mark server as ${status}.`);
}

async function sendDrain(serverId, value) {
    if (String(serverId) === String(server.id) && server.totalWorkers <= 1) {
        await server.state.drain(value);
    } else {
        await server.send({ method: 'drain', server: serverId, broadcast: true, master: false, value });
    }
}

/**
 * Removes a node after verifying projected capacity, draining it, and observing
 * fresh telemetry from the remaining cluster nodes.
 * 
 * @param {Object} [targetServer] - Optional target server document to decommission
 * @returns {Promise<Object>} API execution result payload
 */
export async function scaleIn(targetServer) {
    if (!isAutoscalingEnabled()) throw new Error('Autoscaling is disabled.');
    if (!server.cluster_id) throw new Error('Autoscaling requires a cluster ID.');
    let candidateServer = targetServer;

    if (candidateServer) {
        const minSize = Number(getValueFromObject(autoscaleConfig, 'scaleIn.minClusterSize'));
        if (!Number.isFinite(minSize) || minSize < 0) {
            throw new Error('Scale-in requires a configured minimum cluster size.');
        }
        const clusterData = await getClusterDetails();
        if (clusterData.totalCount <= minSize) return null;
    }

    if (!candidateServer) {
        const scaleInTarget = await determineScaleInTarget();
        candidateServer = scaleInTarget.candidateServer;
    }

    if (!candidateServer) {
        console.log("[@cocreate/server-autoscaler] [SCALE-IN] Aborted: No valid scale-in candidate server found.");
        return null;
    }
    if (String(candidateServer.cluster_id) !== String(server.cluster_id)) {
        throw new Error('The server is outside the current cluster.');
    }

    const apiId = candidateServer.api_id || candidateServer.infrastructure?.api_id;
    const api = allowedApis.find(item => String(item._id) === String(apiId));
    if (!api) throw new Error('The server API is not allowed by the cluster providers.');
    const provider = api.name;
    const vmId = candidateServer.infrastructure?.vmId || candidateServer.vmId;
    const region = candidateServer.infrastructure?.region || candidateServer.region;

    // Retrieve delete endpoint directly from autoscaleConfig
    const endpoint = getValueFromObject(autoscaleConfig, `clouds.${api.provider}.endpoint.delete`) ||
        getValueFromObject(autoscaleConfig, 'endpoint.delete');
    const method = getValueFromObject(autoscaleConfig, `clouds.${api.provider}.method.delete`);
    if (!endpoint) throw new Error(`No delete endpoint is configured for ${api.provider}.`);
    if (!vmId || !region) throw new Error('The scale-in candidate needs a VM ID and region.');
    const drainWaitSeconds = Number(getValueFromObject(autoscaleConfig, 'scaleIn.drainWaitSeconds'));
    if (!Number.isInteger(drainWaitSeconds) || drainWaitSeconds < 1) {
        throw new Error('Scale-in requires a configured drain observation interval.');
    }

    const before = await getClusterDetails();
    if (!before.servers.some(item => String(item._id) === String(candidateServer._id))) return null;
    if (before.servers.some(item => ['draining', 'terminating'].includes(item.decommission?.status))) {
        return null;
    }
    const projected = checkScaleInCapacity(before, candidateServer._id);
    if (!projected.ok) {
        console.log(`[@cocreate/server-autoscaler] [SCALE-IN] ${projected.reason}`);
        return null;
    }

    console.log(`[@cocreate/server-autoscaler] [SCALE-IN] Draining node [${vmId}] before provider [${provider}] termination.`);

    const apiPayload = {
        api: provider,
        ...(method && { method }),
        endpoint,
        organization_id: server.organization_id,
        host: server.host,
        region,
        data: {
            server_id: candidateServer._id,
            vmId: vmId,
            provider: api.provider,
            region
        }
    };

    const startedAt = new Date().toISOString();
    let draining = false;
    try {
        await setDecommission(candidateServer._id, 'draining', startedAt);
        // A partial delivery can still reach the target when dispatch throws.
        // Always attempt to restore it if anything after this point fails.
        draining = true;
        await sendDrain(candidateServer._id, true);

        let observed;
        for (let attempt = 0; attempt < 2; attempt++) {
            await new Promise(resolve => setTimeout(resolve, drainWaitSeconds * 1000));
            const after = await getClusterDetails();
            observed = checkScaleInCapacity(after, candidateServer._id, startedAt);
            if (observed.ok || observed.reason !== 'Waiting for fresh telemetry from remaining nodes.') break;
        }
        if (!observed?.ok) throw new Error(observed?.reason || 'Scale-in capacity check failed.');

        console.log(`[@cocreate/server-autoscaler] [SCALE-IN] Sending termination request for node [${vmId}] to provider [${provider}] endpoint [${endpoint}].`);
        const response = await server.api.send(apiPayload);
        if (response?.error?.length || response?.success === false) {
            throw new Error('The cloud API rejected the termination request.');
        }
        try {
            await setDecommission(candidateServer._id, 'terminating', startedAt);
        } catch (error) {
            console.error('[@cocreate/server-autoscaler] Could not record termination state:', error);
        }
        return response;
    } catch (error) {
        if (draining) {
            try {
                await sendDrain(candidateServer._id, false);
            } catch (restoreError) {
                console.error('[@cocreate/server-autoscaler] Could not restore the drained server:', restoreError);
            }
        }
        try {
            await setDecommission(candidateServer._id, 'cancelled', startedAt);
        } catch (stateError) {
            console.error('[@cocreate/server-autoscaler] Could not cancel decommission state:', stateError);
        }
        throw error;
    }
}

function thresholdReached(value, threshold) {
    return Number.isFinite(Number(threshold)) && Number(value) >= Number(threshold);
}

function thresholdBelow(value, threshold) {
    return Number.isFinite(Number(threshold)) && Number(value) < Number(threshold);
}

function isScaleInCoordinator(snapshot, policy) {
    // Every node chooses from the same cluster snapshot. The lowest-ID node
    // with low local load coordinates this decision; the configured strategy still
    // decides which node is removed.
    const eligible = snapshot.servers.filter(item => {
        const metrics = snapshot.serverMetrics.get(String(item._id));
        return metrics && thresholdBelow(metrics.cpu, policy.cpuThreshold) &&
            thresholdBelow(metrics.memory, policy.memoryThreshold);
    });
    return eligible.map(item => String(item._id)).sort()[0] === String(server.id);
}

function placementLocations(sample) {
    const clients = sample.custom?.clientLocations;
    if (Array.isArray(clients) && clients.length) return clients;

    // A server location is a fallback until client geography is supplied by telemetry.
    const location = server.location || {};
    if (Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))) {
        return [{
            latitude: Number(location.latitude),
            longitude: Number(location.longitude),
            continent: location.continent,
            count: 1
        }];
    }
    const firstRegion = loadCloudProviders(autoscaleConfig).find(region =>
        allowedApis.some(api => api.provider === region.provider)
    );
    return firstRegion ? [{
        latitude: firstRegion.lat,
        longitude: firstRegion.lng,
        count: 1
    }] : [];
}

/** Evaluate local flushes first. Only a sustained local signal reads peer telemetry. */
async function onTelemetry(message) {
    if (!isAutoscalingEnabled() || !server.cluster_id) return;
    const sample = message?.data;
    if (!sample || String(sample.serverId) !== String(server.id)) return;

    const workerId = String(sample.workerId ?? message.workerId ?? 0);
    const previous = workerStreaks.get(workerId) || { out: 0, in: 0 };
    if (previous.timestamp === sample.timestamp) return;

    const outPolicy = getValueFromObject(autoscaleConfig, 'scaleOut') || {};
    const inPolicy = getValueFromObject(autoscaleConfig, 'scaleIn') || {};
    const cpu = Number(sample.cpu?.avg);
    const memory = Number(sample.memory?.avg_used_pct);
    if (!Number.isFinite(cpu) || !Number.isFinite(memory)) return;

    const out = thresholdReached(cpu, outPolicy.cpuThreshold) ||
        thresholdReached(memory, outPolicy.memoryThreshold);
    const inside = thresholdBelow(cpu, inPolicy.cpuThreshold) &&
        thresholdBelow(memory, inPolicy.memoryThreshold);
    const streak = {
        out: out ? previous.out + 1 : 0,
        in: inside ? previous.in + 1 : 0,
        timestamp: sample.timestamp
    };
    workerStreaks.set(workerId, streak);

    const outFlushes = Number(outPolicy.consecutiveFlushes);
    const inFlushes = Number(inPolicy.consecutiveFlushes);
    const needsPressureCheck =
        (Number.isInteger(outFlushes) && outFlushes > 0 && streak.out >= outFlushes) ||
        (Number.isInteger(inFlushes) && inFlushes > 0 && streak.in >= inFlushes);
    const minimum = Number(inPolicy.minClusterSize);
    const intervalMs = Math.max(1000, Number(sample.interval_seconds || 60) * 1000);
    const floorRefreshMs = intervalMs * Math.max(1, inFlushes || 1);
    const needsFloorCheck = Number.isInteger(minimum) && minimum > 0 &&
        (floorLeader !== false || Date.now() - lastFloorCheckAt >= floorRefreshMs) &&
        Date.now() - lastFloorCheckAt >= intervalMs;
    if (!needsPressureCheck && !needsFloorCheck) return;
    if (evaluating) return;

    const cooldownMs = intervalMs * Math.max(1, outFlushes || 1, inFlushes || 1);
    if (Date.now() - lastActionAt < cooldownMs && !needsFloorCheck) return;

    evaluating = true;
    try {
        const clusterData = await getClusterDetails({}, sample);
        const activeCount = clusterData.totalCount;
        const clusterSize = activeCount + clusterData.pendingCount;
        const firstId = clusterData.servers.map(item => String(item._id)).sort()[0];
        floorLeader = firstId === String(server.id);
        lastFloorCheckAt = Date.now();
        if (clusterData.servers.some(item =>
            ['draining', 'terminating'].includes(item.decommission?.status))) return;
        const maximum = Number(outPolicy.maxClusterSize);
        const canAdd = !Number.isInteger(maximum) || maximum === 0 || clusterSize < maximum;

        if (Number.isInteger(minimum) && minimum > 0 && clusterSize < minimum) {
            // Only one active node attempts to repair the cluster floor.
            if (canAdd && !clusterData.pendingCount && floorLeader &&
                Date.now() - lastActionAt >= cooldownMs) {
                await scaleOut(placementLocations(sample), clusterData.servers);
                lastActionAt = Date.now();
            }
            return;
        }

        // Missing or stale peer samples cannot establish cluster-wide pressure.
        if (clusterData.sampledServers !== activeCount || !activeCount) return;
        if (Date.now() - lastActionAt >= cooldownMs && canAdd && !clusterData.pendingCount &&
            Number.isInteger(outFlushes) && outFlushes > 0 &&
            streak.out >= outFlushes &&
            (thresholdReached(clusterData.avgCpu, outPolicy.cpuThreshold) ||
                thresholdReached(clusterData.avgMemory, outPolicy.memoryThreshold))) {
            await scaleOut(placementLocations(sample), clusterData.servers);
            lastActionAt = Date.now();
            workerStreaks.clear();
        } else if (Date.now() - lastActionAt >= cooldownMs &&
            !clusterData.pendingCount &&
            Number.isInteger(inFlushes) && inFlushes > 0 &&
            streak.in >= inFlushes &&
            isScaleInCoordinator(clusterData, inPolicy)) {
            const result = await scaleIn();
            if (result) {
                lastActionAt = Date.now();
                workerStreaks.clear();
            }
        }
    } catch (error) {
        console.error('[@cocreate/server-autoscaler] Telemetry evaluation failed:', error);
    } finally {
        evaluating = false;
    }
}

export async function init(serverInstance) {
    if (!isPrimary) {
        return;
    }

    server = serverInstance;
    await loadAutoscaleConfig();
    server.on('telemetry', onTelemetry);

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
