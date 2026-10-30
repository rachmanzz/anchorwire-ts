# @rahmantech/anchorwire

Official high-performance TypeScript and Node.js client for **AnchorDB** using the native binary **AnchorWire** protocol (`wire://` over TCP port `7448`).

## Features

- **100% Pure TypeScript & Zero External Runtime Dependencies**: Built directly on `node:net` and native `Buffer` with custom IEEE 802.3 CRC32 framing.
- **Ultra Low Latency**: Direct binary serialization over persistent TCP socket connection (~0.1ms loopback latency).
- **Sub-Microsecond Operations**:
  - `save` / `saveBatch`: High-throughput entity and node persistence.
  - `get`: Entity retrieval with on-the-fly math computations (`divide`, `multiply`, `daysBetween`, etc.).
  - `list`: Paged queries with in-storage predicate pushdown.
  - `update`: In-place batch arithmetic mutations.
  - `link` / `unlink`: Causal graph edge creation and tombstoning.
  - `causal` / `causalChain`: Multi-hop cause-and-effect path scoring.
  - `graph`: 2D spatial beam ray-casting and semantic role retrieval.
  - `math`: In-storage Euclidean distance, centroid, and cosine similarity.

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

## Quick Start

```typescript
import { connectWire } from '@rahmantech/anchorwire';

async function main() {
  // Connect to AnchorWire server (default: 127.0.0.1:7448)
  const client = await connectWire({
    host: '127.0.0.1',
    port: 7448,
    token: 'your_auth_token_here',
    model: 'supply_chain',
  });

  try {
    // 1. Save an entity with numeric properties and spatial coordinates
    await client.save('warehouse_alpha', {
      inventory_units: 45000,
      daily_burn_rate: 1500,
      storage_cost: 12.5,
    }, {
      coord: { x: 106.8456, y: -6.2088 },
      roles: [1.0, 0.5, 0.0, 0.2],
    });

    // 2. Query entity with on-the-fly in-storage math calculation
    const record = await client.get('warehouse_alpha', ['inventory_units'], {
      days_to_stockout: {
        type: 'divide',
        fieldA: 'inventory_units',
        fieldB: 'daily_burn_rate',
      },
    });

    console.log(`Stockout Days: ${record.props.days_to_stockout}`); // 30.0 days

    // 3. Directed Causal Graph Operations
    await client.link('factory_strike', 'causes', 'supply_delay', 0.95);
    await client.link('supply_delay', 'causes', 'warehouse_stockout', 0.85);

    const chain = await client.causal('factory_strike', 'causes', 5);
    for (const res of chain) {
      console.log(`Causal Target: ${res.word}, Score: ${res.score}`);
    }

    // 4. In-Storage Spatial Math
    const distance = await client.math('distance', ['warehouse_alpha', 'hub_beta']);
    console.log(`Distance: ${distance.value} units`);

  } finally {
    client.close();
  }
}

main().catch(console.error);
```

---

## API Reference

### Connection

```typescript
// Connect with URI string
const client = await connectWire('wire://localhost:7448?token=secret&model=logistics');

// Or with options object
const client = await connectWire({
  host: '127.0.0.1',
  port: 7448,
  token: 'secret',
  model: 'logistics',
  connectTimeoutMs: 5000,
  requestTimeoutMs: 10000,
});
```

### Models

AnchorDB organizes data into isolated model files:

```typescript
const fraudModel = client.model('banking_fraud');
await fraudModel.save('tx_9012', { amount: 5000000, risk: 0.92 });
```

### In-Storage Arithmetic Mutations

Perform server-side calculations on filtered records:

```typescript
// Add days to renewal_date for active accounts
await client.update({
  filters: [
    { field: 'is_active', operator: '=', value: 1.0 },
  ],
  mutations: {
    renewal_date: {
      type: 'addDays',
      field: 'expiry_date',
      days: 30,
    },
  },
});
```

### Batch Ingestion

Ingest thousands of records efficiently:

```typescript
await client.saveBatch([
  { name: 'rec_1', props: { temp: 24.5, humidity: 60 } },
  { name: 'rec_2', props: { temp: 25.1, humidity: 58 } },
]);
```

---

## License

Apache-2.0
