import { OpCode, OpStatus, OrderByMode } from './constants.js';
import { WireConnection } from './connection.js';
import {
  encodeSavePayload,
  encodeSaveBatchPayload,
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
  encodeResetModelPayload,
  decodeOKPayload,
  decodeErrorPayload,
} from './protocol.js';
import {
  RecordItem,
  EntityResult,
  ListQueryOptions,
  ListResult,
  UpdateQueryOptions,
  CausalResult,
  GraphResponse,
  MathResponse,
  Point2D,
  Roles,
  ComputeOp,
  WireClientOptions,
} from './types.js';

export class Client {
  private conn: WireConnection;
  private currentModel: string;

  constructor(options: WireClientOptions = {}) {
    this.conn = new WireConnection(options);
    this.currentModel = options.model ?? 'default';
  }

  /**
   * Connects to the AnchorDB AnchorWire server.
   * Authentication and initial model selection occur automatically.
   */
  public async connect(): Promise<this> {
    await this.conn.connect();
    return this;
  }

  /**
   * Closes the underlying TCP socket connection.
   */
  public close(): void {
    this.conn.close();
  }

  /**
   * Switches or creates a scoped model view for operations.
   */
  public model(name: string): Client {
    const clone = new Client();
    clone.conn = this.conn;
    clone.currentModel = name;
    // Set model asynchronously on connection
    void this.conn.setModel(name);
    return clone;
  }

  /**
   * Saves or inserts an entity record into AnchorDB.
   */
  public async save(
    name: string,
    props: Record<string, number>,
    options: {
      operation?: number;
      coord?: Point2D;
      roles?: Roles;
    } = {}
  ): Promise<string> {
    const item: RecordItem = {
      name,
      props,
      operation: options.operation ?? OpStatus.Active,
      coord: options.coord,
      roles: options.roles,
    };

    const payload = encodeSavePayload(item);
    const resp = await this.conn.request(OpCode.Save, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Save failed (${err.code}): ${err.message}`);
    }

    return decodeOKPayload(resp.payload);
  }

  /**
   * Ingests multiple entity records in a single transactional batch.
   */
  public async saveBatch(items: RecordItem[]): Promise<number> {
    const payload = encodeSaveBatchPayload(items);
    const resp = await this.conn.request(OpCode.SaveBatch, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`SaveBatch failed (${err.code}): ${err.message}`);
    }

    const countStr = decodeOKPayload(resp.payload);
    return parseInt(countStr, 10) || items.length;
  }

  /**
   * Retrieves an entity record by name with optional field projections and on-the-fly math computations.
   */
  public async get(
    name: string,
    select: string[] = [],
    computations: Record<string, ComputeOp> = {}
  ): Promise<EntityResult> {
    const payload = encodeGetRequest(name, select, computations);
    const resp = await this.conn.request(OpCode.Get, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Get failed (${err.code}): ${err.message}`);
    }

