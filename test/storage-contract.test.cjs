const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
function extract(name) {
    const start = source.indexOf(`export async function ${name}(`);
    return source.slice(start, source.indexOf('\n/**', start)).replace('export async function', 'async function');
}

test('scale-out forwards the saved cluster storage and startup script to its workflow without fetching credentials or reserving inventory', async () => {
    const clusterConfig = { _id: 'cluster', storage: 'storage-id', startupScript: 'already rendered', clouds: ['cloud-api'] };
    const original = structuredClone(clusterConfig), requests = [];
    const context = vm.createContext({ clusterConfig,
        config: { get() { assert.fail('Dispatch does not read node credentials'); } },
        determineScaleOutTarget: async () => ({ apiId: 'cloud-api', region: 'example', type: 'small', dns: [] }),
        server: { organization_id: 'tenant', host: 'tenant.test',
            crud: { send() { assert.fail('The workflow owns inventory and storage validation'); } },
            api: { send() { assert.fail('Scale-out targets a workflow'); } },
            workflow: { run: async payload => { requests.push(JSON.parse(JSON.stringify(payload))); return { data: { id: 'i-test' } }; } }
        }
    });
    vm.runInContext(`${extract('runWorkflow')}\n${extract('scaleOut')}`, context);
    await context.scaleOut([]);
    assert.equal(requests[0].method, 'workflow.createOrganizationServer');
    assert.equal(requests[0].createOrganizationServer.storage, 'storage-id');
    assert.equal(requests[0].createOrganizationServer.startupScript, 'already rendered');
    assert.equal(requests[0].apikey, undefined);
    assert.deepEqual(clusterConfig, original);
});
