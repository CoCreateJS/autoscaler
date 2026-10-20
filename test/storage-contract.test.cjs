const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
const start = source.indexOf('export async function scaleOut(');
const end = source.indexOf('\n/**', start);
const scaleOut = source.slice(start, end).replace('export async function', 'async function');

async function run(storage = 'storage-id') {
    const requests = [];
    const crudRequests = [];
    const context = vm.createContext({
        autoscaleConfig: { storage, host: 'example.com', startupScript: { $concat: [['script']] }, binaryUrl: 'https://example.com/runtime.tar.gz', endpoint: { create: 'create-instance' } },
        getValueFromObject: (object, path) => path.split('.').reduce((value, key) => value?.[key], object),
        config: { get() { assert.fail('Autoscaler must not read bootstrap credentials'); } },
        determineScaleOutTarget: async () => ({ provider: 'test-cloud', providerType: 'aws', region: 'example', instanceType: 'small', apiId: 'api-id' }),
        ObjectId: () => ({ toString: () => 'server-id' }),
        console: { log() {}, error() {} },
        server: {
            host: 'example.com', organization_id: 'platform', cluster_id: 'cluster-id',
            crud: { send: async request => {
                crudRequests.push(request);
                assert.equal(request.array, 'servers', 'Autoscaler must not fetch storage from apis');
                return { object: [request.object] };
            } },
            api: { send: async request => {
                requests.push(request);
                return { data: { instanceId: 'instance-id' } };
            } }
        }
    });
    vm.runInContext(scaleOut, context);
    await context.scaleOut([]);
    return { requests, crudRequests };
}

test('autoscaler passes the cluster storage ID directly to create-instance', async () => {
    const { requests, crudRequests } = await run();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].data.storage, 'storage-id');
    assert.equal(requests[0].data.storageProvider, undefined);
    assert.equal(requests[0].data.cluster_id, 'cluster-id');
    assert.equal(crudRequests.length, 1);
});

test('autoscaler requires a storage ID instead of embedded bootstrap credentials', async () => {
    await assert.rejects(run(''), /storage API record ID/);
    await assert.rejects(run({ name: 'mongo', provider: 'mongodb', connectionString: 'mongodb://example' }), /storage API record ID/);
});