    return decodeGetResultPayload(resp.payload, name);
  }

  /**
   * Queries entities with filtering, paging, and in-storage calculations.
   */
  public async list(options: ListQueryOptions = {}): Promise<ListResult> {
    const payload = encodeListRequest(options);
    const resp = await this.conn.request(OpCode.List, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`List failed (${err.code}): ${err.message}`);
    }

    return decodeListResponse(resp.payload);
  }

  /**
   * Performs in-place batch mutations with server-side computations.
   */
  public async update(options: UpdateQueryOptions): Promise<number> {
    const payload = encodeUpdateRequest(options);
    const resp = await this.conn.request(OpCode.Update, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Update failed (${err.code}): ${err.message}`);
    }

    return decodeUpdateResponse(resp.payload);
  }

  /**
   * Creates a directed weighted causal relationship edge between two nodes.
   */
  public async link(source: string, relation: string, target: string, weight = 1.0): Promise<void> {
    const payload = encodeEdgePayload('add', source, relation, target, weight);
    const resp = await this.conn.request(OpCode.Edge, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Link failed (${err.code}): ${err.message}`);
    }
  }

  /**
   * Sets or updates a spatial direction vector for a relation type.
   */
  public async setRelation(relation: string, direction: Point2D): Promise<void> {
    const payload = encodeEdgePayload('set_relation', '', relation, '', 0, direction);
    const resp = await this.conn.request(OpCode.Edge, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`SetRelation failed (${err.code}): ${err.message}`);
    }
  }

  /**
   * Removes a directed causal relationship edge between two nodes.
   */
  public async unlink(source: string, relation: string, target: string): Promise<void> {
    const payload = encodeEdgePayload('remove', source, relation, target);
    const resp = await this.conn.request(OpCode.Edge, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Unlink failed (${err.code}): ${err.message}`);
    }
  }

  /**
   * Executes a multi-hop directed causal traversal from seed nodes.
   */
  public async causal(seed: string, relation: string, limitK = 10): Promise<CausalResult[]> {
    return this.causalChain([seed], relation, limitK);
  }

  /**
   * Executes causal chain query from multiple seed nodes along a relation.
   */
  public async causalChain(seeds: string[], relation: string, limitK = 10): Promise<CausalResult[]> {
    const payload = encodeCausalPayload(seeds, relation, limitK);
    const resp = await this.conn.request(OpCode.Causal, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Causal failed (${err.code}): ${err.message}`);
    }

    return decodeCausalResultPayload(resp.payload);
  }

  /**
   * Performs 2D spatial beam ray-casting and role alignment retrieval.
   */
  public async graph(
    inputs: string[],
    relation: string,
    limitK = 10,
    orderMode = OrderByMode.Score,
    beamWidth = 0.5
  ): Promise<GraphResponse> {
    const payload = encodeGraphRequest(inputs, relation, limitK, orderMode, beamWidth);
    const resp = await this.conn.request(OpCode.Graph, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Graph failed (${err.code}): ${err.message}`);
    }

    return decodeGraphResponse(resp.payload);
  }

  /**
   * Executes in-storage geometric and statistical calculations.
   */
  public async math(
    op: 'distance' | 'centroid' | 'cosine_similarity' | 'nearest',
    words: string[],
    limitK = 10
  ): Promise<MathResponse> {
    const payload = encodeMathRequest(op, words, limitK);
    const resp = await this.conn.request(OpCode.Math, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Math failed (${err.code}): ${err.message}`);
    }

    return decodeMathResponse(resp.payload);
  }

  /**
   * Flushes and fsyncs in-memory Write-Ahead Log state to persistent disk storage.
   */
  public async sync(): Promise<void> {
    const resp = await this.conn.request(OpCode.Sync);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Sync failed (${err.code}): ${err.message}`);
    }
  }

  /**
   * Resets and purges a model's storage. Requires confirm=true.
   */
  public async resetModel(confirm = false): Promise<void> {
    const payload = encodeResetModelPayload(confirm);
    const resp = await this.conn.request(OpCode.ResetModel, payload);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`ResetModel failed (${err.code}): ${err.message}`);
    }
  }
}

/**
 * Creates and connects a new AnchorWire client.
 */
export async function connectWire(urlOrOptions: string | WireClientOptions = {}): Promise<Client> {
  let opts: WireClientOptions = {};

  if (typeof urlOrOptions === 'string') {
    // Parse wire://host:port or tcp://host:port
    const cleaned = urlOrOptions.replace(/^(wire|tcp):\/\//, '');
    const [hostPort, query] = cleaned.split('?');
    const parts = hostPort.split(':');
    opts.host = parts[0] || '127.0.0.1';
    if (parts[1]) {
      opts.port = parseInt(parts[1], 10);
    }
    if (query) {
      const search = new URLSearchParams(query);
      if (search.get('token')) opts.token = search.get('token')!;
      if (search.get('model')) opts.model = search.get('model')!;
    }
  } else {
    opts = urlOrOptions;
  }

  const client = new Client(opts);
  await client.connect();
  return client;
}
