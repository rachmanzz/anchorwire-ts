import { OpCodeType } from './constants.js';

/**
 * 2D Cartesian coordinate in AnchorDB spatial space.
 */
export interface Point2D {
  x: number;
  y: number;
}

/**
 * 4-element role weight vector [R0, R1, R2, R3].
 */
export type Roles = [number, number, number, number];

/**
 * Supported scalar field type specifications in AnchorDB ModelSchema.
 * Append '?' to mark a field as optional (e.g. 'float?', 'int?', 'bool?', 'date?').
 */
export type SchemaFieldType =
  | 'int'
  | 'int?'
  | 'float'
  | 'float?'
  | 'bool'
  | 'bool?'
  | 'date'
  | 'date?';

/**
 * Mapping of field names to their AnchorDB type specification (e.g. { amount: 'float', discount: 'float?' }).
 */
export type ModelSchema = Record<string, SchemaFieldType | string>;

/**
 * Entity record payload for saving or batch ingestion.
 */
export interface RecordItem {
  name: string;
  props: Record<string, number>;
  operation?: number;
  coord?: Point2D;
  roles?: Roles;
}

import { EntityResult } from './entity.js';
export { EntityResult };

/**
 * In-storage calculation / mutation descriptor.
 */
export type ComputeOp =
  | { type: 'divide'; fieldA: string; fieldB: string }
  | { type: 'multiply'; fieldA: string; fieldB: string }
  | { type: 'add'; fieldA: string; fieldB: string }
  | { type: 'subtract'; fieldA: string; fieldB: string }
  | { type: 'addDays'; field: string; days: number }
  | { type: 'subtractDays'; field: string; days: number }
  | { type: 'daysBetween'; fieldA: string; fieldB: string }
  | { type: 'assign'; value: string };

/**
 * Expression descriptor for in-storage calculations (AnchorDB Go driver parity alias for ComputeOp).
 */
export type OperatorExpr = ComputeOp;

/**
 * Filter value supporting numeric float32 values or ISO date strings.
 */
export type FilterValue = number | string;

/**
 * Predicate filter condition for List and Update queries.
 */
export interface FilterCondition {
  field: string;
  operator: string;
  value: FilterValue;
  valueHigh?: FilterValue;
}

/**
 * Query parameters for paged List operations.
 */
export interface ListQueryOptions {
  limit?: number;
  offset?: number;
  includeAllOperations?: boolean;
  operationFilter?: number;
  allowedOperations?: number[];
  select?: string[];
  filters?: FilterCondition[];
  computations?: Record<string, ComputeOp>;
}

/**
 * Paginated List response from AnchorDB.
 */
export interface ListResult {
  totalCount: number;
  hasMore: boolean;
  items: EntityResult[];
}

/**
 * Query and mutation parameters for batch Update operations.
 */
export interface UpdateQueryOptions {
  filters?: FilterCondition[];
  targetEntities?: string[];
  mutations?: Record<string, ComputeOp>;
  limit?: number;
  offset?: number;
}

/**
 * Scored node returned from a causal graph traversal.
 */
export interface CausalResult {
  word: string;
  score: number;
}

/**
 * Spatial beam search candidate node.
 */
export interface GraphQueryResult {
  word: string;
  score: number;
  t: number;
  distSqPerp: number;
  coord: Point2D;
}

/**
 * Response from a spatial beam Graph traversal.
 */
export interface GraphResponse {
  anchor: Point2D;
  results: GraphQueryResult[];
}

/**
 * Parameters for multi-hop GraphChain traversal.
 */
export interface GraphChainOptions {
  inputs: string[];
  relationChain: string[];
  limitK?: number;
  beamWidth?: number;
}

/**
 * In-storage geometric and statistical operator names.
 */
export type MathOperator = 'distance' | 'centroid' | 'cosine_similarity' | 'nearest';

/**
 * Response from an in-storage geometric Math operation.
 */
export interface MathResponse {
  value: number;
  coord: Point2D;
  roles: Roles;
  neighbors: GraphQueryResult[];
}

/**
 * Partition catalog entry for archived cold storage partitions.
 */
export interface PartitionCatalogItem {
  id: string;
  model: string;
  partition_file: string;
  target_location: string;
  sink_type: string;
  record_count: number;
  cutoff_date: string;
  min_date: number;
  max_date: number;
  created_at: string;
  size_bytes: number;
}

/**
 * Request parameters for inspecting an archived cold partition.
 */
export interface PartitionInspectRequest {
  partition_file: string;
  record_name?: string;
  limit?: number;
}

/**
 * Record entry inside an inspected cold partition.
 */
export interface PartitionRecordItem {
  name: string;
  props: Record<string, number>;
}

/**
 * Response from inspecting an archived cold partition.
 */
export interface PartitionInspectResponse {
  partition_file: string;
  record_name?: string;
  props?: Record<string, number>;
  records?: PartitionRecordItem[];
}

/**
 * Low-level 16-byte framed AnchorWire packet.
 */
export interface Frame {
  magic: number;
  version: number;
  opCode: OpCodeType | number;
  flags: number;
  seq: number;
  payload: Buffer;
}

/**
 * Structured authentication request for node joining, pairing, or session validation.
 */
export interface AuthRequest {
  type: number;
  nodeID: string;
  credential?: string;
  validator?: Uint8Array | Buffer;
  nextCommitment?: Uint8Array | Buffer;
  initialCommitment?: Uint8Array | Buffer;
  hasCommitment?: boolean;
}

/**
 * Client workload estimation for OpCode.NegotiateMemory.
 */
export interface MemoryNegotiationRequest {
  targetRecords: number;
  estimatedRecordSizeBytes: number;
  clientBatchSize: number;
}

/**
 * Server pacing and admission response for OpCode.NegotiateMemory.
 */
export interface MemoryNegotiationResponse {
  status: number;
  hostUsedPct: number;
  headroomBytes: bigint;
  allocatedBatchSize: number;
  releaseIntervalMs: number;
}

/**
 * Connection options for the AnchorWire client.
 */
export interface WireClientOptions {
  host?: string;
  port?: number;
  token?: string;
  model?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  enableAdaptivePacing?: boolean;
  targetRecords?: number;
  schema?: ModelSchema | string;
  poolSize?: number;
}

/**
 * Metadata for registered cold partition archives (alias matching Go driver.PartitionMeta).
 */
export type PartitionMeta = PartitionCatalogItem;

/**
 * Inspection result from an archived partition (alias matching Go driver.PartitionInspectResult).
 */
export type PartitionInspectResult = PartitionInspectResponse;
