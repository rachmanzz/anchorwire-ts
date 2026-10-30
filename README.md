# @rahmantech/anchorwire

Official high-performance TypeScript and Node.js client for **AnchorDB** using the native binary **AnchorWire** protocol (`wire://` over TCP port `7448`).

## Features

- **100% Pure TypeScript & Zero External Runtime Dependencies**: Built directly on `node:net` and native `Buffer` with custom IEEE 802.3 CRC32 framing.
- **Ultra Low Latency**: Direct binary serialization over persistent TCP socket connection (~0.1ms loopback latency).
- **Multi-Socket Connection Pooling (`WirePool`)**: High-concurrency connection pool managing parallel socket connections without head-of-line blocking.
- **Fluent Query Builders**: Fluent APIs for entity reading, filtered paged listing, batch mutations, spatial beam ray-casting, and mathematical graph operations.
- **In-Storage Compute Operators**: Direct helper functions (`divide`, `multiply`, `add`, `addConst`, `subtract`, `subtractConst`, `multiplyConst`, `divideConst`, `assign`, `value`, `addDays`, `subtractDays`, `daysBetween`).
- **Date & Calendar Mathematics**: Native conversion between ISO-8601 strings and AnchorDB IEEE 754 float32 Epoch Days (`parseDate`, `formatDate`, `mustDate`, `formatTimestamp`).
- **Rich Entity Results**: Built-in accessors (`.get()`, `.has()`, `.all()`, `.getDate()`, `.getTimestamp()`).
- **Schema Contract & Optional Fields**: Lock model schemas upfront with strict scalar types (`int`, `float`, `bool`, `date`) and nullable/optional modifiers (`int?`, `float?`, `bool?`, `date?`).
- **Sub-Microsecond Operations**:
  - `attachSchema` / `getSchema` / `resetModel`: Upfront schema locking with required and optional field validation.
  - `save` / `saveBatch` / `appendNode` / `saveAutoID` / `saveWithID`: High-throughput entity and spatial node persistence.
  - `get`: Entity retrieval with on-the-fly math computations.
  - `list`: Paged queries with in-storage predicate pushdown.
  - `update`: In-place batch arithmetic mutations.
  - `link` / `unlink` / `setRelation`: Causal graph edge creation, tombstoning, and spatial direction vectors.
  - `causal` / `causalChain`: Multi-hop cause-and-effect path scoring.
  - `graph` / `graphChain`: 2D spatial beam ray-casting and multi-hop relation traversal.
  - `math`: In-storage Euclidean distance, centroid, cosine similarity, and nearest neighbors.

---

## Installation

```bash
npm install @rahmantech/anchorwire
# or
pnpm add @rahmantech/anchorwire
# or
bun add @rahmantech/anchorwire
```

---

## Locking Schema Upfront & Optional Fields (`attachSchema`)

To allow records with **optional fields** (and enforce type validation across writes), lock the model schema upfront using `client.attachSchema()` **before** inserting records.

### Supported Schema Field Types

Append `?` to any base type to mark that property as **optional** (omittable during `save` and `saveBatch`):

| Type | Optional Variant | Description & Storage Constraint |
| :--- | :--- | :--- |
| `'float'` | `'float?'` | Any finite `float32` numeric value |
| `'int'` | `'int?'` | Whole integer value (`val === Math.trunc(val)`) |
| `'bool'` | `'bool?'` | Boolean flag (`1.0` for true, `0.0` for false) |
| `'date'` | `'date?'` | Integer epoch day or Unix timestamp |

### Example: Locking Schema with Required & Optional Fields

```typescript
import { connectWire } from '@rahmantech/anchorwire';

async function main() {
  const client = await connectWire({
    host: '127.0.0.1',
    port: 7448,
    token: 'your_auth_token_here',
    model: 'orders',
  });

  try {
    // 1. Lock the schema upfront at application startup.
    //    Fields without '?' are REQUIRED on every save.
    //    Fields ending with '?' are OPTIONAL and can be omitted.
    await client.attachSchema({
      order_id: 'int',          // Required integer
      total_amount: 'float',    // Required float
      is_paid: 'bool',          // Required boolean (1 or 0)
      created_at: 'date',       // Required epoch timestamp
      discount_rate: 'float?',  // Optional float (can be omitted)
      promo_code_id: 'int?',    // Optional integer (can be omitted)
      shipped_at: 'date?',      // Optional date (can be omitted)
    });

    // 2. Save a record WITH optional fields included
    await client.save('order_1001', {
      order_id: 1001,
      total_amount: 250000.5,
      is_paid: 1,
      created_at: 1730280000,
      discount_rate: 0.15,
      promo_code_id: 99,
    });

    // 3. Save a record WITHOUT optional fields (succeeds because they are marked with '?')
    await client.save('order_1002', {
      order_id: 1002,
      total_amount: 120000.0,
      is_paid: 0,
      created_at: 1730283600,
    });

    // 4. Inspect the currently locked schema on the model
    const lockedSchemaJSON = await client.getSchema();
    console.log('Locked Schema:', JSON.parse(lockedSchemaJSON));
  } finally {
    client.close();
  }
}

main().catch(console.error);
```

