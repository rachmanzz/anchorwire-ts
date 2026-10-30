import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import {
  MAGIC,
  VERSION,
  OpCode,
  Flags,
  OpStatus,
  OrderByMode,
  crc32IEEE,
  appendString,
  readString,
  encodeFrame,
  decodeFrame,
  encodeAuthPayload,
  encodeSelectModelPayload,
  encodeSavePayload,
  decodeSavePayload,
  encodeSaveBatchPayload,
  decodeSaveBatchPayload,
  encodeGetRequest,
  decodeGetResultPayload,
  encodeEdgePayload,
  encodeCausalPayload,
  decodeCausalResultPayload,
  encodeListRequest,
  decodeListResponse,
  encodeUpdateRequest,
  decodeUpdateResponse,
  encodeGraphRequest,
  decodeGraphResponse,
  encodeGraphChainRequest,
  encodeAttachSchemaPayload,
  decodeGetSchemaPayload,
  encodeMathRequest,
  decodeMathResponse,
  encodeResetModelPayload,
  encodePartitionCatalogRequest,
  decodePartitionCatalogResponse,
  encodePartitionInspectRequest,
  decodePartitionInspectResponse,
  encodeOKPayload,
  decodeOKPayload,
  encodeErrorPayload,
  decodeErrorPayload,
  parseWireUrl,
  WireConnection,
  Client,
  connectWire,
  RecordItem,
} from '../src/index.js';

