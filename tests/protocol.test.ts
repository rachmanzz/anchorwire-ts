import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAGIC,
  VERSION,
  HEADER_SIZE,
  OpCode,
  OpStatus,
  OrderByMode,
  crc32IEEE,
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
  encodeMathRequest,
  decodeMathResponse,
  encodeOKPayload,
  decodeOKPayload,
  encodeErrorPayload,
  decodeErrorPayload,
  RecordItem,
} from '../src/index.js';

describe('AnchorWire Protocol & Codecs', () => {
  test('CRC32 IEEE calculation', () => {
    const input = Buffer.from('hello world', 'utf-8');
    const checksum = crc32IEEE(input);
    assert.equal(checksum, 0x0D4A1185);
  });

  test('Frame encoding and decoding (Round-trip)', () => {
    const payload = Buffer.from('test-payload-data', 'utf-8');
    const frame = {
      magic: MAGIC,
      version: VERSION,
      opCode: OpCode.Save,
      flags: 0,
      seq: 42,
      payload,
    };

    const encoded = encodeFrame(frame);
    assert.equal(encoded.length, HEADER_SIZE + payload.length);
    assert.equal(encoded[0], MAGIC);
    assert.equal(encoded[1], VERSION);
    assert.equal(encoded[2], OpCode.Save);
    assert.equal(encoded.readUInt32LE(4), 42);
    assert.equal(encoded.readUInt32LE(8), payload.length);

    const decoded = decodeFrame(encoded);
    assert.ok(decoded);
    assert.equal(decoded.bytesConsumed, encoded.length);
    assert.equal(decoded.frame.seq, 42);
    assert.equal(decoded.frame.opCode, OpCode.Save);
    assert.deepEqual(decoded.frame.payload, payload);
  });

  test('Frame decoding rejects invalid magic', () => {
    const frame = {
      magic: MAGIC,
      version: VERSION,
      opCode: OpCode.Ping,
      flags: 0,
      seq: 1,
      payload: Buffer.alloc(0),
    };
    const encoded = encodeFrame(frame);
    encoded[0] = 0x99; // Corrupt magic

    assert.throws(() => decodeFrame(encoded), /Invalid AnchorWire magic/);
  });

  test('Frame decoding rejects corrupted checksum', () => {
    const payload = Buffer.from('secure-transaction', 'utf-8');
    const frame = {
      magic: MAGIC,
      version: VERSION,
      opCode: OpCode.Save,
      flags: 0,
      seq: 1,
      payload,
    };
    const encoded = encodeFrame(frame);
    encoded[encoded.length - 1] ^= 0xFF; // Corrupt payload byte

    assert.throws(() => decodeFrame(encoded), /Checksum mismatch/);
  });

  test('Auth and Model Select Payloads', () => {
    const authBuf = encodeAuthPayload('secret-token-xyz');
    assert.ok(authBuf.length > 2);

    const modelBuf = encodeSelectModelPayload('banking_fraud');
    assert.ok(modelBuf.length > 2);
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

    // Batch test
    const batchEncoded = encodeSaveBatchPayload([item, { name: 'rec_2', props: { val: 42 } }]);
    const batchDecoded = decodeSaveBatchPayload(batchEncoded);
    assert.equal(batchDecoded.length, 2);
    assert.equal(batchDecoded[0].name, 'atm_tx_9012');
    assert.equal(batchDecoded[1].name, 'rec_2');
  });

  test('Get Request and Result payload', () => {
    const reqBuf = encodeGetRequest('order_1001', ['price', 'qty'], {
      total: { type: 'multiply', fieldA: 'price', fieldB: 'qty' },
    });
    assert.ok(reqBuf.length > 0);

    const resultBuf = Buffer.alloc(1 + 2 + (2 + 5 + 4));
    resultBuf[0] = OpStatus.Active;
    resultBuf.writeUInt16LE(1, 1); // 1 prop
    resultBuf.writeUInt16LE(5, 3); // key length: 'price'
    resultBuf.write('price', 5);
    resultBuf.writeFloatLE(150.5, 10);

    const decodedResult = decodeGetResultPayload(resultBuf, 'order_1001');
    assert.equal(decodedResult.name, 'order_1001');
    assert.equal(decodedResult.operation, OpStatus.Active);
    assert.ok(Math.abs(decodedResult.props.price - 150.5) < 0.01);
  });

  test('Edge payload encoding', () => {
    const buf = encodeEdgePayload('add', 'factory', 'supplies', 'warehouse', 0.95);
    assert.equal(buf[0], 0); // 0 = add
    assert.ok(buf.length > 10);

    const removeBuf = encodeEdgePayload('remove', 'nodeA', 'causes', 'nodeB');
    assert.equal(removeBuf[0], 1); // 1 = remove
  });

  test('Causal query payload and response round-trip', () => {
    const req = encodeCausalPayload(['fuel_shortage', 'port_strike'], 'causes', 5);
    assert.ok(req.length > 0);

    const resBuf = Buffer.alloc(4 + (2 + 9 + 4));
    resBuf.writeUInt32LE(1, 0); // 1 result
    resBuf.writeUInt16LE(9, 4); // 'inflation' length
    resBuf.write('inflation', 6);
    resBuf.writeFloatLE(0.855, 15);

    const results = decodeCausalResultPayload(resBuf);
    assert.equal(results.length, 1);
    assert.equal(results[0].word, 'inflation');
    assert.ok(Math.abs(results[0].score - 0.855) < 0.001);
  });

  test('List Request and Response encoding/decoding', () => {
    const reqBuf = encodeListRequest({
      limit: 25,
      offset: 50,
      filters: [{ field: 'severity', operator: '>=', value: 3.0 }],
    });
    assert.ok(reqBuf.length >= 9);

    const resBuf = Buffer.alloc(9);
    resBuf.writeUInt32LE(100, 0); // TotalCount
    resBuf[4] = 1; // HasMore
    resBuf.writeUInt32LE(0, 5); // 0 items in this mock

    const res = decodeListResponse(resBuf);
    assert.equal(res.totalCount, 100);
    assert.equal(res.hasMore, true);
    assert.equal(res.items.length, 0);
  });

  test('Graph and Math payload decoding', () => {
    const graphReq = encodeGraphRequest(['center_node'], 'relates_to', 5, OrderByMode.Score, 0.75);
    assert.ok(graphReq.length > 0);

    const mathReq = encodeMathRequest('distance', ['node_a', 'node_b'], 1);
    assert.ok(mathReq.length > 0);
  });

  test('OK and Error payload codecs', () => {
    const okBuf = encodeOKPayload('success: record saved');
    assert.equal(decodeOKPayload(okBuf), 'success: record saved');

    const errBuf = encodeErrorPayload(404, 'entity not found');
    const err = decodeErrorPayload(errBuf);
    assert.equal(err.code, 404);
    assert.equal(err.message, 'entity not found');
  });
});
