const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function extract(name) {
    const start = source.indexOf(`export async function ${name}(`);
    return source.slice(start, source.indexOf('\n/**', start)).replace('export async function', 'async function');
}
async function setup(t, { managed = true, reject = false, networkFailures = 0, networkCode = 'ECONNRESET', networkName = 'Error', response = { data: { instanceId: 'vm-2' } } } = {}) {
    const { init: initManager } = await import('../../cluster/src/manager.js');
    const { default: config } = await import('@cocreate/config');
    t.mock.method(config, 'get', () => undefined);
    t.mock.method(config, 'query', async () => undefined);
    const calls = [], order = [], inventoryWrites = [];
    const candidate = { _id: 'server-1', cluster_id: 'cluster-1', cloud: 'cloud-id', infrastructure: { instanceId: 'vm-1', region: 'region-1' } };
    const server = {
        isPrimary: true, id: 'server-1', organization_id: 'tenant', host: 'tenant.test', cluster_id: 'cluster-1',
        crud: { send: async request => { order.push(request.method); inventoryWrites.push(plain(request.object)); return { object: [request.object] }; } },
        state: { shutdown: payload => { order.push('shutdown'); calls.push({ shutdown: plain(payload) }); } },
        api: { send: async request => {
            order.push('send'); calls.push(plain(request));
            if (reject) throw new Error('transport failed');
            if (networkFailures-- > 0) throw Object.assign(new Error('connection reset'), { code: networkCode, name: networkName });
            const result = response;
            assert.equal(managed, false, 'Managed dispatch must bypass server.api.send');
            return result;
        } }
    };
    server.manager = await initManager(server);
    if (managed) Object.assign(server.manager, { organization_id: 'parent', host: 'parent.test', apiKey: 'test-only-management-key' });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        order.push('send'); calls.push({ url, options: { method: options.method, headers: options.headers }, request: JSON.parse(options.body) });
        if (reject) throw new Error('transport failed');
            if (networkFailures-- > 0) throw Object.assign(new Error('connection reset'), { code: networkCode, name: networkName });
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    });
    const context = vm.createContext({
        server, clusterHost: undefined, organizationIdle: true,
        isAutoscalingEnabled: () => true,
        autoscaleConfig: {
            name: 'cluster', storage: 'storage-id', startupScript: 'prepared-script', binaryUrl: 'https://example.test/runtime',
            endpoint: { create: 'create-instance', delete: 'delete-instance' },
            clouds: { aws: { method: { create: 'post', delete: 'post' } } },
            scaleIn: { minClusterSize: 0, drainWaitSeconds: 1 }
        },
        getValueFromObject: (object, path) => path.split('.').reduce((value, key) => value?.[key], object),
        uuid: () => 'suffix', ObjectId: () => ({ toString: () => 'server-2' }),
        determineScaleOutTarget: async () => ({ provider: 'parent-cloud', providerType: 'aws', region: 'region-1', instanceType: 'small', apiId: 'cloud-id' }),
        determineScaleInTarget: async () => ({ candidateServer: candidate }),
        allowedApis: [{ _id: 'cloud-id', name: 'parent-cloud', provider: 'aws' }],
        getClusterDetails: async () => ({ totalCount: 1, servers: [candidate], removingServers: [] }),
        checkScaleInCapacity: () => { order.push('capacity'); return { ok: true }; },
        setMasterStatus: async (id, status) => order.push(status),
        sendDrain: async (id, value) => order.push(`drain:${value}`),
        setTimeout: callback => callback(), console: { log() {}, error() {} }
    });
    vm.runInContext(`${extract('scaleOut')}\n${extract('scaleIn')}`, context);
    return { context, server, calls, order, inventoryWrites };
}
for (const action of ['scaleOut', 'scaleIn']) {
    test(`managed ${action} sends the prepared envelope directly over HTTPS`, async t => {
        const { context, server, calls, order, inventoryWrites } = await setup(t);
        const result = await context[action](action === 'scaleOut' ? [] : undefined);
        assert.deepEqual(plain(result), { data: { instanceId: 'vm-2' } });
        assert.equal(calls.length, action === 'scaleIn' ? 2 : 1);
        const outer = calls[0], inner = outer.request;
        assert.equal(outer.url, 'https://parent.test/manager');
        assert.equal(outer.options.headers.Authorization, 'Bearer test-only-management-key');
        assert.equal(inner.request, undefined);
        assert.equal(inner.api, 'parent-cloud');
        assert.equal(inner.endpoint, action === 'scaleOut' ? 'create-instance' : 'delete-instance');
        assert.equal(inner.method, 'post');
        for (const key of ['organization_id', 'host', 'apikey', 'socket']) assert.equal(inner[key], undefined);
        if (action === 'scaleIn') {
            assert.equal(inner.data.server_id, 'server-1');
            assert.equal(inner.data.cluster_id, 'cluster-1');
            assert.equal(inner.data.vmId, 'vm-1');
            assert.ok(order.indexOf('drain:true') < order.indexOf('send'));
            assert.equal(order.filter(item => item === 'capacity').length, 2);
            assert.ok(order.indexOf('terminating') < order.indexOf('send'));
            assert.deepEqual(order.slice(-2), ['send', 'shutdown']);
            assert.equal(order.includes('object.delete'), false);
        } else {
            assert.deepEqual(inventoryWrites[0].manager, { ...server.manager });
            assert.equal(inner.data.cluster_id, 'cluster-1');
            assert.equal(inner.data.server_id, 'server-2');
            assert.ok(order.indexOf('object.create') < order.indexOf('send'));
        }
    });
    test(`unmanaged ${action} retains direct provider dispatch`, async t => {
        const { context, calls, order } = await setup(t, { managed: false });
        await context[action](action === 'scaleOut' ? [] : undefined);
        assert.equal(calls[0].api, 'parent-cloud');
        assert.equal(calls[0].organization_id, 'tenant');
        assert.equal(calls[0].data.request, undefined);
        if (action === 'scaleIn') {
            assert.ok(order.indexOf('terminating') < order.indexOf('send'));
            assert.deepEqual(order.slice(-2), ['send', 'shutdown']);
            assert.equal(order.includes('object.delete'), false);
        }
    });
}
test('failed managed scale-in records failure before shutting down the target', async t => {
    const { context, order } = await setup(t, { reject: true });
    await assert.rejects(context.scaleIn(), /transport failed/);
    assert.equal(order.includes('drain:false'), false);
    assert.deepEqual(order.slice(-2), ['failed', 'shutdown']);
});
test('failed managed scale-out retains the failed-inventory update', async t => {
    const { context, order } = await setup(t, { reject: true });
    await assert.rejects(context.scaleOut([]), /transport failed/);
    assert.equal(order.at(-1), 'object.update');
});
test('managed dispatch rejects malformed or failed responses', async t => {
    const { init: initManager } = await import('../../cluster/src/manager.js');
    const { default: config } = await import('@cocreate/config');
    t.mock.method(config, 'get', () => undefined);
    t.mock.method(config, 'query', async () => undefined);
    let result;
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }));
    for (const response of [null, { success: false, data: {} }, { error: ['failed'], data: {} }]) {
        result = response;
        const manager = await initManager({ isPrimary: true });
        Object.assign(manager, { organization_id: 'parent', host: 'parent.test', apiKey: 'test' });
        await assert.rejects(manager.send({ method: 'post' }), /manager/i);
    }
});


