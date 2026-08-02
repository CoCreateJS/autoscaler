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

import Config from '@cocreate/config';
import { getValueFromObject } from '@cocreate/utils';

/**
 * Reads cloud provider configurations from the provided autoscaler config object,
 * or queries the database for active autoscaler configuration (type: 'autoscaler')
 * containing the `clouds` array key. Flattens configured regions into standardized
 * datacenter region objects with attached instance catalogs.
 * 
 * @param {Object|Array} [autoscaleConfigOrClouds] - Resolved autoscale config object or clouds array
 * @param {Object} [server] - Optional CoCreate server instance for database targeting
 * @returns {Promise<Array<Object>>} Standardized datacenter regions array with instances catalog
 */
export async function loadCloudProviders(autoscaleConfigOrClouds = null, server = null) {
    try {
        let cloudDocs = [];

        if (Array.isArray(autoscaleConfigOrClouds)) {
            cloudDocs = autoscaleConfigOrClouds;
        } else if (autoscaleConfigOrClouds && typeof autoscaleConfigOrClouds === 'object') {
            const clouds = getValueFromObject(autoscaleConfigOrClouds, 'autoscaler.clouds') || 
                           autoscaleConfigOrClouds.clouds || 
                           autoscaleConfigOrClouds.cloud || [];
            cloudDocs = Array.isArray(clouds) ? clouds : [clouds];
        } else {
            const config = new Config();
            const query = {
                type: 'autoscaler'
            };

            if (server?.organization_id) query.organization_id = server.organization_id;
            if (server?.host) query.server = server.host;
            if (server?.cluster_id) query.cluster = server.cluster_id;

            console.log("[@cocreate/server-autoscaler] Querying database for autoscaler config containing clouds via config.query...");
            const result = await config.query(query);

            let autoscalerDoc = null;
            if (Array.isArray(result)) {
                autoscalerDoc = result[0];
            } else if (result && typeof result === 'object') {
                autoscalerDoc = result.type === 'autoscaler' ? result : Object.values(result).find(doc => doc?.type === 'autoscaler');
            }

            if (autoscalerDoc) {
                const clouds = getValueFromObject(autoscalerDoc, 'autoscaler.clouds') || 
                               autoscalerDoc.clouds || 
                               autoscalerDoc.cloud || [];
                cloudDocs = Array.isArray(clouds) ? clouds : [clouds];
            }
        }

        const flattenedRegions = [];

        for (const cloudDoc of cloudDocs) {
            if (!cloudDoc || cloudDoc.enabled === false) continue;

            const providerKey = cloudDoc.provider || cloudDoc.name || 'unknown';
            const regions = cloudDoc.config?.regions || cloudDoc.regions;
            const instances = cloudDoc.config?.instances || cloudDoc.instances || [];
            const endpoints = cloudDoc.config?.endpoints || cloudDoc.endpoints || {};

            if (Array.isArray(regions)) {
                for (const reg of regions) {
                    if (reg && typeof reg.lat === 'number' && typeof reg.lng === 'number') {
                        flattenedRegions.push({
                            provider: providerKey,
                            region: reg.region,
                            datacenterName: reg.name,
                            countryCode: reg.country,
                            lat: reg.lat,
                            lng: reg.lng,
                            instances: Array.isArray(instances) ? instances : [],
                            endpoints: typeof endpoints === 'object' ? endpoints : {}
                        });
                    }
                }
            }
        }

        console.log(`[@cocreate/server-autoscaler] Resolved ${flattenedRegions.length} active datacenter regions across ${cloudDocs.length} cloud provider definitions from autoscaler config.`);
        return flattenedRegions;
    } catch (err) {
        console.error("[@cocreate/server-autoscaler] Error resolving cloud providers from autoscaler config:", err.message);
        return [];
    }
}

/**
 * Calculates Great-Circle distance between two coordinates using Haversine formula (returns KM).
 * 
 * @param {number} latitude1 - Starting latitude
 * @param {number} longitude1 - Starting longitude
 * @param {number} latitude2 - Ending latitude
 * @param {number} longitude2 - Ending longitude
 * @returns {number} Distance in kilometers
 */
export function calculateHaversineDistance(latitude1, longitude1, latitude2, longitude2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (latitude2 - latitude1) * Math.PI / 180;
    const dLon = (longitude2 - longitude1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(latitude1 * Math.PI / 180) * Math.cos(latitude2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    // Math.min safeguard prevents floating point NaN errors if a slightly exceeds 1.0
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - Math.min(1, a)));
    return R * c;
}

