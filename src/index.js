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
import https from 'node:https';
import os from 'node:os';
import Config from '@cocreate/config';
import { getValueFromObject } from '@cocreate/utils';

// Guard clause verification to ensure cluster API abstraction integrity
const isPrimary = cluster.isPrimary !== undefined ? cluster.isPrimary : cluster.isMaster;

// ==============================================================================
// Module-Level Sandbox State (ESM Singleton Container)
// ==============================================================================
let serverCtx = null;             // Central reference to CoCreateServer Primary instance
let autoscaleConfig = null;       // Configured thresholds and duration constants
let isRunning = false;            // Execution loop flag

// Consecutive tracking counters to filter transient spikes
let consecutiveCpuSpikes = 0;
let consecutiveLowLoadTicks = 0;

// Timestamp tracking to prevent cascading scaling operations (Cooldown Management)
let lastScaleOperationTimestamp = 0;

// Default operational values for metrics-driven autoscale thresholds
const defaults = {
    scaleUpCpuThreshold: 80,             // CPU usage percentage trigger for Scaling Up (Sustained)
    scaleUpCpuExtremeThreshold: 90,      // Extreme CPU usage trigger for INSTANT Scaling Up (Single Flush)
    scaleDownCpuThreshold: 25,           // CPU usage percentage trigger for Scaling Down
    scaleUpMemoryThreshold: 85,          // Heap memory utilization trigger for Scaling Up
    consecutiveCpuSpikesRequired: 3,     // Require 3 consecutive flushes of high CPU (e.g. 3 minutes)
    consecutiveLowTicksRequired: 10,     // Require 10 consecutive flushes of low load (e.g. 10 minutes)
    minClusterSize: 2,                   // Never scale down below this active node count
    cooldownDurationMs: 300000,          // Cooldown lockout period to stabilize nodes (default: 5 minutes)
    provisioningApiEndpoint: 'https://api.cocreate.app/v1/infrastructure/scale'
};

/**
 * Normalizes dataset arrays returned from standard CRUD database operations.
 */
function normalizePeersList(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (Array.isArray(result.object)) return result.object;
    if (Array.isArray(result.data)) return result.data;
    return [];
}

/**
 * Recursively parses and evaluates an AST rule against a provided context.
 * 
 * @param {Object} node - AST node definition
 * @param {Object} context - Combined telemetry metrics and state counters
 * @returns {boolean} Outcome of the evaluation statement
 */
function evaluateAST(node, context) {
    if (!node) return false;

    switch (node.type) {
        case 'LogicalExpression': {
            const leftVal = evaluateAST(node.left, context);
            
            // Short-circuit evaluations to optimize V8 execution loops
            if (node.operator === 'OR' && leftVal) return true;
            if (node.operator === 'AND' && !leftVal) return false;

            const rightVal = evaluateAST(node.right, context);
            if (node.operator === 'OR') return leftVal || rightVal;
            if (node.operator === 'AND') return leftVal && rightVal;
            break;
        }

        case 'Condition': {
            const metricValue = getValueFromObject(context, node.metric);
            const targetValue = node.value;

            if (metricValue === undefined) {
                console.warn(`[@cocreate/server-autoscaler] AST metric resolution failed for token: "${node.metric}"`);
                return false;
            }

            switch (node.operator) {
                case 'GT': return metricValue > targetValue;
                case 'GTE': return metricValue >= targetValue;
                case 'LT': return metricValue < targetValue;
                case 'LTE': return metricValue <= targetValue;
                case 'EQ': return metricValue === targetValue;
                case 'NEQ': return metricValue !== targetValue;
                default: return false;
            }
        }

        default:
            console.warn(`[@cocreate/server-autoscaler] Unsupported AST node type detected: "${node.type}"`);
            return false;
    }
    return false;
}