test('AutoScaler writes removal status to master.status without replacing the master object', async () => {
    const writes = [];
    const server = { organization_id: 'tenant', host: 'tenant.test', crud: { send: async request => {
        writes.push(plain(request));
        return { object: [request.object] };
    } } };
    const start = source.indexOf('async function setMasterStatus(');
    const end = source.indexOf('\nasync function sendDrain(', start);
    const context = vm.createContext({ server });
    vm.runInContext(source.slice(start, end), context);
    await context.setMasterStatus('server-1', 'terminating');
    assert.deepEqual(writes, [{ method: 'object.update', array: 'servers', object: {
        _id: 'server-1', 'master.status': 'terminating'
    }, organization_id: 'tenant', host: 'tenant.test' }]);
});

test('cluster snapshots include draining and terminating masters for removal coordination', async () => {
    const reads = [];
    const server = { id: 'server-1', cluster_id: 'cluster-1', organization_id: 'tenant', host: 'tenant.test', crud: {
        send: async request => { reads.push(plain(request)); return { object: [] }; }
    } };
    const start = source.indexOf('async function getClusterDetails(');
    const end = source.indexOf('\n/**', start);
    const context = vm.createContext({ server });
    vm.runInContext(source.slice(start, end), context);
    await context.getClusterDetails();
    assert.deepEqual(reads[0].filter.query, {
        'master.status': { $in: ['running', 'draining', 'terminating'] }, cluster_id: 'cluster-1'
    });
});

