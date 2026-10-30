import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDate,
  formatDate,
  mustDate,
  parseTimestamp,
  formatTimestamp,
  divide,
  multiply,
  add,
  addConst,
  subtract,
  subtractConst,
  multiplyConst,
  divideConst,
  assign,
  value,
  addDays,
  subtractDays,
  daysBetween,
  computeCommitment,
  generateCommitmentPair,
  EntityResult,
  GetBuilder,
  ListBuilder,
  UpdateBuilder,
  GraphBuilder,
  MathEngine,
  WirePool,
  connectWirePool,
  OrderByMode,
  crc32IEEE,
} from '../src/index.js';
import { createServer, Server, Socket } from 'node:net';

describe('AnchorWire Go-Parity Feature Domains', () => {
  // Domain 1 & 2: Date Engine Utilities
  test('Date conversion: parseDate, formatDate, mustDate, fractional rounding', () => {
    // 1970-01-01 is day 0
    assert.equal(parseDate('1970-01-01'), 0);
    assert.equal(formatDate(0), '1970-01-01');

    // 2026-10-14 is 20,740 days since 1970-01-01
    const d2026 = parseDate('2026-10-14');
    assert.equal(d2026, 20740);
    assert.equal(formatDate(20740), '2026-10-14');
    assert.equal(mustDate('2026-10-14'), 20740);

    // Fractional rounding matching Go TestFormatDateFractionalRounding
    assert.equal(formatDate(20740.0), '2026-10-14');
    assert.equal(formatDate(20740.2), '2026-10-14');
    assert.equal(formatDate(20740.8), '2026-10-15');

    // Negative dates (before 1970)
    assert.equal(parseDate('1969-12-31'), -1);
    assert.equal(formatDate(-1), '1969-12-31');

    // Leap year verification
    assert.equal(parseDate('2024-02-29'), 19782);
    assert.equal(formatDate(19782), '2024-02-29');
    assert.throws(() => parseDate('2023-02-29')); // 2023 not leap year
    assert.equal(parseDate('2000-02-29'), 11016); // 2000 is leap century
    assert.throws(() => parseDate('1900-02-29')); // 1900 not leap century

    // Validation
    assert.throws(() => parseDate('invalid-date'));
    assert.throws(() => parseDate('2026-02-30')); // invalid calendar day
  });

  test('Timestamp conversion: parseTimestamp and formatTimestamp', () => {
    const tsStr = '2026-10-14 12:30:00';
    const unixSec = parseTimestamp(tsStr);
    assert.ok(unixSec > 0);
    const formatted = formatTimestamp(unixSec);
    assert.equal(formatted, tsStr);
  });

  // Domain 1: In-Storage Compute Operators
  test('In-storage compute operator helpers match Go signatures', () => {
    assert.deepEqual(divide('a', 'b'), { type: 'divide', fieldA: 'a', fieldB: 'b' });
    assert.deepEqual(multiply('x', 'y'), { type: 'multiply', fieldA: 'x', fieldB: 'y' });
    assert.deepEqual(add('p', 'q'), { type: 'add', fieldA: 'p', fieldB: 'q' });
    assert.deepEqual(addConst('base', 10.5), { type: 'add', fieldA: 'base', fieldB: '10.5' });
    assert.deepEqual(subtract('total', 'tax'), { type: 'subtract', fieldA: 'total', fieldB: 'tax' });
    assert.deepEqual(subtractConst('bal', 50), { type: 'subtract', fieldA: 'bal', fieldB: '50' });
    assert.deepEqual(multiplyConst('rate', 2), { type: 'multiply', fieldA: 'rate', fieldB: '2' });
    assert.deepEqual(divideConst('dist', 4), { type: 'divide', fieldA: 'dist', fieldB: '4' });
    assert.deepEqual(value(42), { type: 'assign', value: '42' });
    assert.deepEqual(assign('status_field'), { type: 'assign', value: 'status_field' });
    assert.deepEqual(addDays('due_date', 30), { type: 'addDays', field: 'due_date', days: 30 });
    assert.deepEqual(subtractDays('start_date', 7), { type: 'subtractDays', field: 'start_date', days: 7 });
    assert.deepEqual(daysBetween('end_date', 'start_date'), { type: 'daysBetween', fieldA: 'end_date', fieldB: 'start_date' });
  });

  // Domain 3: Rich EntityResult Wrapper
  test('Rich EntityResult wrapper provides accessor methods and date formatting', () => {
    const epochDays = parseDate('2026-10-14');
    const entity = new EntityResult('truck_alpha', 1, {
      speed: 65.5,
      start_date: epochDays,
      created_at: 1700000000,
    });

    assert.equal(entity.name, 'truck_alpha');
    assert.equal(entity.operation, 1);
    assert.equal(entity.get('speed'), 65.5);
    assert.equal(entity.get('non_existent'), 0);
    assert.equal(entity.has('speed'), true);
    assert.equal(entity.has('foo'), false);
    assert.equal(entity.getDate('start_date'), '2026-10-14');
    assert.ok(entity.getTimestamp('created_at').startsWith('2023-11-14'));
    assert.deepEqual(entity.all(), { speed: 65.5, start_date: epochDays, created_at: 1700000000 });
  });

  // Domain 8: Cryptographic Commitment Helpers
  test('Cryptographic commitment generation produces 32-byte SHA-256 digest', () => {
    const preimage = 'secret-rotation-validator-123';
    const commitment = computeCommitment(preimage);
    assert.equal(commitment.length, 32);

    // Deterministic check
    const commitment2 = computeCommitment(preimage);
    assert.deepEqual(commitment, commitment2);

    // Random pair generator
    const pair = generateCommitmentPair();
    assert.equal(pair.validator.length, 32);
    assert.equal(pair.commitment.length, 32);
    assert.deepEqual(computeCommitment(pair.validator), pair.commitment);
  });

  test('Driver convenience aliases and schema error constants', async () => {
    const {
      ErrSchemaMismatch,
      ErrSchemaLocked,
      ErrMissingRequiredField,
      ErrUnknownField,
      ErrInvalidFieldType,
    } = await import('../src/index.js');

    assert.ok(ErrSchemaMismatch.includes('schema mismatch'));
    assert.ok(ErrSchemaLocked.includes('locked'));
    assert.ok(ErrMissingRequiredField.includes('missing required field'));
    assert.ok(ErrUnknownField.includes('unknown field'));
    assert.ok(ErrInvalidFieldType.includes('invalid field type'));
  });

  // Domain 5: Fluent Query Builders
  test('Fluent Query Builders construct queries and execute through context', async () => {
    let lastGetArgs: unknown[] = [];
    let lastListArgs: unknown = null;
    let lastUpdateArgs: unknown = null;
    let lastGraphArgs: unknown[] = [];
    let lastChainArgs: unknown = null;
    let lastMathArgs: unknown[] = [];

    const mockContext = {
      async get(name: string, select?: string[], computations?: Record<string, any>) {
        lastGetArgs = [name, select, computations];
        return new EntityResult(name, 1, { score: 100 });
      },
      async list(options?: any) {
        lastListArgs = options;
        return { totalCount: 1, hasMore: false, items: [new EntityResult('item_1', 1, { val: 10 })] };
      },
      async update(options: any) {
        lastUpdateArgs = options;
        return 5;
      },
      async graph(inputs: string[], relation: string, limitK?: number, orderMode?: number, beamWidth?: number) {
        lastGraphArgs = [inputs, relation, limitK, orderMode, beamWidth];
        return { anchor: { x: 0, y: 0 }, results: [] };
      },
      async graphChain(options: any) {
        lastChainArgs = options;
        return [{ word: 'node_b', score: 0.9, t: 1, distSqPerp: 0, coord: { x: 1, y: 1 } }];
      },
      async math(op: any, words: string[], limitK?: number) {
        lastMathArgs = [op, words, limitK];
        return { value: 42, coord: { x: 1, y: 2 }, roles: [1, 0, 0, 0] as [number, number, number, number], neighbors: [] };
      },
    };

    // 1. GetBuilder
    const getB = new GetBuilder(mockContext, 'sensor_01');
    const getRes = await getB
      .select('temp', 'voltage', 'ratio')
      .compute('ratio', divide('temp', 'voltage'))
      .execute();

    assert.equal(getRes.name, 'sensor_01');
    assert.equal(lastGetArgs[0], 'sensor_01');
    assert.deepEqual(lastGetArgs[1], ['temp', 'voltage', 'ratio']);
    assert.deepEqual((lastGetArgs[2] as any).ratio, { type: 'divide', fieldA: 'temp', fieldB: 'voltage' });

    // 2. ListBuilder
    const listB = new ListBuilder(mockContext);
    const listRes = await listB
      .select('sku', 'stock')
      .where('created_at', '>=', '2026-10-14') // ISO date converted to epoch days!
      .whereBetween('price', 10, 50)
      .compute('discounted', multiplyConst('price', 0.9))
      .page(2, 25)
      .includeAllOperations(true)
      .execute();

    assert.equal(listRes.totalCount, 1);
    const listOpts = lastListArgs as any;
    assert.equal(listOpts.limit, 25);
    assert.equal(listOpts.offset, 25);
    assert.equal(listOpts.includeAllOperations, true);
    assert.equal(listOpts.filters[0].field, 'created_at');
    assert.equal(listOpts.filters[0].value, 20740); // parsed to epoch days
    assert.equal(listOpts.filters[1].operator, 'BETWEEN');
    assert.equal(listOpts.filters[1].value, 10);
    assert.equal(listOpts.filters[1].valueHigh, 50);

    // 3. UpdateBuilder
    const updateB = new UpdateBuilder(mockContext);
    const updatedCount = await updateB
      .in('truck_alpha', 'truck_beta')
      .where('status', '=', 1)
      .set('fuel', subtractConst('fuel', 10))
      .set('notes', 'inspected')
      .limit(10)
      .execute();

    assert.equal(updatedCount, 5);
    const upOpts = lastUpdateArgs as any;
    assert.deepEqual(upOpts.targetEntities, ['truck_alpha', 'truck_beta']);
    assert.deepEqual(upOpts.mutations.fuel, { type: 'subtract', fieldA: 'fuel', fieldB: '10' });
    assert.deepEqual(upOpts.mutations.notes, { type: 'assign', value: 'inspected' });

    // 4. GraphBuilder
    const graphB = new GraphBuilder(mockContext);
    await graphB.from('hub_a').relate('connects_to').topK(5).orderBy(OrderByMode.Distance).execute();
    assert.deepEqual(lastGraphArgs[0], ['hub_a']);
    assert.equal(lastGraphArgs[1], 'connects_to');
    assert.equal(lastGraphArgs[2], 5);
    assert.equal(lastGraphArgs[3], OrderByMode.Distance);

    // GraphChain traversal
    const chainB = new GraphBuilder(mockContext);
    await chainB.from('hub_a').chain('connects_to', 'links_to').topK(3).beamWidth(0.2).execute();
    assert.deepEqual(lastChainArgs, {
      inputs: ['hub_a'],
      relationChain: ['connects_to', 'links_to'],
      limitK: 3,
      beamWidth: 0.2,
    });

    // 5. MathEngine
    const mathEng = new MathEngine(mockContext);
    const dist = await mathEng.distance('point_a', 'point_b');
    assert.equal(dist, 42);
    assert.equal(lastMathArgs[0], 'distance');
    assert.deepEqual(lastMathArgs[1], ['point_a', 'point_b']);
  });
});

