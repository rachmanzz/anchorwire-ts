import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { connectWire, Client } from '../src/index.js';

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

const liveRunning = await isPortOpen('127.0.0.1', 7448);

describe('AnchorWire Live Integration (against real AnchorDB server)', { skip: !liveRunning }, () => {
  let client: Client;

  before(async () => {
    client = await connectWire({
      host: '127.0.0.1',
      port: 7448,
      token: 'test-token-123',
      model: 'ts_live_test',
    });
  });

  after(() => {
    client?.close();
  });

  test('Save and Get with In-Storage Math computation', async () => {
    // 1. Save single entity with coordinates and roles
    const savedName = await client.save(
      'server_alpha',
      {
        cpu_load: 80.0,
        factor: 2.5,
      },
      {
        coord: { x: 100.5, y: 200.5 },
        roles: [1.0, 0.0, 0.5, 0.0],
      }
    );
    assert.equal(savedName, 'server_alpha');

    // 2. Get entity with on-the-fly multiplication computation
    const record = await client.get('server_alpha', ['cpu_load', 'weighted_load'], {
      weighted_load: {
        type: 'multiply',
        fieldA: 'cpu_load',
        fieldB: 'factor',
      },
    });

    assert.equal(record.name, 'server_alpha');
    assert.ok(Math.abs(record.props.cpu_load - 80.0) < 0.01);
    assert.ok(Math.abs(record.props.weighted_load - 200.0) < 0.01);
  });

  test('SaveBatch and List query with pagination', async () => {
    const items = [
      { name: 'batch_node_1', props: { metric: 10.0 } },
      { name: 'batch_node_2', props: { metric: 20.0 } },
      { name: 'batch_node_3', props: { metric: 30.0 } },
    ];

    const savedNames = await client.saveBatch(items);
    assert.equal(savedNames.length, 3);

    const listResult = await client.list({ limit: 10 });
    assert.ok(listResult.totalCount >= 4); // server_alpha + 3 batch nodes
    assert.ok(listResult.items.length >= 4);

    const found = listResult.items.find((i) => i.name === 'batch_node_2');
    assert.ok(found);
    assert.ok(Math.abs(found!.props.metric - 20.0) < 0.01);
  });

  test('Update batch arithmetic mutation', async () => {
    const updatedCount = await client.update({
      targetEntities: ['server_alpha'],
      mutations: {
        scaled_cpu: {
          type: 'divide',
          fieldA: 'cpu_load',
          fieldB: 'factor',
        },
      },
    });

    assert.equal(updatedCount, 1);

    const updatedRec = await client.get('server_alpha');
    assert.ok(Math.abs(updatedRec.props.scaled_cpu - 32.0) < 0.01);
  });

  test('Causal graph Link, Traversal, and Unlink', async () => {
    // Construct causal chain: power_cut (0.9) -> server_crash (0.8) -> api_outage
    await client.link('power_cut', 'causes', 'server_crash', 0.9);
    await client.link('server_crash', 'causes', 'api_outage', 0.8);

    // Query multi-hop causal chain
    const chain = await client.causal('power_cut', 'causes', 5);
    assert.ok(chain.length >= 1);

    const serverCrash = chain.find((c) => c.word === 'server_crash');
    assert.ok(serverCrash);
    assert.ok(Math.abs(serverCrash!.score - 0.9) < 0.01);

    // Unlink power_cut -> server_crash
    await client.unlink('power_cut', 'causes', 'server_crash');

    // Verify after unlink
    const postUnlink = await client.causal('power_cut', 'causes', 5);
    const postServerCrash = postUnlink.find((c) => c.word === 'server_crash');
    assert.equal(postServerCrash, undefined);
  });

  test('Sync Write-Ahead Log to persistent storage', async () => {
    await assert.doesNotReject(async () => {
      await client.sync();
    });
  });

  test('Math calculations (distance, centroid, nearest)', async () => {
    await client.save('node_p1', { score: 1 }, { coord: { x: 0.0, y: 0.0 } });
    await client.save('node_p2', { score: 2 }, { coord: { x: 3.0, y: 4.0 } });

    // Distance calculation
    const dist = await client.math('distance', ['node_p1', 'node_p2']);
    assert.ok(Math.abs(dist.value - 5.0) < 0.01);

    // Centroid calculation
    const centroid = await client.math('centroid', ['node_p1', 'node_p2']);
    assert.ok(centroid.coord);
    assert.ok(Math.abs(centroid.coord.x - 1.5) < 0.01);
    assert.ok(Math.abs(centroid.coord.y - 2.0) < 0.01);

    // Nearest neighbors
    const nearest = await client.math('nearest', ['node_p1'], 2);
    assert.ok(nearest.neighbors.length >= 1);
  });

  test('Graph relation traversal and ResetModel', async () => {
    // 1. Configure relation direction vector
    await client.setRelation('downlink', { x: 0.0, y: -1.0 });

    // 2. Add directional edge
    await client.link('node_p1', 'downlink', 'node_p2', 1.0);

    const graphResult = await client.graph(['node_p1'], 'downlink', 5);
    assert.ok(graphResult.results.length >= 1);
    const foundTarget = graphResult.results.find((r) => r.word === 'node_p2' || r.word === 'batch_node_1');
    assert.ok(foundTarget);

    // Reset model
    await assert.doesNotReject(async () => {
      await client.resetModel(true);
    });
  });
});