for (const managed of [true, false]) {
    test(`termination retries a network error before shutdown (managed=${managed})`, async t => {
        const { context, calls, order } = await setup(t, { managed, networkFailures: 1 });
        await context.scaleIn();
        assert.equal(calls.filter(call => !call.shutdown).length, 2);
        assert.ok(order.indexOf('terminating') < order.indexOf('send'));
            assert.deepEqual(order.slice(-2), ['send', 'shutdown']);
        assert.deepEqual(calls.at(-1).shutdown, { server: 'server-1', master: true, organization_id: 'tenant' });
    });
    test(`exhausted termination retries mark failed then shutdown (managed=${managed})`, async t => {
        const { context, calls, order } = await setup(t, { managed, networkFailures: 2 });
        await assert.rejects(context.scaleIn(), /connection reset/);
        assert.equal(calls.filter(call => !call.shutdown).length, 2);
        assert.deepEqual(order.slice(-2), ['failed', 'shutdown']);
    });
    test(`provider failure is not retried (managed=${managed})`, async t => {
        const { context, calls, order } = await setup(t, { managed, response: { success: false } });
        await assert.rejects(context.scaleIn());
        assert.equal(calls.filter(call => !call.shutdown).length, 1);
        assert.deepEqual(order.slice(-2), ['failed', 'shutdown']);
    });
}
test('cancelled capacity observation restores service without terminating or shutting down', async t => {
    const { context, calls, order } = await setup(t);
    let observations = 0;
    context.checkScaleInCapacity = () => ++observations === 1 ? { ok: true } : { ok: false, reason: 'Capacity changed.' };
    await assert.rejects(context.scaleIn(), /Capacity changed/);
    assert.deepEqual(calls, []);
    assert.deepEqual(order.slice(-2), ['drain:false', 'running']);
});

test('terminal master status is mirrored before shutdown can proceed', async () => {
    const order = [];
    const server = { organization_id: 'tenant', host: 'tenant.test', crud: { send: async request => {
        order.push(['local', plain(request)]);
        return { object: [request.object] };
    } }, manager: { organization_id: 'parent', send: async request => order.push(['manager', plain(request)]) } };
    const start = source.indexOf('async function setMasterStatus(');
    const end = source.indexOf('\nasync function sendDrain(', start);
    const context = vm.createContext({ server, console });
    vm.runInContext(source.slice(start, end), context);
    await context.setMasterStatus('target-server', 'failed');
    assert.deepEqual(order.map(item => item[0]), ['local', 'manager']);
    assert.deepEqual(order[0][1], order[1][1]);
    assert.equal(order[1][1].object['master.status'], 'failed');
});
test('failure to commit terminating prevents the provider request and shutdown', async t => {
    const { context, order } = await setup(t);
    context.setMasterStatus = async (id, status) => {
        order.push(status);
        if (status === 'terminating') throw new Error('Inventory unavailable.');
    };
    await assert.rejects(context.scaleIn(), /Inventory unavailable/);
    assert.equal(order.includes('shutdown'), false);
    assert.equal(order.includes('send'), false);
});

for (const [managed, networkName] of [[false, 'AbortError'], [true, 'TimeoutError']]) {
    test(`termination retries ${networkName} produced by its HTTP transport`, async t => {
        const { context, calls, order } = await setup(t, { managed, networkFailures: 1, networkCode: null, networkName });
        await context.scaleIn();
        assert.equal(calls.filter(call => !call.shutdown).length, 2);
        assert.ok(order.indexOf('terminating') < order.indexOf('send'));
            assert.deepEqual(order.slice(-2), ['send', 'shutdown']);
    });
}

test('low utilization cannot remove the last node without an organization-idle signal', async t => {
    const { context, calls } = await setup(t);
    context.organizationIdle = false;
    assert.equal(await context.scaleIn(), null);
    assert.deepEqual(calls, []);
});

test('idle selection targets the current node while ordinary scale-in retains the configured strategy', async () => {
    const records = [
        { _id: 'older-peer', created: '2025-01-01' },
        { _id: 'local-node', created: '2026-01-01' }
    ];
    let reads = 0;
    const context = vm.createContext({
        server: { id: 'local-node', cluster_id: 'cluster' },
        autoscaleConfig: { scaleIn: { minClusterSize: 0, decommissionStrategy: 'oldest' } },
        organizationIdle: true,
        isAutoscalingEnabled: () => true,
        getValueFromObject: (object, path) => path.split('.').reduce((value, key) => value?.[key], object),
        getClusterDetails: async () => { reads++; return { servers: records, removingServers: [] }; },
        console: { log() {} }
    });
    vm.runInContext(extract('determineScaleInTarget'), context);
    assert.equal((await context.determineScaleInTarget({ strategy: 'local' })).candidateServer._id, 'local-node');
    assert.equal(reads, 1);
    assert.equal((await context.determineScaleInTarget()).candidateServer._id, 'older-peer');
});
