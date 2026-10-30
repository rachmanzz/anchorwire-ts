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
 * Entity record payload for saving or batch ingestion.
 */
export interface RecordItem {
  name: string;
  props: Record<string, number>;
  operation?: number;
  coord?: Point2D;
  roles?: Roles;
}

/**
 * Retrieved entity record from AnchorDB.
 */
export interface EntityResult {
  name: string;
  operation: number;
  props: Record<string, number>;
  isColdTier?: boolean;
}

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
 * Predicate filter condition for List and Update queries.
 */
export interface FilterCondition {
  field: string;
  operator: string;
  value: number;
  valueHigh?: number;
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
 * Connection options for the AnchorWire client.
 */
export interface WireClientOptions {
  host?: string;
  port?: number;
  token?: string;
  model?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}