/**
 * Finds the nearest cloud datacenter region across active cloud providers
 * to a target latitude/longitude centroid, returning region metadata and instance catalog.
 * 
 * @param {number} targetLatitude - Target Latitude centroid
 * @param {number} targetLongitude - Target Longitude centroid
 * @param {Object} [options] - Optional filters (e.g. preferred providers, autoscaleConfig)
 * @param {Object} [server] - Optional server context
 * @returns {Promise<Object|null>} Recommended provider region metadata, distance in KM, and instances array
 */
export async function findNearestCloudRegion(targetLatitude, targetLongitude, options = {}, server = null) {
    if (typeof targetLatitude !== 'number' || typeof targetLongitude !== 'number') {
        return null;
    }

    let locations = options.cloudProviders || options.cloudProvidersList;
    if (!locations || locations.length === 0) {
        locations = await loadCloudProviders(options.autoscaleConfig || options.clouds || server, server);
    }

    const allowedProviders = options.providers ? options.providers.map(p => String(p).toLowerCase()) : null;
    let nearestMatch = null;
    let minDistance = Infinity;

    for (const loc of locations) {
        if (allowedProviders && !allowedProviders.includes(loc.provider.toLowerCase())) {
            continue;
        }

        const distance = calculateHaversineDistance(targetLatitude, targetLongitude, loc.lat, loc.lng);
        if (distance < minDistance) {
            minDistance = distance;
            nearestMatch = {
                provider: loc.provider,
                region: loc.region,
                datacenterName: loc.datacenterName || loc.name,
                countryCode: loc.countryCode || loc.country,
                coordinates: { latitude: loc.lat, longitude: loc.lng },
                distanceKm: Math.round(distance),
                instances: loc.instances || [],
                endpoints: loc.endpoints || {}
            };
        }
    }

    return nearestMatch;
}

/**
 * Calculates weighted geographic centroid across location points using 3D spherical vector conversion.
 * 
 * @param {Array<Object>} clients - Array of { latitude, longitude, count }
 * @returns {Object|null} Calculated centroid coordinates { latitude, longitude, totalWeight }
 */
export function calculateWeightedCentroid(clients) {
    if (!clients || clients.length === 0) return null;

    let totalWeight = 0;
    let xSum = 0;
    let ySum = 0;
    let zSum = 0;

    for (const loc of clients) {
        if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
            const weight = typeof loc.count === 'number' ? loc.count : 1;
            
            // Convert Latitude and Longitude to Radians
            const latRad = (loc.latitude * Math.PI) / 180;
            const lngRad = (loc.longitude * Math.PI) / 180;

            // Convert to 3D Cartesian coordinates on unit sphere
            xSum += Math.cos(latRad) * Math.cos(lngRad) * weight;
            ySum += Math.cos(latRad) * Math.sin(lngRad) * weight;
            zSum += Math.sin(latRad) * weight;

            totalWeight += weight;
        }
    }

    if (totalWeight === 0) return null;

    // Weighted average 3D vector
    const xAvg = xSum / totalWeight;
    const yAvg = ySum / totalWeight;
    const zAvg = zSum / totalWeight;

    // Convert 3D Cartesian coordinates back to spherical Latitude and Longitude
    const hyp = Math.sqrt(xAvg * xAvg + yAvg * yAvg);
    const latitude = (Math.atan2(zAvg, hyp) * 180) / Math.PI;
    const longitude = (Math.atan2(yAvg, xAvg) * 180) / Math.PI;

    return {
        latitude,
        longitude,
        totalWeight
    };
}

/**
 * Primary entry point: Calculates optimal cloud provider target and datacenter location.
 * Implements optional continent-based load shedding and fallback behavior.
 * Returns provider name, region name, and provider's defined instances catalog.
 * 
 * @param {Array<Object>} clients - Active client instances or location distribution map
 * @param {Object} [options] - Configuration options
 * @param {boolean} [options.geoScaleByContinent=false] - If true, isolates centroid calculation to specific continent thresholds
 * @param {Array<Object>} [options.existingNodes] - Array of already active node regions (e.g. [{ continent: 'EU' }])
 * @param {number} [options.sheddingThreshold=0] - Required traffic percentage in an unserved region to trigger shedding
 * @param {Object} [server] - Optional CoCreate server instance
 * @returns {Promise<Object|null>} Complete recommended target metadata containing cloud provider, region, and instances catalog
 */
