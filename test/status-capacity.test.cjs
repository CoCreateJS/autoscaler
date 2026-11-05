const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const getValueFromObject = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function extract(name, next = '\n/**') {
    const start = source.indexOf(`async function ${name}(`);
    return source.slice(start, source.indexOf(next, start));
}

async function snapshot(currentSample) {
    const statuses = ['running', 'running', 'draining', 'terminating', 'stopped', 'failed', 'terminated', 'provisioning'];
    const records = statuses.map((status, i) => ({
        _id: `node-${i}`, cluster_id: 'cluster-1', master: { status },
        worker1: { status: 'stopped', isDraining: true, isCordoned: true },
        infrastructure: { vCPU: i < 2 ? 2 : 1000, memoryGb: i < 2 ? 8 : 1000 }
    }));
    records.push({ _id: 'other-cluster', cluster_id: 'other', master: { status: 'running' } });
    const now = new Date().toISOString();
    const samples = records.map(record => ({
        serverId: record._id, workerId: 1, timestamp: now,
        cpu: { avg: record._id === 'node-0' ? 20 : record._id === 'node-1' ? 40 : 99 },
        memory: { avg_used_pct: record._id === 'node-0' ? 30 : record._id === 'node-1' ? 50 : 99 }
    }));
    const reads = [];
    const server = { id: 'node-0', cluster_id: 'cluster-1', organization_id: 'tenant', host: 'tenant.test', crud: {
        send: async request => {
            reads.push(plain(request));
            const query = request.filter.query;
            if (request.array === 'servers') {
                const status = query['master.status'];
                return { object: records.filter(record => record.cluster_id === query.cluster_id &&
                    (typeof status === 'string' ? record.master.status === status : status.$in.includes(record.master.status))) };
            }
            return { object: samples.filter(sample => query.serverId.$in.includes(sample.serverId) && sample.timestamp >= query.timestamp.$gte) };
        }
    } };
    const context = vm.createContext({ server });
    vm.runInContext(extract('getClusterDetails'), context);
    return { snapshot: await context.getClusterDetails({}, currentSample), reads };
}

test('only running masters supply load and active capacity; departing nodes stay separate', async () => {
    const { snapshot: result, reads } = await snapshot();
    assert.deepEqual(plain(result.servers.map(record => record._id)), ['node-0', 'node-1']);
    assert.deepEqual(plain(result.removingServers.map(record => record._id)), ['node-2', 'node-3']);
    assert.equal(result.totalCount, 2);
    assert.equal(result.pendingCount, 1);
    assert.equal(result.sampledServers, 2);
    assert.equal(result.avgCpu, 30);
    assert.equal(result.avgMemory, 40);
    assert.equal(result.serverMetrics.size, 2);
    assert.deepEqual(reads[2].filter.query.serverId.$in, ['node-0', 'node-1']);
    assert.equal(result.serverMetrics.get('node-0').cpu, 20, 'Worker flags do not exclude running-node telemetry');
});

test('a fresh local sample from a terminating master cannot reenter capacity calculations', async () => {
    const { snapshot: result } = await snapshot({
        serverId: 'node-3', workerId: 1, timestamp: new Date().toISOString(), interval_seconds: 60,
        cpu: { avg: 100 }, memory: { avg_used_pct: 100 }
    });
    assert.equal(result.avgCpu, 30);
    assert.equal(result.avgMemory, 40);
    assert.equal(result.serverMetrics.has('node-3'), false);
    assert.equal(result.sampledServers, 2);
});

function capacityContext(minimum) {
    const context = vm.createContext({
        autoscaleConfig: { scaleIn: { minClusterSize: minimum }, scaleOut: { cpuThreshold: 90, memoryThreshold: 90 } },
        getValueFromObject
    });
    vm.runInContext(source.slice(source.indexOf('function checkScaleInCapacity('), source.indexOf('\nasync function setMasterStatus(')), context);
    return context;
}

test('departing nodes cannot satisfy the remaining cluster minimum', async () => {
    const { snapshot: result } = await snapshot();
    result.pendingCount = 0;
    const decision = capacityContext(2).checkScaleInCapacity(result, 'node-0');
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /minimum/);
});