/**
 * Invokes an external HTTPS API call modeled around standard CoCreate AST payload shapes.
 * If the Cloud Endpoint is offline or unreachable, falls back to a highly descriptive simulated log.
 * 
 * @param {string} direction - Target scaling direction ('up' | 'down')
 * @param {Object} metrics - Performance statistics triggering the scale event
 * @param {Object} actionConfig - Specific configuration parameters extracted from AST action node
 */
async function executeScaleAction(direction, metrics, actionConfig = {}) {
    const targetUrl = getValueFromObject(autoscaleConfig, 'autoscale.apiEndpoint') || defaults.provisioningApiEndpoint;
    const clusterSecret = process.env.CLUSTER_SECRET || 'LOCAL_SIMULATED_SECRET';

    // Build standard AST-modeled API Payload Object
    const payload = {
        method: actionConfig.method || 'infrastructure.scale',
        timestamp: new Date().toISOString(),
        serverId: serverCtx?.id || 'simulated-server-id',
        direction: direction,
        provider: actionConfig.provider || 'round-robin',
        spec: actionConfig.spec || 'standard',
        region: actionConfig.region || 'local',
        reason: {
            avgCpu: metrics.cpu?.avg || metrics.cpu?.totalUsage || 0,
            avgMemory: metrics.memory?.avg_used_pct || metrics.memory?.percentage || 0,
            message: `Autoscale execution triggered dynamically by AST rule evaluation.`
        },
        token: clusterSecret
    };

    // 1. Broadcast scaling details locally and over the P2P Server Mesh
    if (serverCtx && typeof serverCtx.send === 'function') {
        serverCtx.send({
            method: 'infrastructure.scale',
            broadcast: true,
            payload: payload
        });

        serverCtx.send({
            method: 'metric.scaleAlert',
            broadcast: true,
            direction,
            metrics: payload.reason
        });
    }

    // 2. Render highly visible console warning banners for local simulations
    console.log(`\n=============================================================================`);
    console.log(`[AUTOSCALER ALERT] DYNAMIC RESOURCE SCALE TRIGGERED`);
    console.log(`=============================================================================`);
    console.log(`* ACTION DIRECTION : ${direction.toUpperCase()}`);
    console.log(`* TARGET REGION    : ${payload.region.toUpperCase()}`);
    console.log(`* SYSTEM PROFILE   : ${payload.spec.toUpperCase()}`);
    console.log(`* INSTANCE METRIC  : CPU [${payload.reason.avgCpu}%], RAM [${payload.reason.avgMemory}%]`);
    console.log(`* TRIGGER MESSAGE  : ${payload.reason.message}`);
    console.log(`=============================================================================`);

    console.log(`[@cocreate/server-autoscaler] [ACTION] Dispatching AST scaling payload to endpoint: ${targetUrl}`);

    try {
        const urlObj = new URL(targetUrl);
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(JSON.stringify(payload))
            },
            timeout: 5000 // Limit network stall times
        };

        return await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        console.log(`[@cocreate/server-autoscaler] Scaling action response accepted: HTTP ${res.statusCode}`);
                        resolve(JSON.parse(body));
                    } else {
                        reject(new Error(`Scaling HTTP request failed: Status ${res.statusCode}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(JSON.stringify(payload));
            req.end();
        });
    } catch (err) {
        console.warn(`\n[@cocreate/server-autoscaler] [OFFLINE SIMULATOR] Cloud API Endpoint is unconfigured or unreachable (${err.message}).`);
        console.warn(`[@cocreate/server-autoscaler] [OFFLINE SIMULATOR] Gracefully running in simulation mode. scaling action succeeded locally.`);
        console.log(`=============================================================================\n`);
        return { simulated: true, status: 'acknowledged', direction };
    }
}

/**
 * Calculates a dynamic safety memory threshold percentage based on the physical core-to-memory ratio.
 * Ensures the system has enough physical MB of headroom to survive the boot provisioning delay.
 * 
 * @returns {number} Calculated maximum safe memory percentage threshold (capped between 50% and 90%)
 */
export function calculateDynamicSafetyThreshold() {
    const coresCount = os.cpus().length;
    const totalMemoryMb = os.totalmem() / 1024 / 1024;
    
    const allocationRatePerCoreMs = 15; // Estimated peak allocation speed in MB/sec under sustained load
    const bootWindowSeconds = 60;      // Boot delay window for new instances
    
    const requiredHeadroomMb = coresCount * allocationRatePerCoreMs * bootWindowSeconds;
    const headroomPercentage = (requiredHeadroomMb / totalMemoryMb) * 100;
    
    const maxSafePercentage = Math.round(100 - headroomPercentage);
    
    return Math.max(50, Math.min(90, maxSafePercentage));
}

/**
 * Queries the shared servers directory database to ensure we can safely remove this node 
 * without bringing the remaining active nodes below our configured minimum bounds.
 * 
 * @returns {boolean} Verified consensus state allowing scale-down
 */
async function isClusterSafeToScaleDown() {
    if (!serverCtx?.crud) {
        console.warn("[@cocreate/server-autoscaler] Database access layer is unavailable. Scaling down rejected.");
        return false;
    }

    const minSize = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.minClusterSize'), 10) || defaults.minClusterSize;

    try {
        const readResponse = await serverCtx.crud.send({
            method: 'object.read',
            array: 'servers',
            $filter: {
                query: { status: 'active' },
                limit: 0
            },
            organization_id: serverCtx.organization_id,
            host: serverCtx.host
        });

        const activeServers = normalizePeersList(readResponse);

        if (activeServers.length <= minSize) {
            console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Scale-down rejected. Active nodes (${activeServers.length}) is already at or below the minimum cluster limit (${minSize}).`);
            return false;
        }

        console.log(`[@cocreate/server-autoscaler] [CONSENSUS] Scale-down authorized. Cluster contains ${activeServers.length} active nodes (Safe margin: > ${minSize}).`);
        return true;
    } catch (err) {
        console.error("[@cocreate/server-autoscaler] Failed to verify consensus safety from DB, canceling scale down:", err.message);
        return false;
    }
}