export async function getCloudProvider(clients, options = {}, server = null) {
    if (!clients || clients.length === 0) {
        console.log("[@cocreate/server-autoscaler] [GEO-SCALING] No active client location data provided. Defaulting to provider default region.");
        return null;
    }

    // Load active cloud providers from autoscaleConfig or options
    const locations = options.cloudProviders || await loadCloudProviders(options.autoscaleConfig || options.clouds, server);

    const preferredProviders = options.preferredProviders || 
        (options.autoscaleConfig ? getValueFromObject(options.autoscaleConfig, 'autoscaler.preferredProviders') : null);

    const totalActiveClients = clients.reduce((sum, item) => sum + (item.count || 1), 0);

    // 1. GLOBAL SCALING MODE (Default behavior if continent scaling is disabled)
    if (!options.geoScaleByContinent) {
        const globalCentroid = calculateWeightedCentroid(clients);
        const nearestCloud = globalCentroid ? await findNearestCloudRegion(globalCentroid.latitude, globalCentroid.longitude, {
            providers: preferredProviders,
            cloudProviders: locations,
            autoscaleConfig: options.autoscaleConfig
        }, server) : null;

        return {
            geoScaleByContinent: false,
            targetCentroid: globalCentroid,
            nearestCloudRegion: nearestCloud,
            totalActiveClients,
            timestamp: Date.now()
        };
    }

    // 2. CONTINENT-BASED SCALING MODE
    const continentMap = {};

    // Group clients and aggregate weights per continent
    for (const client of clients) {
        const continent = client.continent || 'UNKNOWN';
        if (!continentMap[continent]) {
            continentMap[continent] = { continent, weight: 0, clients: [] };
        }
        continentMap[continent].weight += (client.count || 1);
        continentMap[continent].clients.push(client);
    }

    // Convert map to array and order by weight (highest traffic first)
    const orderedContinents = Object.values(continentMap).sort((a, b) => b.weight - a.weight);

    const existingNodes = options.existingNodes || [];
    const activeContinents = existingNodes.map(node => node.continent);
    const sheddingThresholdPct = options.sheddingThreshold || 0;

    let targetContinentData = null;
    let isSheddingTarget = false;

    // Find the first continent that DOES NOT have a server but MEETS the shedding threshold
    for (const cont of orderedContinents) {
        const percentage = (cont.weight / totalActiveClients) * 100;
        const hasServer = activeContinents.includes(cont.continent);

        if (!hasServer && percentage >= sheddingThresholdPct) {
            targetContinentData = cont;
            isSheddingTarget = true;
            console.log(`[@cocreate/server-autoscaler] [GEO-SCALING] [SHEDDING TRIGGERED] Targeting new continent [${cont.continent}] representing ${percentage.toFixed(1)}% of total load.`);
            break;
        }
    }

    // Fallback: If all regions already have servers or thresholds aren't met,
    // fallback to the continent with the absolute highest weight (the first item).
    if (!targetContinentData) {
        targetContinentData = orderedContinents[0];
    }

    // Calculate centroid strictly using the clients from the targeted continent
    const regionalCentroid = calculateWeightedCentroid(targetContinentData.clients);
    let nearestCloud = null;

    if (regionalCentroid) {
        nearestCloud = await findNearestCloudRegion(regionalCentroid.latitude, regionalCentroid.longitude, {
            providers: preferredProviders,
            cloudProviders: locations,
            autoscaleConfig: options.autoscaleConfig
        }, server);
    }

    return {
        geoScaleByContinent: true,
        targetContinent: targetContinentData.continent,
        isSheddingTarget,
        targetPercentage: parseFloat(((targetContinentData.weight / totalActiveClients) * 100).toFixed(1)),
        orderedContinents: orderedContinents.map(c => ({
            continent: c.continent,
            weight: c.weight,
            percentage: parseFloat(((c.weight / totalActiveClients) * 100).toFixed(1))
        })),
        targetCentroid: regionalCentroid,
        nearestCloudRegion: nearestCloud,
        totalActiveClients,
        timestamp: Date.now()
    };
}

export default getCloudProvider;