import { OpCode, Flags, OpStatus, OrderByMode } from './constants.js';
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
  GraphQueryResult,
  GraphResponse,
  GraphChainOptions,
  MathResponse,
  PartitionCatalogItem,
  PartitionInspectRequest,
  PartitionInspectResponse,
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
   * Returns the model name scoped to this client instance.
   */
  public getModelName(): string {
    return this.currentModel;
  }

  /**
   * Creates a scoped client view bound to the given model name.
   * Each operation on the returned client ensures the target model is selected before execution.
   */
  public model(name: string): Client {
    const clone = Object.create(Client.prototype) as Client;
    clone.conn = this.conn;
    clone.currentModel = name;
    return clone;
  }

  /**
   * Explicitly switches the active model on this client and awaits confirmation from the server.
   */
  public async useModel(name: string): Promise<this> {
    this.currentModel = name;
    await this.conn.setModel(name);
    return this;
  }

  /**
   * Sends a Ping frame to verify connection liveness.
   */
  public async ping(): Promise<void> {
    const resp = await this.conn.request(OpCode.Ping);
    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Ping failed (${err.code}): ${err.message}`);
    }
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
    } = {},
  ): Promise<string> {
    const item: RecordItem = {
      name,
      props,
      operation: options.operation ?? OpStatus.Active,
      coord: options.coord,
      roles: options.roles,
    };

    const payload = encodeSavePayload(item);
    const resp = await this.conn.request(OpCode.Save, payload, Flags.None, this.currentModel);

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
    const resp = await this.conn.request(OpCode.SaveBatch, payload, Flags.None, this.currentModel);

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
    computations: Record<string, ComputeOp> = {},
  ): Promise<EntityResult> {
    const payload = encodeGetRequest(name, select, computations);
    const resp = await this.conn.request(OpCode.Get, payload, Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Get failed (${err.code}): ${err.message}`);
    }

    return decodeGetResultPayload(resp.payload, name, resp.flags);
  }

  /**
   * Queries entities with filtering, paging, and in-storage calculations.
   */
  public async list(options: ListQueryOptions = {}): Promise<ListResult> {
    const payload = encodeListRequest(options);
    const resp = await this.conn.request(OpCode.List, payload, Flags.None, this.currentModel);

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
    const resp = await this.conn.request(OpCode.Update, payload, Flags.None, this.currentModel);

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
    const resp = await this.conn.request(OpCode.Edge, payload, Flags.None, this.currentModel);

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
    const resp = await this.conn.request(OpCode.Edge, payload, Flags.None, this.currentModel);

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
    const resp = await this.conn.request(OpCode.Edge, payload, Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Unlink failed (${err.code}): ${err.message}`);
    }
  }

  /**
   * Executes a multi-hop directed causal traversal from a seed node.
   */
  public async causal(seed: string, relation: string, limitK = 10): Promise<CausalResult[]> {
    return this.causalChain([seed], relation, limitK);
  }

  /**
   * Executes causal chain query from multiple seed nodes along a relation.
   */
  public async causalChain(seeds: string[], relation: string, limitK = 10): Promise<CausalResult[]> {
    const payload = encodeCausalPayload(seeds, relation, limitK);
    const resp = await this.conn.request(OpCode.Causal, payload, Flags.None, this.currentModel);

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
    orderMode: number = OrderByMode.Score,
    beamWidth = 0.5,
  ): Promise<GraphResponse> {
    const payload = encodeGraphRequest(inputs, relation, limitK, orderMode, beamWidth);
    const resp = await this.conn.request(OpCode.Graph, payload, Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`Graph failed (${err.code}): ${err.message}`);
    }

    return decodeGraphResponse(resp.payload);
  }

  /**
   * Executes a multi-hop spatial graph chain traversal across a sequence of relations.
   */
  public async graphChain(options: GraphChainOptions): Promise<GraphQueryResult[]> {
    const payload = encodeGraphChainRequest(options);
    const resp = await this.conn.request(OpCode.GraphChain, payload, Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`GraphChain failed (${err.code}): ${err.message}`);
    }

    return decodeGraphResponse(resp.payload).results;
  }

  /**
   * Registers a fixed schema definition JSON string on the active model.
   */
  public async attachSchema(schemaJSON: string): Promise<void> {
    const payload = encodeAttachSchemaPayload(schemaJSON);
    const resp = await this.conn.request(OpCode.AttachSchema, payload, Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`AttachSchema failed (${err.code}): ${err.message}`);
    }
  }

  /**
   * Retrieves the attached schema definition JSON string for the active model.
   */
  public async getSchema(): Promise<string> {
    const resp = await this.conn.request(OpCode.GetSchema, Buffer.alloc(0), Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`GetSchema failed (${err.code}): ${err.message}`);
    }

    return decodeGetSchemaPayload(resp.payload);
  }

  /**
   * Executes in-storage geometric and statistical calculations.
   */
  public async math(
    op: 'distance' | 'centroid' | 'cosine_similarity' | 'nearest',
    words: string[],
    limitK = 10,
  ): Promise<MathResponse> {
    const payload = encodeMathRequest(op, words, limitK);
    const resp = await this.conn.request(OpCode.Math, payload, Flags.None, this.currentModel);

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
    const resp = await this.conn.request(OpCode.Sync, Buffer.alloc(0), Flags.None, this.currentModel);

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
    const resp = await this.conn.request(OpCode.ResetModel, payload, Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`ResetModel failed (${err.code}): ${err.message}`);
    }
  }

  /**
   * Retrieves registered cold storage partition archives for a model (or all models if omitted).
   */
  public async partitionCatalog(model?: string): Promise<PartitionCatalogItem[]> {
    const payload = encodePartitionCatalogRequest(model ?? this.currentModel);
    const resp = await this.conn.request(OpCode.PartitionCatalog, payload, Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`PartitionCatalog failed (${err.code}): ${err.message}`);
    }

    return decodePartitionCatalogResponse(resp.payload);
  }

  /**
   * Inspects an archived cold partition file over AnchorWire.
   */
  public async partitionInspect(req: PartitionInspectRequest): Promise<PartitionInspectResponse> {
    const payload = encodePartitionInspectRequest(req);
    const resp = await this.conn.request(OpCode.PartitionInspect, payload, Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`PartitionInspect failed (${err.code}): ${err.message}`);
    }

    return decodePartitionInspectResponse(resp.payload);
  }
}

/**
 * Parses a wire:// or tcp:// connection URL into WireClientOptions.
 */
export function parseWireUrl(urlStr: string): WireClientOptions {
  const normalized = urlStr.replace(/^(wire|tcp):\/\//i, 'http://');
  const parsed = new URL(normalized.startsWith('http://') ? normalized : `http://${normalized}`);
  const opts: WireClientOptions = {};

  if (parsed.hostname) {
    // Strip brackets around IPv6 addresses for net.Socket.connect
    opts.host = parsed.hostname.replace(/^\[|\]$/g, '');
  }
  if (parsed.port) {
    const portNum = Number.parseInt(parsed.port, 10);
    if (Number.isNaN(portNum) || portNum <= 0 || portNum > 65535) {
      throw new RangeError(`Invalid port in AnchorWire URL: ${parsed.port}`);
    }
    opts.port = portNum;
  }

  const token = parsed.searchParams.get('token');
  if (token) {
    opts.token = token;
  }
  const model = parsed.searchParams.get('model');
  if (model) {
    opts.model = model;
  }

  return opts;
}

/**
 * Creates and connects a new AnchorWire client.
 */
export async function connectWire(urlOrOptions: string | WireClientOptions = {}): Promise<Client> {
  const opts: WireClientOptions =
    typeof urlOrOptions === 'string' ? parseWireUrl(urlOrOptions) : urlOrOptions;

  const client = new Client(opts);
  await client.connect();
  return client;
}
