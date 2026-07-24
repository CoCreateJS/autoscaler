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
 * @param {Array<Object>|Object} locations - Array of { latitude, longitude, count } or raw locations
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
 * Enhanced with Multi-Node Anycast Shedding & Secondary Continent Threshold logic.
 * 
 * @param {Iterable|Array|Object} clients - Active client instances or location distribution map
 * @param {Object} [options] - Configuration options
 * @param {Array<Object>} [options.existingNodes] - Array of already active node regions (e.g. [{ continent: 'EU', region: 'eu-central-1' }])
 * @param {number} [options.sheddingThreshold=0.40] - Secondary continent load percentage threshold (e.g. 0.40 for 40%)
 * @returns {Object|null} Complete recommended target metadata
 */
export function getCloudProvider(clients, options = {}) {
    const preferredProviders = options.preferredProviders || 
        (options.autoscaleConfig ? getValueFromObject(options.autoscaleConfig, 'autoscale.preferredProviders') : null);

    if (clients.length === 0) {
        console.log("[@cocreate/server-autoscaler] [GEO-SCALING] No active client location data provided. Defaulting to provider default region.");
        return null;
    }

    const totalActiveClients = clients.reduce((sum, item) => sum + item.count, 0);

    // 1. Group active client locations into continent macro-regions (EU, NA, AS, SA, OC, AF, ME)
    const continentBreakdown = {};
    for (const client of clients) {
        const continent = client.continent || 'UNKNOWN';
        if (!continentBreakdown[continent]) {
            continentBreakdown[continent] = { count: 0, locations: [] };
        }
        continentBreakdown[continent].count += client.count;
        continentBreakdown[continent].locations.push(client);
    }

    // Sort continents by active client load descending
    const sortedContinents = Object.keys(continentBreakdown)
        .sort((a, b) => continentBreakdown[b].count - continentBreakdown[a].count);

    const dominantContinent = sortedContinents[0];
    const maxContinentCount = continentBreakdown[dominantContinent].count;
    const dominantPercentage = parseFloat(((maxContinentCount / totalActiveClients) * 100).toFixed(1));

    const secondaryContinent = sortedContinents[1] || null;
    const secondaryCount = secondaryContinent ? continentBreakdown[secondaryContinent].count : 0;
    const secondaryPercentage = secondaryContinent ? parseFloat(((secondaryCount / totalActiveClients) * 100).toFixed(1)) : 0;

    // 2. Evaluate Multi-Node Shedding Logic against existing nodes
    const existingNodes = options.existingNodes || [];
    const sheddingThresholdPct = options.sheddingThreshold ?? 40.0; // Default 40% threshold

    const hasNodeInDominantContinent = existingNodes.some(node => node.continent === dominantContinent);

    let targetContinent = dominantContinent;
    let isSheddingTarget = false;

    if (hasNodeInDominantContinent && secondaryContinent && secondaryPercentage >= sheddingThresholdPct) {
        // A node already exists in the primary continent, and a secondary continent meets the shedding threshold!
        targetContinent = secondaryContinent;
        isSheddingTarget = true;
        console.log(`[@cocreate/server-autoscaler] [GEO-SCALING] [SHEDDING TRIGGERED] Node already active in primary region [${dominantContinent}]. Secondary region [${secondaryContinent}] load (${secondaryPercentage}%) >= threshold (${sheddingThresholdPct}%). Targeting [${secondaryContinent}] for Anycast offloading.`);
    }

    // 3. Calculate Centroid & Target Cloud Datacenter for target region
    const targetLocations = continentBreakdown[targetContinent].locations;
    const regionalCentroid = calculateWeightedCentroid(targetLocations);
    const globalCentroid = calculateWeightedCentroid(clientLocations);

    let nearestCloud = null;
    if (regionalCentroid) {
        nearestCloud = findNearestCloudRegion(regionalCentroid.latitude, regionalCentroid.longitude, {
            providers: Array.isArray(preferredProviders) ? preferredProviders : null
        });
    }

    return {
        dominantContinent,
        dominantPercentage,
        secondaryContinent,
        secondaryPercentage,
        targetContinent,
        isSheddingTarget,
        continentBreakdown,
        regionalCentroid,
        globalCentroid,
        nearestCloudRegion: nearestCloud,
        totalActiveClients,
        clientLocations,
        timestamp: Date.now()
    };
}

export default getCloudProvider;