test('the candidate draining does not block its own post-drain capacity observation', async () => {
    const { snapshot: result } = await snapshot();
    result.pendingCount = 0;
    result.servers = result.servers.filter(record => record._id === 'node-1');
    result.removingServers = [{ _id: 'node-0', master: { status: 'draining' } }];
    const decision = capacityContext(1).checkScaleInCapacity(result, 'node-0', new Date(Date.now() - 1000).toISOString());
    assert.equal(decision.ok, true);
    result.removingServers.push({ _id: 'node-3', master: { status: 'terminating' } });
    assert.equal(capacityContext(1).checkScaleInCapacity(result, 'node-0').ok, false);
});

test('final-node capacity still permits zero only when the configured minimum is zero', () => {
    const result = { servers: [], pendingCount: 0, removingServers: [{ _id: 'candidate', master: { status: 'draining' } }], serverMetrics: new Map() };
    assert.equal(capacityContext(0).checkScaleInCapacity(result, 'candidate', new Date().toISOString()).ok, true);
    assert.equal(capacityContext(1).checkScaleInCapacity(result, 'candidate', new Date().toISOString()).ok, false);
});

test('scale-out placement excludes non-running masters from an explicit caller snapshot', async () => {
    let existingNodes;
    const profile = { provider: 'aws', region: 'region-1', instances: [{ name: 'small', vCPU: 2, memoryGb: 2, default: true }] };
    const context = vm.createContext({
        server: { cluster_id: 'cluster-1' }, allowedApis: [{ _id: 'aws-api', name: 'aws', provider: 'aws' }],
        autoscaleConfig: {}, isAutoscalingEnabled: () => true, getValueFromObject,
        loadCloudProviders: () => [profile],
        getCloudProvider: async (_, options) => {
            existingNodes = plain(options.existingNodes);
            return { nearestCloudRegion: { ...profile, providerType: 'aws', apiId: 'aws-api' } };
        },
        console: { log() {} }
    });
    vm.runInContext(extract('determineScaleOutTarget'), context);
    await context.determineScaleOutTarget([], [
        { master: { status: 'running' }, location: { continent: 'NA' } },
        { master: { status: 'terminating' }, location: { continent: 'EU' } },
        { master: { status: 'stopped' }, location: { continent: 'AS' } }
    ]);
    assert.deepEqual(existingNodes, [{ continent: 'NA' }]);
});

test('a non-running local master does not coordinate a new scaling decision', async () => {
    let actions = 0;
    const context = vm.createContext({
        server: { id: 'stopped-local', cluster_id: 'cluster-1' }, isAutoscalingEnabled: () => true, getValueFromObject,
        autoscaleConfig: { scaleOut: { cpuThreshold: 80, memoryThreshold: 80, consecutiveFlushes: 1, maxClusterSize: 0 },
            scaleIn: { cpuThreshold: 10, memoryThreshold: 10, consecutiveFlushes: 1, minClusterSize: 0 } },
        organizationIdle: false,
        workerStreaks: new Map(), evaluating: false, lastActionAt: 0, floorLeader: null, lastFloorCheckAt: 0,
        thresholdReached: (value, threshold) => value >= threshold, thresholdBelow: (value, threshold) => value < threshold,
        getClusterDetails: async () => ({ servers: [{ _id: 'other-node' }], removingServers: [], totalCount: 1,
            pendingCount: 0, sampledServers: 1, avgCpu: 99, avgMemory: 99 }),
        scaleOut: async () => { actions++; }, scaleIn: async () => { actions++; }, placementLocations: () => [],
        isScaleInCoordinator: () => true, console: { error() {} }
    });
    vm.runInContext(extract('onTelemetry'), context);
    await context.onTelemetry({ data: { serverId: 'stopped-local', workerId: 1, timestamp: new Date().toISOString(),
        interval_seconds: 1, cpu: { avg: 99 }, memory: { avg_used_pct: 99 } } });
    assert.equal(actions, 0);
});