describe('AnchorWire Protocol & Codecs', () => {
  test('CRC32 IEEE calculation', () => {
    const data = Buffer.from('hello world', 'utf-8');
    const sum = crc32IEEE(data);
    // Standard IEEE 802.3 CRC32 of "hello world" is 0x0d4a1185
    assert.equal(sum, 0x0d4a1185);
    assert.equal(crc32IEEE(Buffer.alloc(0)), 0);
  });

  test('Frame encoding and decoding (Round-trip & Fragmentation)', () => {
    const payload = Buffer.from('test-payload-data', 'utf-8');
    const frame = {
      magic: MAGIC,
      version: VERSION,
      opCode: OpCode.Save,
      flags: Flags.None,
      seq: 42,
      payload,
    };

    const encoded = encodeFrame(frame);
    assert.equal(encoded.length, 16 + payload.length);

    // Partial header returns null
    assert.equal(decodeFrame(encoded.subarray(0, 10)), null);
    // Partial payload returns null
    assert.equal(decodeFrame(encoded.subarray(0, 20)), null);

    const decoded = decodeFrame(encoded);
    assert.notEqual(decoded, null);
    assert.equal(decoded!.bytesConsumed, encoded.length);
    assert.equal(decoded!.frame.magic, MAGIC);
    assert.equal(decoded!.frame.version, VERSION);
    assert.equal(decoded!.frame.opCode, OpCode.Save);
    assert.equal(decoded!.frame.seq, 42);
    assert.deepEqual(decoded!.frame.payload, payload);
  });

  test('Frame decoding rejects invalid magic, version, and corrupted checksum', () => {
    const badMagic = Buffer.alloc(16);
    badMagic[0] = 0x99;
    badMagic[1] = VERSION;
    assert.throws(() => decodeFrame(badMagic), /Invalid AnchorWire magic byte/);

    const badVersion = Buffer.alloc(16);
    badVersion[0] = MAGIC;
    badVersion[1] = 0x02;
    assert.throws(() => decodeFrame(badVersion), /Unsupported AnchorWire version/);

    const payload = Buffer.from('important-payload');
    const encoded = encodeFrame({
      magic: MAGIC,
      version: VERSION,
      opCode: OpCode.Get,
      flags: Flags.None,
      seq: 100,
      payload,
    });
    encoded[encoded.length - 1] ^= 0xff;
    assert.throws(() => decodeFrame(encoded), /Checksum mismatch/);
  });

  test('String codec bounds & UTF-8 safety', () => {
    const chunks: Buffer[] = [];
    appendString(chunks, 'halo dunia 🚀');
    const buf = Buffer.concat(chunks);
    const { value, nextOffset } = readString(buf, 0);
    assert.equal(value, 'halo dunia 🚀');
    assert.equal(nextOffset, buf.length);

    // Rejects strings > 65535 bytes instead of slicing mid-UTF8
    const oversized = 'a'.repeat(65536);
    assert.throws(() => appendString([], oversized), RangeError);
    assert.throws(() => readString(Buffer.from([0x05, 0x00, 0x61]), 0), /Truncated string content/);
  });

  test('Auth and Model Select Payloads', () => {
    const authBuf = encodeAuthPayload('secret-token-xyz');
    assert.equal(readString(authBuf, 0).value, 'secret-token-xyz');

    const modelBuf = encodeSelectModelPayload('banking_fraud');
    assert.equal(readString(modelBuf, 0).value, 'banking_fraud');
  });

  test('Save and SaveBatch payload round-trip', () => {
    const item: RecordItem = {
      name: 'atm_tx_9012',
      operation: OpStatus.Active,
      props: {
        amount: 2500000.0,
        risk_score: 0.85,
        lat: -6.2088,
        lon: 106.8456,
      },
      coord: { x: 106.8456, y: -6.2088 },
      roles: [1.0, 0.5, 0.0, 0.2],
    };

    const encoded = encodeSavePayload(item);
    const decoded = decodeSavePayload(encoded);

    assert.equal(decoded.name, item.name);
    assert.equal(decoded.operation, item.operation);
    assert.ok(Math.abs(decoded.props.amount - 2500000.0) < 0.01);
    assert.ok(Math.abs(decoded.props.risk_score - 0.85) < 0.001);
    assert.ok(decoded.coord);
    assert.ok(Math.abs(decoded.coord!.x - 106.8456) < 0.0001);
    assert.ok(Math.abs(decoded.coord!.y - -6.2088) < 0.0001);
    assert.ok(decoded.roles);
    assert.ok(Math.abs(decoded.roles![0] - 1.0) < 0.001);

    const batchEncoded = encodeSaveBatchPayload([item, { name: 'rec_2', props: { val: 42 } }]);
    const batchDecoded = decodeSaveBatchPayload(batchEncoded);
    assert.equal(batchDecoded.length, 2);
    assert.equal(batchDecoded[0].name, 'atm_tx_9012');
    assert.equal(batchDecoded[1].name, 'rec_2');
  });

  test('Get Request (all ComputeOp types) and Result payload (including ColdTier flag)', () => {
    const reqBuf = encodeGetRequest('order_1001', ['price', 'qty'], {
      c_div: { type: 'divide', fieldA: 'price', fieldB: 'qty' },
      c_mul: { type: 'multiply', fieldA: 'price', fieldB: 'qty' },
      c_add: { type: 'add', fieldA: 'price', fieldB: 'qty' },
      c_sub: { type: 'subtract', fieldA: 'price', fieldB: 'qty' },
      c_add_days: { type: 'addDays', field: 'created_at', days: 7 },
      c_sub_days: { type: 'subtractDays', field: 'created_at', days: 3 },
      c_between: { type: 'daysBetween', fieldA: 'end_at', fieldB: 'start_at' },
      c_assign: { type: 'assign', value: '100' },
    });
    assert.ok(reqBuf.length > 40);

    const resultBuf = Buffer.alloc(1 + 2 + (2 + 5 + 4));
    resultBuf[0] = OpStatus.Active;
    resultBuf.writeUInt16LE(1, 1);
    resultBuf.writeUInt16LE(5, 3);
    resultBuf.write('price', 5);
    resultBuf.writeFloatLE(150.5, 10);

    const decodedHot = decodeGetResultPayload(resultBuf, 'order_1001', Flags.None);
    assert.equal(decodedHot.name, 'order_1001');
    assert.equal(decodedHot.operation, OpStatus.Active);
    assert.equal(decodedHot.isColdTier, undefined);
    assert.ok(Math.abs(decodedHot.props.price - 150.5) < 0.01);

    const decodedCold = decodeGetResultPayload(resultBuf, 'order_1001', Flags.ColdTier);
    assert.equal(decodedCold.isColdTier, true);
  });

  test('Edge payload encoding (add, remove, set_relation)', () => {
    const buf = encodeEdgePayload('add', 'factory', 'supplies', 'warehouse', 0.95);
    assert.equal(buf[0], 0);
    assert.ok(buf.length > 10);

    const removeBuf = encodeEdgePayload('remove', 'nodeA', 'causes', 'nodeB');
    assert.equal(removeBuf[0], 1);

    const relBuf = encodeEdgePayload('set_relation', '', 'downlink', '', 0, { x: 0, y: -1 });
    assert.equal(relBuf[0], 2);
    assert.equal(relBuf.readFloatLE(relBuf.length - 8), 0);
    assert.equal(relBuf.readFloatLE(relBuf.length - 4), -1);
  });

  test('Causal query payload and response round-trip', () => {
    const req = encodeCausalPayload(['fuel_shortage', 'port_strike'], 'causes', 5);
    assert.ok(req.length > 0);

    const resBuf = Buffer.alloc(4 + (2 + 9 + 4));
    resBuf.writeUInt32LE(1, 0);
    resBuf.writeUInt16LE(9, 4);
    resBuf.write('inflation', 6);
    resBuf.writeFloatLE(0.855, 15);

    const results = decodeCausalResultPayload(resBuf);
    assert.equal(results.length, 1);
    assert.equal(results[0].word, 'inflation');
    assert.ok(Math.abs(results[0].score - 0.855) < 0.001);
  });

  test('List and Update Request/Response codecs', () => {
    const reqBuf = encodeListRequest({
      limit: 25,
      offset: 50,
      includeAllOperations: true,
      operationFilter: OpStatus.Active,
      allowedOperations: [OpStatus.Active, OpStatus.Archived],
      select: ['severity'],
      filters: [{ field: 'severity', operator: '>=', value: 3.0 }],
      computations: { double_sev: { type: 'multiply', fieldA: 'severity', fieldB: 'severity' } },
    });
    assert.ok(reqBuf.length > 20);

    // Build a ListResponse buffer with 1 item and 1 attribute
    const itemChunks: Buffer[] = [];
    const header = Buffer.alloc(9);
    header.writeUInt32LE(1, 0); // totalCount = 1
    header[4] = 0; // hasMore = false
    header.writeUInt32LE(1, 5); // itemCount = 1
    itemChunks.push(header);
    appendString(itemChunks, 'node_1');
    itemChunks.push(Buffer.from([OpStatus.Active, 1, 0])); // op = Active, attrCount = 1
    appendString(itemChunks, 'severity');
    const valB = Buffer.alloc(4);
    valB.writeFloatLE(4.5, 0);
    itemChunks.push(valB);

    const res = decodeListResponse(Buffer.concat(itemChunks));
    assert.equal(res.totalCount, 1);
    assert.equal(res.hasMore, false);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].name, 'node_1');
    assert.ok(Math.abs(res.items[0].props.severity - 4.5) < 0.01);

    // Update request & response
    const updateReq = encodeUpdateRequest({
      limit: 100,
      offset: 0,
      targetEntities: ['node_1'],
      filters: [{ field: 'severity', operator: '>', value: 1.0 }],
      mutations: { severity: { type: 'assign', value: '5.0' } },
    });
    assert.equal(updateReq.readUInt32LE(8), 1); // 4-byte targetEntities count

    const updateRespBuf = Buffer.alloc(4);
    updateRespBuf.writeUInt32LE(7, 0);
    assert.equal(decodeUpdateResponse(updateRespBuf), 7);
  });

  test('Graph, GraphChain, Schema, Math, ResetModel, and Partition codecs', () => {
    const graphReq = encodeGraphRequest(['center_node'], 'relates_to', 5, OrderByMode.Score, 0.75);
    assert.ok(graphReq.length > 0);

    const chainReq = encodeGraphChainRequest({
      inputs: ['node_a'],
      relationChain: ['r1', 'r2'],
      limitK: 5,
      beamWidth: 1.0,
    });
    assert.ok(chainReq.length > 12);

    // GraphResponse decoding
    const gChunks: Buffer[] = [];
    const gHeader = Buffer.alloc(12);
    gHeader.writeFloatLE(1.5, 0);
    gHeader.writeFloatLE(2.5, 4);
    gHeader.writeUInt32LE(1, 8);
    gChunks.push(gHeader);
    appendString(gChunks, 'target_node');
    const gMetrics = Buffer.alloc(20);
    gMetrics.writeFloatLE(0.95, 0); // score
    gMetrics.writeFloatLE(1.2, 4); // t
    gMetrics.writeFloatLE(0.05, 8); // distSqPerp
    gMetrics.writeFloatLE(3.0, 12); // x
    gMetrics.writeFloatLE(4.0, 16); // y
    gChunks.push(gMetrics);

    const decodedGraph = decodeGraphResponse(Buffer.concat(gChunks));
    assert.ok(Math.abs(decodedGraph.anchor.x - 1.5) < 0.01);
    assert.equal(decodedGraph.results.length, 1);
    assert.equal(decodedGraph.results[0].word, 'target_node');
    assert.ok(Math.abs(decodedGraph.results[0].score - 0.95) < 0.01);

    // Schema codecs
    const schemaStr = '{"fields":{"amount":"float32"}}';
    assert.equal(decodeGetSchemaPayload(encodeAttachSchemaPayload(schemaStr)), schemaStr);

    // Math request & response
    const mathReq = encodeMathRequest('distance', ['node_a', 'node_b'], 1);
    assert.ok(mathReq.length > 0);

    const mChunks: Buffer[] = [];
    const mHeader = Buffer.alloc(32);
    mHeader.writeFloatLE(5.0, 0); // value
    mHeader.writeFloatLE(1.0, 4); // coord.x
    mHeader.writeFloatLE(2.0, 8); // coord.y
    mHeader.writeFloatLE(0.5, 12); // roles[0]
    mHeader.writeUInt32LE(1, 28); // 1 neighbor
    mChunks.push(mHeader);
    appendString(mChunks, 'neighbor_1');
    mChunks.push(gMetrics);

    const decodedMath = decodeMathResponse(Buffer.concat(mChunks));
    assert.ok(Math.abs(decodedMath.value - 5.0) < 0.01);
    assert.equal(decodedMath.neighbors.length, 1);
    assert.equal(decodedMath.neighbors[0].word, 'neighbor_1');

    // ResetModel
    assert.equal(encodeResetModelPayload(true)[0], 1);
    assert.equal(encodeResetModelPayload(false)[0], 0);

    // PartitionCatalog & PartitionInspect
    assert.equal(encodePartitionCatalogRequest('supply_chain').toString('utf-8'), 'supply_chain');
    const catItems = decodePartitionCatalogResponse(
      Buffer.from(
        JSON.stringify([
          {
            id: 'p1',
            model: 'supply_chain',
            partition_file: 'part_01.anch',
            target_location: '/cold/part_01.anch',
            sink_type: 'local',
            record_count: 100,
            cutoff_date: '2026-01-01',
            min_date: 100,
            max_date: 200,
            created_at: '2026-01-01T00:00:00Z',
            size_bytes: 4096,
          },
        ]),
      ),
    );
    assert.equal(catItems.length, 1);
    assert.equal(catItems[0].id, 'p1');

    const inspReq = encodePartitionInspectRequest({ partition_file: 'part_01.anch', limit: 10 });
    const inspResp = decodePartitionInspectResponse(
      Buffer.from(JSON.stringify({ partition_file: 'part_01.anch', records: [{ name: 'r1', props: { a: 1 } }] })),
    );
    assert.ok(inspReq.length > 0);
    assert.equal(inspResp.partition_file, 'part_01.anch');
    assert.equal(inspResp.records?.length, 1);
  });

  test('OK and Error payload codecs', () => {
    const okBuf = encodeOKPayload('success: record saved');
    assert.equal(decodeOKPayload(okBuf), 'success: record saved');

    const errBuf = encodeErrorPayload(404, 'entity not found');
    const err = decodeErrorPayload(errBuf);
    assert.equal(err.code, 404);
    assert.equal(err.message, 'entity not found');
  });

  test('parseWireUrl handles IPv4, IPv6, and query parameters', () => {
    const opts1 = parseWireUrl('wire://10.0.0.5:7448?token=abc&model=fraud');
    assert.equal(opts1.host, '10.0.0.5');
    assert.equal(opts1.port, 7448);
    assert.equal(opts1.token, 'abc');
    assert.equal(opts1.model, 'fraud');

    const optsIpv6 = parseWireUrl('tcp://[::1]:7449?model=ipv6_model');
    assert.equal(optsIpv6.host, '::1');
    assert.equal(optsIpv6.port, 7449);
    assert.equal(optsIpv6.model, 'ipv6_model');
  });
});

