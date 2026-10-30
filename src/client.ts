import {
  OpCode,
  Flags,
  OpStatus,
  OrderByMode,
  OrderByModeType,
  AuthType,
  StructuredRespMagic,
  SubCodeRotationStaged,
  MemoryStatus,
} from './constants.js';
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
  encodeStructuredAuth,
  decodeAuthResponse,
  decodeRotationStagedResponse,
  encodeMemoryNegotiationRequest,
  decodeMemoryNegotiationResponse,
  decodeOKPayload,
  decodeErrorPayload,
} from './protocol.js';
import {
  RecordItem,
  ModelSchema,
  EntityResult,
  ListQueryOptions,
  ListResult,
  UpdateQueryOptions,
  CausalResult,
  GraphQueryResult,
  GraphResponse,
  GraphChainOptions,
  MathOperator,
  MathResponse,
  PartitionCatalogItem,
  PartitionInspectRequest,
  PartitionInspectResponse,
  Point2D,
  Roles,
  ComputeOp,
  WireClientOptions,
  AuthRequest,
  MemoryNegotiationResponse,
} from './types.js';
import { GetBuilder, ListBuilder, UpdateBuilder, GraphBuilder, MathEngine } from './builders.js';

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
   * Reports true if the client communicates over the network with an AnchorDB engine.
   */
  public isRemote(): boolean {
    return true;
  }

  /**
   * Reports true if the client wraps an embedded local AnchorDB file.
   */
  public isLocal(): boolean {
    return false;
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
   * Performs structured handshake authentication with the server.
   */
  public async authStructured(req: AuthRequest): Promise<string> {
    const payload = encodeStructuredAuth(req);
    const resp = await this.conn.request(OpCode.Auth, payload);
    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`AuthStructured failed (${err.code}): ${err.message}`);
    }
    if (resp.payload.length > 0 && resp.payload[0] === StructuredRespMagic) {
      if (resp.payload.length > 1 && resp.payload[1] === SubCodeRotationStaged) {
        const { message } = decodeRotationStagedResponse(resp.payload);
        return message;
      }
      return decodeAuthResponse(resp.payload);
    }
    return '';
  }

  /**
   * Performs node pairing during an open pairing window.
   */
  public async authPairing(nodeID: string, commitment?: Uint8Array | Buffer): Promise<string> {
    return this.authStructured({
      type: AuthType.Pairing,
      nodeID,
      initialCommitment: commitment,
      hasCommitment: !!commitment,
    });
  }

  /**
   * Performs ephemeral One-Time Key (OTK) join handshake.
   */
  public async authOTK(nodeID: string, otk: string, commitment?: Uint8Array | Buffer): Promise<string> {
    return this.authStructured({
      type: AuthType.OTK,
      nodeID,
      credential: otk,
      initialCommitment: commitment,
      hasCommitment: !!commitment,
    });
  }

  /**
   * Authenticates using an established HMAC session ticket.
   */
  public async authSession(nodeID: string, sessionKey: string): Promise<void> {
    await this.authStructured({
      type: AuthType.Session,
      nodeID,
      credential: sessionKey,
    });
  }

  /**
   * Performs Staged Preimage Commitment Rotation re-handshake.
   */
  public async authStagedReauth(
    nodeID: string,
    validator: Uint8Array | Buffer,
    nextCommitment: Uint8Array | Buffer,
  ): Promise<string> {
    return this.authStructured({
      type: AuthType.StagedReauth,
      nodeID,
      validator,
      nextCommitment,
    });
  }

  /**
   * Negotiates memory budget and ingestion pacing parameters with AnchorWire.
   */
  public async negotiateMemory(
    targetRecords: number,
    estimatedRecordSizeBytes = 512,
    preferredBatchSize = 1000,
  ): Promise<MemoryNegotiationResponse> {
    const payload = encodeMemoryNegotiationRequest({
      targetRecords,
      estimatedRecordSizeBytes,
      clientBatchSize: preferredBatchSize,
    });
    const resp = await this.conn.request(OpCode.NegotiateMemory, payload);
    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`NegotiateMemory failed (${err.code}): ${err.message}`);
    }
    const nego = decodeMemoryNegotiationResponse(resp.payload);
    this.conn.setNegotiation(nego);
    return nego;
  }

  /**
   * Enables or disables adaptive batch pacing.
   */
  public enableAdaptivePacing(enabled: boolean): void {
    this.conn.enableAdaptivePacing(enabled);
  }

  /**
   * Returns the currently active memory negotiation parameters.
   */
  public getNegotiation(): MemoryNegotiationResponse | null {
    return this.conn.getNegotiation();
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
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const resp = await this.conn.request(OpCode.Save, payload, Flags.None, this.currentModel);
        if (resp.opCode === OpCode.ResponseError) {
          const err = decodeErrorPayload(resp.payload);
          const errMsg = `Save failed (${err.code}): ${err.message}`;
          if (err.code === 507 || err.message.toLowerCase().includes('backpressure')) {
            lastError = new Error(errMsg);
            await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
            continue;
          }
          throw new Error(errMsg);
        }
        return decodeOKPayload(resp.payload);
      } catch (e) {
        const msg = String(e);
        if (msg.includes('507') || msg.toLowerCase().includes('backpressure')) {
          lastError = e instanceof Error ? e : new Error(msg);
          await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastError ?? new Error('Save failed after retries');
  }

  /**
   * Registers a concept node with 2D spatial coordinate and 4D semantic role vector.
   */
  public async appendNode(word: string, coord: Point2D, roles: Roles): Promise<string> {
    return this.save(word, {}, { coord, roles });
  }

  /**
   * Stores an entity with an automatically generated identifier.
   */
  public async saveAutoID(props: Record<string, number>): Promise<string> {
    return this.save('', props);
  }

  /**
   * Stores an entity with raw numeric properties, returning the effective name identifier.
   */
  public async saveWithID(name: string, props: Record<string, number>): Promise<string> {
    return this.save(name, props);
  }

  /**
   * Ingests multiple entity records in a single transactional batch, automatically pacing if enabled.
   * Returns the array of saved record names (matching Go SaveBatch).
   */
  public async saveBatch(items: RecordItem[]): Promise<string[]> {
    if (items.length === 0) return [];

    const pacing = this.conn.isPacingEnabled();
    const nego = this.conn.getNegotiation();

    if (pacing && nego && nego.status === MemoryStatus.Hold) {
      const batchSize = Math.max(nego.allocatedBatchSize, 100);
      if (items.length > batchSize) {
        const allNames: string[] = [];
        for (let i = 0; i < items.length; i += batchSize) {
          const chunk = items.slice(i, i + batchSize);
          const chunkNames = await this.sendSaveBatchChunk(chunk);
          allNames.push(...chunkNames);
          if (nego.releaseIntervalMs > 0 && i + batchSize < items.length) {
            await new Promise((r) => setTimeout(r, nego.releaseIntervalMs));
          }
        }
        return allNames;
      }
    }

    return this.sendSaveBatchChunk(items);
  }

  private async sendSaveBatchChunk(items: RecordItem[]): Promise<string[]> {
    const payload = encodeSaveBatchPayload(items);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const resp = await this.conn.request(OpCode.SaveBatch, payload, Flags.None, this.currentModel);
        if (resp.opCode === OpCode.ResponseError) {
          const err = decodeErrorPayload(resp.payload);
          const errMsg = `SaveBatch failed (${err.code}): ${err.message}`;
          if (err.code === 507 || err.message.toLowerCase().includes('backpressure')) {
            lastError = new Error(errMsg);
            await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
            continue;
          }
          throw new Error(errMsg);
        }
        decodeOKPayload(resp.payload);
        return items.map((r) => r.name);
      } catch (e) {
        const msg = String(e);
        if (msg.includes('507') || msg.toLowerCase().includes('backpressure')) {
          lastError = e instanceof Error ? e : new Error(msg);
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastError ?? new Error('SaveBatch failed after retries');
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
   * Executes causal chain query from multiple seed nodes along a single relation or sequence of relations.
   */
  public async causalChain(
    seeds: string[],
    relations: string | string[],
    limitK = 10,
  ): Promise<CausalResult[]> {
    if (Array.isArray(relations)) {
      if (relations.length === 0) return [];
      let currentSeeds = [...seeds];
      let currentResults: CausalResult[] = [];
      for (const rel of relations) {
        currentResults = await this.causalChain(currentSeeds, rel, limitK);
        if (currentResults.length === 0) break;
        currentSeeds = currentResults.map((r) => r.word);
      }
      return currentResults;
    }

    const payload = encodeCausalPayload(seeds, relations, limitK);
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
    orderMode: OrderByModeType | number = OrderByMode.Composite,
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
   * Registers and locks a schema contract on the active model.
   * Accepts either a ModelSchema object (e.g. `{ amount: 'float', discount: 'float?' }`) or a raw JSON string.
   */
  public async attachSchema(schema: ModelSchema | string): Promise<void> {
    const schemaJSON = typeof schema === 'string' ? schema : JSON.stringify(schema);
    const payload = encodeAttachSchemaPayload(schemaJSON);
    const resp = await this.conn.request(OpCode.AttachSchema, payload, Flags.None, this.currentModel);

    if (resp.opCode === OpCode.ResponseError) {
      const err = decodeErrorPayload(resp.payload);
      throw new Error(`AttachSchema failed (${err.code}): ${err.message}`);
    }
  }

  /**
   * Locks the specified schema contract into the currently active model (alias matching Go driver.Attach).
   */
  public async attach(schema: ModelSchema | string): Promise<void> {
    return this.attachSchema(schema);
  }

  /**
   * Returns a scoped client view targeting the specified model and attaches the schema immediately (matching Go driver.AttachModel).
   */
  public async attachModel(modelName: string, schema: ModelSchema | string): Promise<Client> {
    const cl = this.model(modelName);
    await cl.attach(schema);
    return cl;
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
    op: MathOperator,
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
    const payload = encodePartitionCatalogRequest(model ?? '');
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

  /**
   * Queries the engine to retrieve metadata on archived partition files (alias matching Go driver.ListPartitions).
   */
  public async listPartitions(model?: string): Promise<PartitionCatalogItem[]> {
    return this.partitionCatalog(model);
  }

  /**
   * Inspects an archived partition file over AnchorWire (alias matching Go driver.InspectPartition).
   */
  public async inspectPartition(
    partitionFile: string,
    recordName?: string,
    limit?: number,
  ): Promise<PartitionInspectResponse> {
    return this.partitionInspect({
      partition_file: partitionFile,
      record_name: recordName,
      limit,
    });
  }

  /**
   * Retrieves a single record from an archived partition file through the engine (matching Go driver.InspectPartitionRecord).
   */
  public async inspectPartitionRecord(
    partitionFile: string,
    recordName: string,
  ): Promise<EntityResult | null> {
    const res = await this.partitionInspect({
      partition_file: partitionFile,
      record_name: recordName,
      limit: 1,
    });
    if (res.props && Object.keys(res.props).length > 0) {
      return new EntityResult(recordName, OpStatus.Active, res.props);
    }
    if (res.records && res.records.length > 0) {
      const found = res.records.find((r) => r.name === recordName) ?? res.records[0];
      return new EntityResult(found.name, OpStatus.Active, found.props);
    }
    return null;
  }

  // --- Fluent Query Builders ---

  /**
   * Returns a fluent query builder to retrieve an entity and optionally project/compute derived fields.
   */
  public getBuilder(name: string): GetBuilder {
    return new GetBuilder(this, name);
  }

  /**
   * Returns a fluent query builder to list, filter, compute, and paginate multiple entities.
   */
  public listBuilder(): ListBuilder {
    return new ListBuilder(this);
  }

  /**
   * Returns a fluent query builder to perform atomic batch updates and arithmetic mutations.
   */
  public updateBuilder(): UpdateBuilder {
    return new UpdateBuilder(this);
  }

  /**
   * Returns a fluent query builder for spatial ray casting, role alignment, and multi-hop reasoning.
   */
  public graphBuilder(): GraphBuilder {
    return new GraphBuilder(this);
  }

  /**
   * Returns a direct mathematical and geometric operations engine on the graph.
   */
  public mathEngine(): MathEngine {
    return new MathEngine(this);
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

  if (opts.schema) {
    await client.attachSchema(opts.schema);
  }

  return client;
}