/**
 * Intercepts high-priority 1-second instantaneous memory alerts and executes fast-track scaling.
 * 
 * @param {Object} metricPayload - Real-time metric snapshot collected on the 1-second tick
 */
async function processEmergencyAlert(metricPayload) {
    if (!isRunning) return;

    const cooldownDuration = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.cooldownDurationMs'), 10) || defaults.cooldownDurationMs;

    if (Date.now() - lastScaleOperationTimestamp < cooldownDuration) {
        return; 
    }

    const memoryPct = metricPayload.memory?.percentage || 0;

    lastScaleOperationTimestamp = Date.now();
    consecutiveCpuSpikes = 0; 
    consecutiveLowLoadTicks = 0;

    console.warn(`[@cocreate/server-autoscaler] [EMERGENCY ALERT] Instantaneous OOM threat detected! Memory: ${memoryPct}%. Initiating immediate fast-track scale-up...`);
    
    // Default action configuration for high-priority fast-track memory scale requests
    const emergencyActionConfig = {
        method: 'infrastructure.scale',
        provider: 'round-robin',
        spec: 'memory-optimized',
        region: 'local'
    };
    await executeScaleAction('up', metricPayload, emergencyActionConfig);
}

/**
 * Evaluates the pre-averaged flush packet directly against the threshold limits.
 * Handles both classic properties and advanced declarative AST-configured orchestration rules.
 * 
 * @param {Object} metricPayload - Normalized metrics data frame received on flush
 */
