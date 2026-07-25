import { getValueFromObject, cloudProviders } from '@cocreate/utils';

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
 * Finds the nearest cloud datacenter region across all providers (or an allowed subset)
 * to a target latitude/longitude centroid.
 * 
 * @param {number} targetLatitude - Target Latitude centroid
 * @param {number} targetLongitude - Target Longitude centroid
 * @param {Object} [options] - Optional filters (e.g. preferred providers)
 * @returns {Object|null} Recommended provider region metadata and distance in KM
 */
export function findNearestCloudRegion(targetLatitude, targetLongitude, options = {}) {
    if (typeof targetLatitude !== 'number' || typeof targetLongitude !== 'number') {
        return null;
    }

    const allowedProviders = options.providers ? options.providers.map(p => String(p).toLowerCase()) : null;
    let nearestMatch = null;
    let minDistance = Infinity;

    for (const loc of cloudProviders) {
        if (allowedProviders && !allowedProviders.includes(loc.provider.toLowerCase())) {
            continue;
        }

        const distance = calculateHaversineDistance(targetLatitude, targetLongitude, loc.lat, loc.lng);
        if (distance < minDistance) {
            minDistance = distance;
            nearestMatch = {
                provider: loc.provider,
                region: loc.region,
                datacenterName: loc.name,
                countryCode: loc.country,
                coordinates: { latitude: loc.lat, longitude: loc.lng },
                distanceKm: Math.round(distance)
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
 * 
 * @param {Array<Object>} clients - Active client instances or location distribution map
 * @param {Object} [options] - Configuration options
 * @param {boolean} [options.geoScaleByContinent=false] - If true, isolates centroid calculation to specific continent thresholds
 * @param {Array<Object>} [options.existingNodes] - Array of already active node regions (e.g. [{ continent: 'EU' }])
 * @param {number} [options.sheddingThreshold=0] - Required traffic percentage in an unserved region to trigger shedding (e.g. 20 for 20%)
 * @returns {Object|null} Complete recommended target metadata
 */
export function getCloudProvider(clients, options = {}) {
    if (!clients || clients.length === 0) {
        console.log("[@cocreate/server-autoscaler] [GEO-SCALING] No active client location data provided. Defaulting to provider default region.");
        return null;
    }

    const preferredProviders = options.preferredProviders || 
        (options.autoscaleConfig ? getValueFromObject(options.autoscaleConfig, 'autoscale.preferredProviders') : null);

    const totalActiveClients = clients.reduce((sum, item) => sum + (item.count || 1), 0);

    // 1. GLOBAL SCALING MODE (Default behavior if continent scaling is disabled)
    if (!options.geoScaleByContinent) {
        const globalCentroid = calculateWeightedCentroid(clients);
        const nearestCloud = globalCentroid ? findNearestCloudRegion(globalCentroid.latitude, globalCentroid.longitude, {
            providers: preferredProviders
        }) : null;

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
    const sheddingThresholdPct = options.sheddingThreshold || 0; // Default to 0% (any traffic triggers shedding)

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
        nearestCloud = findNearestCloudRegion(regionalCentroid.latitude, regionalCentroid.longitude, {
            providers: preferredProviders
        });
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