---

## Date Mathematics & Calendar Handling

AnchorDB stores dates internally as `float32` **Epoch Days** (days since January 1, 1970 UTC). `@rahmantech/anchorwire` provides fast conversions and formatting:

```typescript
import { parseDate, formatDate, mustDate, formatTimestamp } from '@rahmantech/anchorwire';

// 1. Parse an ISO date string into Epoch Days
const epochDays = parseDate('2026-10-14'); // 20740

// 2. Format Epoch Days back into an ISO date string
console.log(formatDate(20740)); // '2026-10-14'

// 3. Retrieve and format dates directly from EntityResult
const record = await client.get('contract_alpha');
console.log('Start Date:', record.getDate('start_date')); // '2026-10-14'
console.log('Created At:', record.getTimestamp('created_at')); // '2026-10-14 10:00:00'
```

---

## In-Storage Compute Operators & Fluent Builders

Perform arithmetic and calendar manipulations directly inside AnchorDB without fetching raw fields:

```typescript
import {
  connectWire,
  divide,
  addConst,
  subtractDays,
  multiplyConst,
} from '@rahmantech/anchorwire';

const client = await connectWire('wire://localhost:7448?model=logistics');

// 1. Fluent GetBuilder with dynamic computation
const record = await client.getBuilder('vehicle_101')
  .select('distance', 'duration', 'speed')
  .compute('speed', divide('distance', 'duration'))
  .execute();

console.log('Speed:', record.get('speed'));

// 2. Fluent ListBuilder with date filtering and pagination
const result = await client.listBuilder()
  .select('delivery_id', 'eta')
  .where('delivery_date', '>=', '2026-10-14') // automatically parsed to Epoch Days!
  .whereBetween('priority', 1, 5)
  .compute('discounted_fee', multiplyConst('base_fee', 0.85))
  .page(1, 20)
  .execute();

for (const item of result.items) {
  console.log(`${item.name} -> ETA: ${item.getDate('eta')}`);
}

// 3. Fluent UpdateBuilder with in-place date mutations
const updatedCount = await client.updateBuilder()
  .in('delivery_101', 'delivery_102')
  .where('status', '=', 1)
  .set('eta', subtractDays('eta', 2))
  .execute();

console.log(`Updated ${updatedCount} records.`);
```

---

## Multi-Socket Connection Pooling (`connectWirePool`)

For high-throughput microservices handling hundreds of concurrent async requests:

```typescript
import { connectWirePool } from '@rahmantech/anchorwire';

// Automatically maintains a pool of persistent TCP connections
const pool = await connectWirePool({
  host: '127.0.0.1',
  port: 7448,
  token: 'secret',
  poolSize: 8, // 8 parallel TCP sockets
});

// Run parallel queries across the pool without head-of-line blocking
const promises = items.map((item) =>
  pool.withClient((c) => c.save(item.name, item.props))
);
await Promise.all(promises);

pool.close();
```

---

## Batch Ingestion & Adaptive Pacing

```typescript
// Save multiple records at once (returns array of saved names)
const savedNames = await client.saveBatch([
  { name: 'hub_1', props: { load: 80 } },
  { name: 'hub_2', props: { load: 45 } },
]);
console.log(`Saved ${savedNames.length} items:`, savedNames);
```

---

## Cryptographic Staged Commitment Rotation

When authenticating against AnchorDB cluster gateways using staged commitments:

```typescript
import { generateCommitmentPair, computeCommitment } from '@rahmantech/anchorwire';

// Generate validator preimage and commitment pair
const { validator, commitment } = generateCommitmentPair();

// Pair node with initial commitment
const sessionKey = await client.authPairing('node-01', commitment);

// Stage next commitment rotation
const next = generateCommitmentPair();
await client.authStagedReauth('node-01', validator, next.commitment);
```

---

## License

Apache-2.0