async function processMetricFlush(metricPayload) {
    if (!isRunning) return;

    const scaleUpCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleUpCpuThreshold'), 10) || defaults.scaleUpCpuThreshold;
    const scaleUpCpuExtreme = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleUpCpuExtremeThreshold'), 10) || defaults.scaleUpCpuExtremeThreshold;
    const scaleDownCpu = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleDownCpuThreshold'), 10) || defaults.scaleDownCpuThreshold;
    const cooldownDuration = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.cooldownDurationMs'), 10) || defaults.cooldownDurationMs;
    const spikesRequired = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.consecutiveCpuSpikesRequired'), 10) || defaults.consecutiveCpuSpikesRequired;
    const lowTicksRequired = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.consecutiveLowTicksRequired'), 10) || defaults.consecutiveLowTicksRequired;

    let targetMemoryThreshold = parseInt(getValueFromObject(autoscaleConfig, 'autoscale.scaleUpMemoryThreshold'), 10) || defaults.scaleUpMemoryThreshold;

    const isSafetyLimitsEnabled = getValueFromObject(autoscaleConfig, 'autoscale.safetyLimits') !== false && getValueFromObject(autoscaleConfig, 'autoscale.safetyLimits') !== 'false';
    
    if (isSafetyLimitsEnabled) {
        const dynamicSafetyThreshold = calculateDynamicSafetyThreshold();
        if (targetMemoryThreshold > dynamicSafetyThreshold) {
            console.warn(`[@cocreate/server-autoscaler] [SAFETY] Configured memory threshold (${targetMemoryThreshold}%) exceeds calculated safety limit for this system context (${dynamicSafetyThreshold}%). Clamping to ${dynamicSafetyThreshold}% to guarantee headroom during provisioning.`);
            targetMemoryThreshold = dynamicSafetyThreshold;
        }
    }

    if (Date.now() - lastScaleOperationTimestamp < cooldownDuration) {
        return; 
    }

    const cpuAvg = metricPayload.cpu?.avg || 0;
    const memoryAvg = metricPayload.memory?.avg_used_pct || 0;

    // Maintain and increment state accumulators
    if (cpuAvg >= scaleUpCpu) {
        consecutiveCpuSpikes++;
        consecutiveLowLoadTicks = 0; 
    } else {
        consecutiveCpuSpikes = 0; 
    }

    const isUnderloaded = cpuAvg <= scaleDownCpu && memoryAvg < (targetMemoryThreshold * 0.6);

    if (isUnderloaded) {
        consecutiveLowLoadTicks++;
    } else {
        consecutiveLowLoadTicks = 0;
    }

    // Build the consolidated evaluation context for the AST interpreter
    const evaluationContext = {
        ...metricPayload,
        consecutiveCpuSpikes,
        consecutiveLowLoadTicks
    };

    // Retrieve potential AST orchestration rules from configuration
    const customOrchestrationRule = getValueFromObject(autoscaleConfig, 'autoscale.orchestrationRule');

    if (customOrchestrationRule) {
        // --- DECLARATIVE AST EXECUTION TRACK ---
        console.log(`[@cocreate/server-autoscaler] Evaluating custom declarative AST scaling rules...`);
        
        const isTriggered = evaluateAST(customOrchestrationRule, evaluationContext);
        
        if (isTriggered) {
            const actionNode = customOrchestrationRule.action || {};
            lastScaleOperationTimestamp = Date.now();
            consecutiveCpuSpikes = 0;
            consecutiveLowLoadTicks = 0;

            console.warn(`[@cocreate/server-autoscaler] Custom AST evaluation resolved to TRUE. Triggering custom scaled action...`);
            await executeScaleAction('up', metricPayload, actionNode);
            return;
        }
    } else {
        // --- TRADITIONAL DUAL-TRACK HARDCODED FALLBACK ---
        const isMemoryPeaked = memoryAvg >= targetMemoryThreshold; 
        const isCpuExtremePeak = cpuAvg >= scaleUpCpuExtreme;     
        const isCpuSustainedPeak = consecutiveCpuSpikes >= spikesRequired;

        if (isCpuExtremePeak || isCpuSustainedPeak || isMemoryPeaked) {
            let triggerReason = '';
            let targetSpec = 'standard';

            if (isMemoryPeaked) {
                triggerReason = `Incompressible memory threshold exceeded (${memoryAvg}% >= limit: ${targetMemoryThreshold}%)`;
                targetSpec = 'memory-optimized';
            } else if (isCpuExtremePeak) {
                triggerReason = `Extreme CPU ceiling exceeded on a single flush (${cpuAvg}% >= limit: ${scaleUpCpuExtreme}%)`;
                targetSpec = 'compute-optimized';
            } else {
                triggerReason = `Sustained CPU threshold exceeded for ${consecutiveCpuSpikes} consecutive cycles (${cpuAvg}% >= limit: ${scaleUpCpu}%)`;
                targetSpec = 'compute-optimized';
            }

            lastScaleOperationTimestamp = Date.now();
            consecutiveCpuSpikes = 0; 

            console.warn(`[@cocreate/server-autoscaler] Peak limit hit! ${triggerReason}. Scaling up...`);
            await executeScaleAction('up', metricPayload, { spec: targetSpec });
            return;
        }
    }

    // Scale Down evaluation track: Consolidated across both AST and traditional modes
    if (consecutiveLowLoadTicks >= lowTicksRequired) {
        console.log(`[@cocreate/server-autoscaler] Low load sustained for ${consecutiveLowLoadTicks} consecutive cycles. Checking cluster state to verify consensus...`);
        
        const safeToScaleDown = await isClusterSafeToScaleDown();
        if (safeToScaleDown) {
            lastScaleOperationTimestamp = Date.now();
            consecutiveLowLoadTicks = 0; 
            
            console.log(`[@cocreate/server-autoscaler] Safe-down consensus verified. Scaling down...`);
            await executeScaleAction('down', metricPayload);
        } else {
            consecutiveLowLoadTicks = Math.round(lowTicksRequired / 2); 
        }
    }
}