describe('WireConnection & Client Socket Lifecycle (Mock TCP Server)', () => {
  test('Connection failure (ECONNREFUSED) rejects immediately without hanging', async () => {
    const conn = new WireConnection({
      host: '127.0.0.1',
      port: 65431, // Unbound port
      connectTimeoutMs: 1000,
    });

    await assert.rejects(async () => {
      await Promise.all([conn.connect(), conn.connect()]);
    });
  });

  test('TCP chunk fragmentation, coalesced frames, and deterministic model switching', async () => {
    const selectedModels: string[] = [];

    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length > 0) {
          const decoded = decodeFrame(buf);
          if (!decoded) break;
          buf = buf.subarray(decoded.bytesConsumed);

          const { frame } = decoded;
          if (frame.opCode === OpCode.Auth) {
            const resp = encodeFrame({
              magic: MAGIC,
              version: VERSION,
              opCode: OpCode.ResponseOK,
              flags: Flags.None,
              seq: frame.seq,
              payload: encodeOKPayload('authenticated'),
            });
            socket.write(resp);
          } else if (frame.opCode === OpCode.SelectModel) {
            const modelName = readString(frame.payload, 0).value;
            selectedModels.push(modelName);
            const resp = encodeFrame({
              magic: MAGIC,
              version: VERSION,
              opCode: OpCode.ResponseOK,
              flags: Flags.None,
              seq: frame.seq,
              payload: encodeOKPayload(modelName),
            });
            socket.write(resp);
          } else if (frame.opCode === OpCode.Save) {
            const item = decodeSavePayload(frame.payload);
            const resp = encodeFrame({
              magic: MAGIC,
              version: VERSION,
              opCode: OpCode.ResponseOK,
              flags: Flags.None,
              seq: frame.seq,
              payload: encodeOKPayload(item.name),
            });
            // Drip-feed response in 3-byte fragments to test TCP stream reassembly
            for (let i = 0; i < resp.length; i += 3) {
              socket.write(resp.subarray(i, Math.min(i + 3, resp.length)));
            }
          } else if (frame.opCode === OpCode.Ping) {
            const resp = encodeFrame({
              magic: MAGIC,
              version: VERSION,
              opCode: OpCode.ResponseOK,
              flags: Flags.None,
              seq: frame.seq,
              payload: encodeOKPayload('pong'),
            });
            socket.write(resp);
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as net.AddressInfo;

    try {
      const client = await connectWire(`wire://127.0.0.1:${addr.port}?token=tok1&model=model_alpha`);
      await client.ping();

      // Switch models via scoped client.model()
      const modelBeta = client.model('model_beta');
      const savedBeta = await modelBeta.save('entity_b', { v: 1 });
      assert.equal(savedBeta, 'entity_b');

      // Use original client (automatically switches back to model_alpha)
      const savedAlpha = await client.save('entity_a', { v: 2 });
      assert.equal(savedAlpha, 'entity_a');

      assert.deepEqual(selectedModels, ['model_alpha', 'model_beta', 'model_alpha']);
      client.close();
    } finally {
      server.close();
    }
  });
});
