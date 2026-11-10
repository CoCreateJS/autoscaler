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
import { deleteServer, collectTerminatingServers, startServerCleanup } from './cleanup.js';
export { deleteServer } from './cleanup.js';
import config from '@cocreate/config';
import { getValueFromObject, dotNotationToObject } from '@cocreate/utils';
import { getDensityTarget, selectPlacement, loadCloudProviders, loadDnsLocations } from './geoScaling.js';

// Guard clause verification to ensure cluster API abstraction integrity
const isPrimary = cluster.isPrimary;

let server = null;

let autoscaleConfig = {};
let clusterConfig = null;
let allowedApis = [];
const workerStreaks = new Map();
let evaluating = false;
let organizationIdle = false;
let lastActionAt = 0;
let floorLeader = null;
let cleanupTimer;
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
 * @public
 * @environment server
 */
export async function loadAutoscaleConfig() {
    clusterConfig = null;
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
        const clusterRecord = response?.object?.[0];
        if (clusterRecord) {
            clusterConfig = structuredClone(clusterRecord);
        }
    }

    const resolved = await resolveClusterConfig(clusterConfig);
    autoscaleConfig = resolved.autoscaleConfig;
    allowedApis = resolved.allowedApis;
    return autoscaleConfig;
}

/** Resolve one cluster's policies and catalogs without changing another cluster's runtime. */
export async function resolveClusterConfig(targetCluster) {
    const resolved = {};
    if (targetCluster) dotNotationToObject(structuredClone(targetCluster), resolved);
    const clusterCloudIds = targetCluster?.clouds ?? targetCluster?.providers;
    const clusterDnsIds = targetCluster?.dns;
    const sysConfig = await config.get('autoscaler');

    const scope = {
        organization_id: server.organization_id,
        server: server.host,
        cluster: targetCluster?._id
    };
    // Catalogs have provider keys at their root; keep DNS and clouds separate.
    const [dbConfig, clouds, dns] = await Promise.all([
        config.query({ ...scope, type: 'autoscaler' }, server.crud),
        config.query({ ...scope, type: 'clouds' }, server.crud),
        config.query({ ...scope, type: 'dns' }, server.crud)
    ]);
    if (clouds && Object.keys(clouds).length) resolved.clouds = clouds;
    if (dns && Object.keys(dns).length) resolved.dns = dns;

    // The cluster is the baseline; matching configs overwrite it in query order.
    if (sysConfig) dotNotationToObject(sysConfig, resolved);
    if (dbConfig) dotNotationToObject(dbConfig, resolved);

    const readApis = async (type, selection) => {
        const ids = selection == null || selection === '' ? [] :
            typeof selection === 'string' ? [selection] : selection;
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())) {
            throw new Error(`Cluster ${type} selection must contain API IDs.`);
        }
        const response = await server.crud.send({
            method: 'object.read', array: 'apis',
            organization_id: server.organization_id, host: server.host,
            filter: { query: { type, enabled: true, ...(ids.length && { _id: { $in: ids } }) }, limit: 0 }
        });
        if (!response || response.success === false ||
            (Array.isArray(response.error) ? response.error.length : response.error) || !Array.isArray(response.object)) {
            throw new Error(`Unable to read cluster ${type} APIs.`);
        }
        return response.object;
    };
    const [clusterApis, dnsApis] = await Promise.all([
        readApis('cloud', clusterCloudIds), readApis('dns', clusterDnsIds)
    ]);
    const dnsCatalog = resolved.dns;
    // Catalogs describe provider POPs; API records determine which connections may use them.
    resolved.dns = {};
    for (const api of dnsApis) {
        const provider = api.provider || api.name;
        const locations = dnsCatalog?.[provider];
        if (!Array.isArray(locations)) continue;
        resolved.dns[provider] ||= [];
        resolved.dns[provider].push(...locations.map(location => ({ ...location, apiId: api._id })));
    }
    if (clusterDnsIds?.length && !loadDnsLocations(resolved.dns).length) {
        throw new Error('No eligible DNS locations match the cluster DNS APIs.');
    }
    return { autoscaleConfig: resolved, allowedApis: clusterApis };
}

/**
 * Calculates running-master capacity and tracks departing masters separately for coordination.
 *
 * @param {Object} [query={}] - Optional query filters to merge with default master status
 * @returns {Promise<Object>} Cluster snapshot including averages and raw active servers array
 * @private
 * @environment server
 */