/**
 * Boots the autoscaler system exclusively on the Master/Primary process context.
 * 
 * @param {Object} server - Central CoCreateServer instance references
 * @returns {Object} Active autoscale control API
 */
export async function init(server) {
    if (!isPrimary) {
        throw new Error("[@cocreate/server-autoscaler] [FATAL] Violation of scope: ServerAutoscaler can only run on the Primary (Master) process.");
    }

    serverCtx = server;

    autoscaleConfig = await Config.get('autoscale');

    const isEnabled = getValueFromObject(autoscaleConfig, 'autoscale.enabled') !== false && getValueFromObject(autoscaleConfig, 'autoscale.enabled') !== 'false';

    if (!isEnabled) {
        console.log('[@cocreate/server-autoscaler] ServerAutoscaler is disabled by configuration.');
        return { init, stop };
    }

    isRunning = true;
    
    consecutiveCpuSpikes = 0;
    consecutiveLowLoadTicks = 0;

    serverCtx.on('metric', (payload) => {
        if (payload && payload.data) {
            processMetricFlush(payload.data).catch(err => {
                console.error("[@cocreate/server-autoscaler] Error processing autoscale execution tick:", err);
            });
        }
    });

    serverCtx.on('metric.emergency', (payload) => {
        if (payload && payload.data) {
            processEmergencyAlert(payload.data).catch(err => {
                console.error("[@cocreate/server-autoscaler] Error processing emergency autoscale trigger:", err);
            });
        }
    });

    console.log('[@cocreate/server-autoscaler] Autoscaler initialized and subscribed to telemetry feed.');

    return {
        init,
        stop,
        processMetricFlush,
        processEmergencyAlert,
        executeScaleAction,
        calculateDynamicSafetyThreshold
    };
}

/**
 * Terminates monitoring sweeps and unsubscribes from the process emitter.
 */
export function stop() {
    isRunning = false;
    consecutiveCpuSpikes = 0;
    consecutiveLowLoadTicks = 0;
    console.log('[@cocreate/server-autoscaler] ServerAutoscaler monitoring stopped.');
}

export default {
    init,
    stop
};