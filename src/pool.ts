import { cpus } from 'node:os';
import { Client, parseWireUrl } from './client.js';
import {
  CausalResult,
  ComputeOp,
  EntityResult,
  GraphChainOptions,
  GraphQueryResult,
  GraphResponse,
  ListQueryOptions,
  ListResult,
  MathOperator,
  MathResponse,
  ModelSchema,
  PartitionCatalogItem,
  PartitionInspectRequest,
  PartitionInspectResponse,
  Point2D,
  RecordItem,
  Roles,
  UpdateQueryOptions,
  WireClientOptions,
} from './types.js';

export interface WirePoolOptions extends WireClientOptions {
  /**
   * Number of persistent TCP socket connections maintained in the pool.
   * Defaults to Math.max(4, Math.min(32, cpus().length * 2)).
   */
  poolSize?: number;
  /**
   * Maximum wait time in milliseconds when acquiring an idle connection from the pool before timing out.
   * Default: 30,000ms.
   */
  acquireTimeoutMs?: number;
}

/**
 * Thread-safe multi-socket connection pool for high-concurrency Node.js applications.
 * Mirrors Go's AnchorWire wireBackend connection pool.
 */
export class WirePool {
  private options: WirePoolOptions;
  private poolSize: number;
  private acquireTimeoutMs: number;
  private availableClients: Client[] = [];
  private allClients: Client[] = [];
  private waitQueue: Array<{
    resolve: (client: Client) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private closed = false;

  constructor(options: WirePoolOptions = {}) {
    this.options = { ...options };
    const cpuCount = cpus()?.length || 2;
    this.poolSize = options.poolSize ?? Math.max(4, Math.min(32, cpuCount * 2));
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 30000;
  }

  /**
   * Initializes and connects all socket connections in the pool.
   */
  public async init(): Promise<this> {
    if (this.closed) {
      throw new Error('Cannot initialize closed WirePool');
    }

    const connectPromises: Promise<Client>[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      const client = new Client(this.options);
      this.allClients.push(client);
      connectPromises.push(client.connect());
    }

    try {
      const connected = await Promise.all(connectPromises);
      this.availableClients.push(...connected);

      if (this.options.schema) {
        await this.attachSchema(this.options.schema);
      }

      return this;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /**
   * Acquires an idle Client connection from the pool.
   * Waits in FIFO queue if all connections are currently in-flight.
   */
  public async acquire(): Promise<Client> {
    if (this.closed) {
      throw new Error('WirePool is closed');
    }

    if (this.availableClients.length > 0) {
      return this.availableClients.pop()!;
    }

    return new Promise<Client>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
        reject(new Error(`WirePool acquire timeout after ${this.acquireTimeoutMs}ms`));
      }, this.acquireTimeoutMs);

      this.waitQueue.push({ resolve, reject, timer });
    });
  }

  /**
   * Returns a Client back to the pool.
   */
  public release(client: Client): void {
    if (this.closed) {
      client.close();
      return;
    }

    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      clearTimeout(next.timer);
      next.resolve(client);
      return;
    }

    this.availableClients.push(client);
  }

  /**
   * Executes an operation with an automatically acquired and released Client connection.
   */
  public async withClient<T>(fn: (client: Client) => Promise<T>, targetModel?: string): Promise<T> {
    const client = await this.acquire();
    try {
      const effectiveModel = targetModel ?? (this.options.model ?? 'default');
      if (effectiveModel !== client.getModelName()) {
        await client.useModel(effectiveModel);
      }
      return await fn(client);
    } finally {
      this.release(client);
    }
  }

  /**
   * Closes all connections in the pool and drains wait queues.
   */
  public close(): void {
    this.closed = true;
    while (this.waitQueue.length > 0) {
      const w = this.waitQueue.shift()!;
      clearTimeout(w.timer);
      w.reject(new Error('WirePool closed'));
    }
    for (const c of this.allClients) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
    this.availableClients = [];
    this.allClients = [];
  }

  // --- Ergonomic Proxy Methods ---

  public async save(
    name: string,
    props: Record<string, number>,
    options: { operation?: number; coord?: Point2D; roles?: Roles } = {},
    model?: string,
  ): Promise<string> {
    return this.withClient((c) => c.save(name, props, options), model);
  }

  public async saveBatch(items: RecordItem[], model?: string): Promise<string[]> {
    return this.withClient((c) => c.saveBatch(items), model);
  }

  public async get(
    name: string,
    select: string[] = [],
    computations: Record<string, ComputeOp> = {},
    model?: string,
  ): Promise<EntityResult> {
    return this.withClient((c) => c.get(name, select, computations), model);
  }

  public async list(options: ListQueryOptions = {}, model?: string): Promise<ListResult> {
    return this.withClient((c) => c.list(options), model);
  }

  public async update(options: UpdateQueryOptions, model?: string): Promise<number> {
    return this.withClient((c) => c.update(options), model);
  }

  public async link(source: string, relation: string, target: string, weight = 1.0, model?: string): Promise<void> {
    return this.withClient((c) => c.link(source, relation, target, weight), model);
  }

  public async unlink(source: string, relation: string, target: string, model?: string): Promise<void> {
    return this.withClient((c) => c.unlink(source, relation, target), model);
  }

  public async causal(seed: string, relation: string, limitK = 10, model?: string): Promise<CausalResult[]> {
    return this.withClient((c) => c.causal(seed, relation, limitK), model);
  }

  public async causalChain(seeds: string[], relation: string, limitK = 10, model?: string): Promise<CausalResult[]> {
    return this.withClient((c) => c.causalChain(seeds, relation, limitK), model);
  }

  public async setRelation(relation: string, direction: Point2D, model?: string): Promise<void> {
    return this.withClient((c) => c.setRelation(relation, direction), model);
  }

  public async graph(
    inputs: string[],
    relation: string,
    limitK = 10,
    orderMode = 0,
    beamWidth = 0.5,
    model?: string,
  ): Promise<GraphResponse> {
    return this.withClient((c) => c.graph(inputs, relation, limitK, orderMode, beamWidth), model);
  }

  public async graphChain(options: GraphChainOptions, model?: string): Promise<GraphQueryResult[]> {
    return this.withClient((c) => c.graphChain(options), model);
  }

  public async attachSchema(schema: ModelSchema | string, model?: string): Promise<void> {
    return this.withClient((c) => c.attachSchema(schema), model);
  }

  public async getSchema(model?: string): Promise<string> {
    return this.withClient((c) => c.getSchema(), model);
  }

  public async math(
    op: MathOperator,
    words: string[],
    limitK = 10,
    model?: string,
  ): Promise<MathResponse> {
    return this.withClient((c) => c.math(op, words, limitK), model);
  }

  public async sync(model?: string): Promise<void> {
    return this.withClient((c) => c.sync(), model);
  }

  public async resetModel(confirm = false, model?: string): Promise<void> {
    return this.withClient((c) => c.resetModel(confirm), model);
  }

  public async partitionCatalog(targetModel?: string): Promise<PartitionCatalogItem[]> {
    return this.withClient((c) => c.partitionCatalog(targetModel), targetModel);
  }

  public async partitionInspect(req: PartitionInspectRequest): Promise<PartitionInspectResponse> {
    return this.withClient((c) => c.partitionInspect(req));
  }

  public isRemote(): boolean {
    return true;
  }

  public isLocal(): boolean {
    return false;
  }

  public async appendNode(word: string, coord: Point2D, roles: Roles, model?: string): Promise<string> {
    return this.withClient((c) => c.appendNode(word, coord, roles), model);
  }

  public async saveAutoID(props: Record<string, number>, model?: string): Promise<string> {
    return this.withClient((c) => c.saveAutoID(props), model);
  }

  public async saveWithID(name: string, props: Record<string, number>, model?: string): Promise<string> {
    return this.withClient((c) => c.saveWithID(name, props), model);
  }

  public async attach(schema: ModelSchema | string, model?: string): Promise<void> {
    return this.attachSchema(schema, model);
  }

  public async listPartitions(model?: string): Promise<PartitionCatalogItem[]> {
    return this.partitionCatalog(model);
  }

  public async inspectPartition(
    partitionFile: string,
    recordName?: string,
    limit?: number,
    model?: string,
  ): Promise<PartitionInspectResponse> {
    return this.withClient((c) => c.inspectPartition(partitionFile, recordName, limit), model);
  }

  public async inspectPartitionRecord(
    partitionFile: string,
    recordName: string,
    model?: string,
  ): Promise<EntityResult | null> {
    return this.withClient((c) => c.inspectPartitionRecord(partitionFile, recordName), model);
  }
}

/**
 * Creates and initializes a thread-safe multi-socket AnchorWire connection pool.
 */
export async function connectWirePool(
  urlOrOptions: string | WirePoolOptions = {},
  poolSize?: number,
): Promise<WirePool> {
  const baseOpts: WirePoolOptions =
    typeof urlOrOptions === 'string' ? parseWireUrl(urlOrOptions) : { ...urlOrOptions };

  if (poolSize !== undefined) {
    baseOpts.poolSize = poolSize;
  }

  const pool = new WirePool(baseOpts);
  await pool.init();
  return pool;
}