async function getClusterDetails(query = {}, currentSample) {
    const readResponse = await server.crud.send({
        method: 'object.read',
        array: 'servers',
        filter: {
            query: {
                'master.status': { $in: ['running', 'draining', 'terminating'] },
                ...query,
                cluster_id: server.cluster_id
            }
        },
        organization_id: server.organization_id,
        host: server.host
    });

    if (readResponse?.error?.length) throw new Error('Unable to read active cluster servers.');
    const clusterServers = readResponse?.object || [];
    const activeServers = clusterServers.filter(item => item.master.status === 'running');
    const removingServers = clusterServers.filter(item => ['draining', 'terminating'].includes(item.master.status));
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
    if (currentSample && ids.includes(String(currentSample.serverId))) {
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
        servers: activeServers,
        removingServers
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
 * @private
 * @environment server
 */
function determineTargetTier(targetRegion, activeClusterServers, autoscaleConfig) {
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
        serverNode.deployment?.region === targetRegion ||
        serverNode.deployment?.location?.region === targetRegion
    );

    if (regionalServers.length === 0) {
        return { ...minTier, tierIndex: 0 };
    }

    const nodeTiers = regionalServers.map((serverNode) => {
        const deployment = serverNode.deployment || {};
        const provider = serverNode.provider || deployment.provider;
        const type = serverNode.type || deployment.type;
        const providerInstances = getValueFromObject(
            autoscaleConfig,
            `clouds.${provider}.instances`
        ) || [];
        const instance = providerInstances.find(({ name }) => name === type);

        return {
            vCPU: Math.min(
                maxTier.vCPU,
                Math.max(
                    minTier.vCPU,
                    Number(serverNode.vCPU || deployment.vCPU || instance?.vCPU) || minTier.vCPU
                )
            ),
            memoryGb: Math.min(
                maxTier.memoryGb,
                Math.max(
                    minTier.memoryGb,
                    Number(serverNode.memoryGb || deployment.memoryGb || instance?.memoryGb) || minTier.memoryGb
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
    console.log(`[@cocreate/autoscaler] [VERTICAL TIERING] Region [${targetRegion}] reached ${nodesAtCurrentTier}/${maxNodesPerTier} nodes at tier ${currentTierIndex}. Stepping up to tier ${nextTierIndex} (${nextTier.vCPU} vCPU, ${nextTier.memoryGb}GB RAM).`);

    return { ...nextTier, tierIndex: nextTierIndex };
}

/**
 * Searches the provider's `instances` array (returned by geoScaling) for an instance name
 * that best matches or satisfies the target tier's vCPU and memory specifications.
 *
 * @param {Array<Object>} instances - Instance catalog array from cloud provider config
 * @param {Object} targetTier - Target tier specifications { vCPU, memoryGb }
 * @returns {string} Matching instance type string (e.g. 't3a.medium', 'e2-standard-4')
 * @private
 * @environment server
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
 * Calculates scale-out targeting details: provider, region, type, vCPU, memoryGb,
 * datacenterName, countryCode, and geo latency metadata based on client traffic distribution.
 *
 * @param {Array<Object>} clientLocations - Active client traffic distribution points
 * @param {Array<Object>} [activeServers] - Cluster snapshot, fetched when omitted
 * @returns {Promise<Object>} Target specification object calculated for scale-out
 * @public
 * @environment server
 */
export async function determineScaleOutTarget(clientLocations, activeServers) {
    if (!isAutoscalingEnabled()) throw new Error("Autoscaling is disabled.");
    if (!server.cluster_id) throw new Error("Autoscaling requires a cluster ID.");
    const currentServers = (activeServers ?? (await getClusterDetails()).servers)
        .filter(item => item.master.status === 'running');
    const isGeoEnabled = getValueFromObject(autoscaleConfig, 'geoScale.enabled');
    const sheddingThreshold = getValueFromObject(autoscaleConfig, 'geoScale.sheddingThreshold');
    if (isGeoEnabled === true && !Number.isFinite(Number(sheddingThreshold))) {
        throw new Error('Geographic scaling requires a configured shedding threshold.');
    }
    const density = getDensityTarget(clientLocations, {
        geoScaleByContinent: isGeoEnabled, sheddingThreshold,
        existingNodes: currentServers.map(item => ({
            continent: item.deployment?.location?.continent || item.deployment?.continent
        }))
    });
    const target = await determineDeployment(density?.targetCentroid, currentServers);
    return { ...density, ...target };
}

/** Generate a deployment from coordinates using the target cluster's resolved configuration. */
export async function determineDeployment(coordinates, activeServers = [], configuration = { autoscaleConfig, allowedApis }) {
    const { autoscaleConfig: placementConfig, allowedApis: clusterApis } = configuration;
    if (!clusterApis.length) throw new Error('Autoscaling requires enabled cloud APIs in cluster clouds.');
    const regions = loadCloudProviders(placementConfig);
    const cloudProviders = clusterApis.flatMap(api =>
        regions.filter(region => region.provider === api.provider).map(region => ({
            ...region, provider: api.name, providerType: api.provider, apiId: api._id
        }))
    );
    const currentServers = activeServers.filter(item => item.master.status === 'running');
    const geoTarget = selectPlacement(coordinates, { cloudProviders, autoscaleConfig: placementConfig });
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
    const targetTier = getValueFromObject(placementConfig, 'vertical.enabled') === true
        ? determineTargetTier(region, currentServers, placementConfig)
        : defaultInstance && {
            vCPU: Number(defaultInstance.vCPU),
            memoryGb: Number(defaultInstance.memoryGb),
            tierIndex: 0
        };
    if (!targetTier) throw new Error(`No default instance is configured for ${providerType}.`);
    const type = getValueFromObject(placementConfig, 'vertical.enabled') === true
        ? selectInstanceType(providerInstances, targetTier)
        : defaultInstance.name;

    const result = {
        provider,
        providerType,
        apiId: cloudRegion.apiId,
        region,
        type,
        vCPU: targetTier.vCPU,
        memoryGb: targetTier.memoryGb,
        targetTier,
        datacenterName: cloudRegion.datacenterName,
        countryCode: cloudRegion.countryCode,
        coordinates: cloudRegion.coordinates,
        distanceKm: cloudRegion.distanceKm,
        dns: geoTarget.dns,
        timestamp: Date.now()
    };

    console.log("[@cocreate/autoscaler] Resolved scale-out target decision:", JSON.stringify(result, null, 2));
    return result;
}

/**
 * Triggers horizontal scale-out provisioning workflow:
 * Chooses the current deployment, then sends the saved cluster to the common
 * provisioning workflow locally or through the upstream manager transport.
 *
 * @param {Array<Object>|Object} input - Client locations to calculate density, or the target cluster
 * @param {Array<Object>} [activeServers] - Cluster snapshot, fetched when omitted
 * @param {Object} [coordinates] - Organization location when input is a target cluster
 * @returns {Promise<Object>} API execution result payload
 * @public
 * @environment server
 */
export async function scaleOut(input, activeServers, coordinates) {
    const targetCluster = Array.isArray(input) ? clusterConfig : input;
    if (!targetCluster?._id) throw new Error('Scale-out requires the saved cluster configuration.');
    const target = Array.isArray(input)
        ? await determineScaleOutTarget(input, activeServers)
        : await determineDeployment(coordinates, activeServers || [], await resolveClusterConfig(targetCluster));
    const deployment = {
        cloud: target.apiId, region: target.region, type: target.type,
        vCPU: target.vCPU, memoryGb: target.memoryGb, dns: target.dns,
        location: target.coordinates
    };
    const response = await runWorkflow('createOrganizationServer', { ...targetCluster, deployment });
    if (!response || response.success === false ||
        (Array.isArray(response.error) ? response.error.length : response.error)) {
        throw new Error('Server provisioning workflow failed.');
    }
    return response;
}

/** Send each operation's cluster through the same standard workflow envelope. */
export async function runWorkflow(name, targetCluster) {
    if (!targetCluster?._id) throw new Error('Server workflows require the saved cluster configuration.');
    const payload = {
        method: `workflow.${name}`,
        organization_id: server.organization_id,
        host: server.host,
        managedOrganization: targetCluster.managedOrganization || server.organization_id,
        [name]: { ...targetCluster }
    };
    return server.manager?.organization_id
        ? server.manager.send(payload)
        : server.workflow.run(payload);
}

/**
 * Evaluates active cluster servers against autoscale scale-in policies to determine
 * which server candidate should be decommissioned (dry-run preview).
 *
 * @param {Object} [options] - Optional override parameters
 * @returns {Promise<Object>} Evaluation result containing selected candidate server and reason
 * @public
 * @environment server
 */
export async function determineScaleInTarget(options) {
    if (!isAutoscalingEnabled()) {
        return { canScaleIn: false, reason: 'Autoscaling is disabled.', candidateServer: null };
    }
    if (!server.cluster_id) {
        return { canScaleIn: false, reason: 'Autoscaling requires a cluster ID.', candidateServer: null };
    }

    const minSize = Number(getValueFromObject(autoscaleConfig, 'scaleIn.minClusterSize'));
    const configuredStrategy = options?.strategy || getValueFromObject(autoscaleConfig, 'scaleIn.decommissionStrategy');
    if (!Number.isFinite(minSize) || minSize < 0 || !['local', 'oldest'].includes(configuredStrategy)) {
        return { canScaleIn: false, reason: 'Scale-in policy is incomplete.', candidateServer: null };
    }
    const strategy = configuredStrategy;

    const clusterData = await getClusterDetails();
    const activeServers = clusterData.servers;
    if (clusterData.removingServers.length) {
        return { canScaleIn: false, reason: 'A node is already being removed.', candidateServer: null };
    }

    const effectiveMinimum = minSize === 0 && !organizationIdle ? 1 : minSize;
    if (activeServers.length <= effectiveMinimum) {
        console.log(`[@cocreate/autoscaler] [SCALE-IN PREVIEW] Cannot scale in: Active nodes (${activeServers.length}) is at or below effective floor (${effectiveMinimum}).`);
        return {
            canScaleIn: false,
            reason: `Cluster size (${activeServers.length}) is at or below effective floor (${effectiveMinimum}).`,
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
    if (snapshot.pendingCount || snapshot.removingServers.some(item => String(item._id) !== String(candidateId))) {
        return { ok: false, reason: 'Another cluster capacity change is in progress.' };
    }
    if (minimum === 0 && remaining.length === 0) return { ok: true };
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
        const vCPU = Number(item.deployment?.vCPU || item.vCPU);
        const memoryGb = Number(item.deployment?.memoryGb || item.memoryGb);
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
        if (minimum === 0 && remaining.length === 0) return { ok: true };
        return { ok: false, reason: 'No remaining capacity is available.' };
    }
    if (!observedAfter &&
        (cpuDemand / cpuCapacity * 100 >= maxCpu ||
            memoryDemand / memoryCapacity * 100 >= maxMemory)) {
        return { ok: false, reason: 'Projected demand exceeds remaining cluster capacity.' };
    }
    return { ok: true };
}

async function setMasterStatus(serverId, status) {
    const payload = {
        method: 'object.update',
        array: 'servers',
        object: {
            _id: serverId,
            'master.status': status
        },
        organization_id: server.organization_id,
        host: server.host
    };
    const result = await server.crud.send(payload);
    if (result?.success === false || (Array.isArray(result?.error) ? result.error.length : result?.error)) {
        throw new Error(`Unable to mark server as ${status}.`);
    }
    if (server.manager?.organization_id) {
        try { await server.manager.send({ ...payload, object: { ...payload.object, cluster_id: server.cluster_id } }); }
        catch (error) {
            console.error('[@cocreate/autoscaler] Unable to mirror server status to its manager:', {
                server_id: serverId, status, error_code: error?.cause?.code || error?.code || error?.name
            });
        }
    }
}

async function sendDrain(serverId, value) {
    if (String(serverId) === String(server.id) && server.isWorker) {
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
 * @param {Object} [options] - Selection options; organization inactivity selects strategy local.
 * @param {Object} [coordinates] - Organization location when input is a target cluster
 * @returns {Promise<Object>} API execution result payload
 * @public
 * @environment server
 */
export async function scaleIn(targetServer, options) {
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
        const scaleInTarget = await determineScaleInTarget(options);
        candidateServer = scaleInTarget.candidateServer;
    }

    if (!candidateServer) {
        console.log("[@cocreate/autoscaler] [SCALE-IN] Aborted: No valid scale-in candidate server found.");
        return null;
    }
    if (String(candidateServer.cluster_id) !== String(server.cluster_id)) {
        throw new Error('The server is outside the current cluster.');
    }


    const apiId = candidateServer.deployment?.cloud || candidateServer.cloud ||
        candidateServer.api_id || candidateServer.deployment?.api_id;
    const api = allowedApis.find(item => String(item._id) === String(apiId));
    if (!api) throw new Error('The server cloud API is not allowed by the cluster clouds.');
    const provider = api.name;
    const deploymentId = candidateServer.deployment?.id;
    const region = candidateServer.deployment?.region || candidateServer.region;

    if (!clusterConfig?._id) throw new Error('Scale-in requires the saved cluster configuration.');
    if (!deploymentId || !region) throw new Error('The scale-in candidate needs an deployment ID and region.');
    const drainWaitSeconds = Number(getValueFromObject(autoscaleConfig, 'scaleIn.drainWaitSeconds'));
    if (!Number.isInteger(drainWaitSeconds) || drainWaitSeconds < 1) {
        throw new Error('Scale-in requires a configured drain observation interval.');
    }

    const before = await getClusterDetails();
    if (!before.servers.some(item => String(item._id) === String(candidateServer._id))) return null;
    if (before.removingServers.length) {
        return null;
    }
    if (before.servers.length === 1 && !organizationIdle) return null;
    const projected = checkScaleInCapacity(before, candidateServer._id);
    if (!projected.ok) {
        console.log(`[@cocreate/autoscaler] [SCALE-IN] ${projected.reason}`);
        return null;
    }

    console.log(`[@cocreate/autoscaler] [SCALE-IN] Draining node [${deploymentId}] before provider [${provider}] termination.`);

    const targetCluster = {
        ...clusterConfig,
        deployment: {
            cloud: apiId, region, type: candidateServer.deployment?.type,
            dns: candidateServer.deployment?.dns || [],
            server_id: candidateServer._id, id: deploymentId
        }
    };

    const startedAt = new Date().toISOString();
    let draining = false;
    try {
        await setMasterStatus(candidateServer._id, 'draining');
        // A partial delivery can still reach the target when dispatch throws.
        // Restore service if draining or the capacity observation fails before termination.
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
    } catch (error) {
        console.error('[@cocreate/autoscaler] Scale-in failed; platform notification pending:', {
            server_id: candidateServer._id, cluster_id: server.cluster_id,
            error_code: error?.cause?.code || error?.code || error?.name
        });
        if (draining) {
            try {
                await sendDrain(candidateServer._id, false);
            } catch (restoreError) {
                console.error('[@cocreate/autoscaler] Could not restore the drained server:', restoreError);
            }
        }
        try {
            await setMasterStatus(candidateServer._id, 'running');
        } catch (stateError) {
            console.error('[@cocreate/autoscaler] Could not restore master status:', stateError);
        }
        throw error;
    }

    // Commit retirement before provider dispatch so normal State saves preserve it.
    await setMasterStatus(candidateServer._id, 'terminating');
    console.log(`[@cocreate/autoscaler] [SCALE-IN] Sending termination request for node [${deploymentId}] through workflow.deleteOrganizationServer.`);
    let response;
    let terminationError;
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                response = await runWorkflow('deleteOrganizationServer', targetCluster);
                break;
            } catch (error) {
                const code = error?.cause?.code || error?.code;
                const networkError = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
                    'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
                    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code) || ['TimeoutError', 'AbortError'].includes(error?.name);
                if (!networkError || attempt === 1) throw error;
                console.error('[@cocreate/autoscaler] Termination network error; retrying:', {
                    server_id: candidateServer._id, error_code: code || error.name
                });
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        if (!response || response.success === false ||
            (Array.isArray(response.error) ? response.error.length : response.error)) {
            throw new Error('The cloud API rejected the termination request.');
        }
    } catch (error) {
        terminationError = error;
        // TODO: Notify the platform about failed termination, including exhausted network retries.
        console.error('[@cocreate/autoscaler] Termination failed; platform notification pending:', {
            server_id: candidateServer._id, cluster_id: server.cluster_id,
            error_code: error?.cause?.code || error?.code || error?.name
        });
    }

    if (terminationError) await setMasterStatus(candidateServer._id, 'failed');
    server.state.shutdown({ server: candidateServer._id, master: true, organization_id: server.organization_id });
    if (terminationError) throw terminationError;
    return response;
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
    const location = server.deployment?.location || {};
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

/** Evaluate local flushes first. Only a sustained local signal reads peer telemetry.  * @private
 * @environment server
 */
async function onOrganizationDisconnected(message) {
    if (message.organization_id !== server.organization_id || !isAutoscalingEnabled() ||
        Number(getValueFromObject(autoscaleConfig, 'scaleIn.minClusterSize')) !== 0) return;
    organizationIdle = true;
    if (evaluating) return;
    evaluating = true;
    try {
        await scaleIn(undefined, { strategy: 'local' });
    } catch (error) {
        console.error('[@cocreate/autoscaler] Organization idle scale-in failed:', error.message);
    } finally {
        evaluating = false;
    }
}

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
    const needsIdleCheck = organizationIdle && minimum === 0;
    if (!needsPressureCheck && !needsFloorCheck && !needsIdleCheck) return;
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
        if (clusterData.removingServers.length) return;
        if (!clusterData.servers.some(item => String(item._id) === String(server.id))) return;
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

        if (needsIdleCheck) {
            const result = await scaleIn(undefined, { strategy: 'local' });
            if (result) lastActionAt = Date.now();
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
        console.error('[@cocreate/autoscaler] Telemetry evaluation failed:', error);
    } finally {
        evaluating = false;
    }
}

/** Place the first node using the organization location instead of traffic density. */
async function onOrganizationPeers({ organization_id, peers } = {}) {
    if (!organization_id || organization_id === server.organization_id || !Array.isArray(peers) || peers.length) return;
    try {
        const response = await server.crud.send({
            method: 'object.read', array: 'clusters', organization_id: server.organization_id, host: server.host,
            filter: { query: { type: 'organization', managedOrganization: organization_id }, limit: 1 }
        });
        if (!response || response.success === false || response.error?.length || !Array.isArray(response.object)) {
            throw new Error('Unable to read the organization cluster.');
        }
        const cluster = response.object[0];
        if (!cluster) return;
        const organizationResponse = await server.crud.send({
            method: 'object.read', array: 'organizations', organization_id: server.organization_id, host: server.host,
            filter: { query: { _id: organization_id }, limit: 1 }
        });
        if (!organizationResponse || organizationResponse.success === false ||
            (Array.isArray(organizationResponse.error) ? organizationResponse.error.length : organizationResponse.error) ||
            !Array.isArray(organizationResponse.object)) throw new Error('Unable to read the organization location.');
        const result = await scaleOut(cluster, [], organizationResponse.object[0]?.location);
        if (!result.data?.server?._id || !result.data.id) throw new Error('Provisioning returned no server or deployment ID.');
        watchStartup(result.data.server._id);
    } catch (error) {
        console.error('[@cocreate/autoscaler] Organization cluster startup failed:', {
            organization_id, error_code: error?.cause?.code || error?.code || error?.name
        });
    }
}

/** Check persisted readiness after two minutes; another platform worker may receive the update. */
function watchStartup(serverId) {
    const timer = setTimeout(async () => {
        if (server.state?.isShuttingDown) return;
        try {
            const response = await server.crud.send({
                method: 'object.read', array: 'servers',
                organization_id: server.organization_id, host: server.host,
                filter: { query: { _id: serverId }, limit: 1 }
            });
            if (!response || response.error?.length || response.success === false || !Array.isArray(response.object)) throw new Error('Unable to read startup state.');
            const record = response.object.find(record => String(record._id) === serverId);
            const reported = record && (
                (typeof record.master?.status === 'string' && record.master.status !== 'provisioning') ||
                Object.entries(record).some(([key, value]) => /^worker\d+$/.test(key) && typeof value?.status === 'string')
            );
            // TODO: Notify the platform and consider at most one replacement.
            if (!reported) console.error('[@cocreate/cluster] No managed startup update received within two minutes:', serverId);
        } catch {
            console.error('[@cocreate/cluster] Unable to verify managed startup update:', serverId);
        }
    }, 120000);
    timer.unref?.();
}

/**
 *
 * @public
 * @environment server
 */
export async function init(serverInstance) {
    if (!isPrimary) {
        return;
    }

    server = serverInstance;
    await loadAutoscaleConfig();
    organizationIdle = false;
    const manager = config.get('manager') || {};
    if (manager.enabled === true && manager.organization_id === server.organization_id) {
        server.on('organizationPeers', onOrganizationPeers);
    }
    server.on('telemetry', onTelemetry);
    server.on('orgDisconnected', onOrganizationDisconnected);
    server.on('orgConnected', message => {
        if (message.organization_id === server.organization_id) organizationIdle = false;
    });
    clearInterval(cleanupTimer);
    cleanupTimer = startServerCleanup(server);

    console.log("[@cocreate/autoscaler] [MASTER] Autoscaler service initialized successfully.");

    return {
        config: autoscaleConfig,
        scaleOut,
        determineDeployment,
        determineScaleOutTarget,
        scaleIn,
        determineScaleInTarget,
        deleteServer: (serverId, options) => deleteServer(serverInstance, serverId, options),
        collectTerminatingServers: () => collectTerminatingServers(serverInstance)
    };
}

export default {
    init
};

/**
 * Decentralized, masterless P2P autoscaling engine for CoCreate Server. Executes autonomous horizontal and vertical multi-cloud adjustments driven by real-time tenant telemetry.
 *
 * @module autoscaler
 * @environment server
 */