describe('AnchorWire Connection Pool (WirePool)', () => {
  let server: Server;
  let serverPort: number;

  test('WirePool manages multi-socket concurrency and connection reuse', async () => {
    // Start mock Wire TCP server
    server = createServer((socket: Socket) => {
      socket.on('data', (chunk) => {
        // Echo simple OK frame for Ping and request
        if (chunk.length >= 16) {
          const magic = chunk[0];
          const opCode = chunk[2];
          const seq = chunk.readUInt32LE(4);

          // Return OK response
          const okPayload = Buffer.from('\x02\x00OK', 'utf8');
          const header = Buffer.alloc(16);
          header[0] = magic;
          header[1] = 1;
          header[2] = 0x80; // ResponseOK
          header[3] = 0;
          header.writeUInt32LE(seq, 4);
          header.writeUInt32LE(okPayload.length, 8);

          // CRC IEEE of payload
          const checksum = crc32IEEE(okPayload);
          header.writeUInt32LE(checksum, 12);
          socket.write(Buffer.concat([header, okPayload]));
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        resolve();
      });
    });

    try {
      const pool = await connectWirePool({
        host: '127.0.0.1',
        port: serverPort,
        poolSize: 4,
        connectTimeoutMs: 2000,
      });

      // Verify model state isolation across withClient calls
      await pool.withClient(async (c) => {
        assert.equal(c.getModelName(), 'custom_tier');
      }, 'custom_tier');

      // Next call without targetModel must automatically revert to pool default
      await pool.withClient(async (c) => {
        assert.equal(c.getModelName(), 'default');
      });

      // Concurrently run 20 operations across pool
      const ops = Array.from({ length: 20 }, (_, i) =>
        pool.withClient(async (c) => {
          await c.ping();
          return `done_${i}`;
        })
      );

      const results = await Promise.all(ops);
      assert.equal(results.length, 20);
      assert.equal(results[0], 'done_0');

      pool.close();
    } finally {
      server.close();
    }
  });
});
