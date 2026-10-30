import { OpCodeType } from './constants.js';

export interface Point2D {
  x: number;
  y: number;
}

export type Roles = [number, number, number, number];

export interface RecordItem {
  name: string;
  props: Record<string, number>;
  operation?: number;
  coord?: Point2D;
  roles?: Roles;
}

export interface EntityResult {
  name: string;
  operation: number;
  props: Record<string, number>;
  isColdTier?: boolean;
}

export type ComputeOp =
  | { type: 'divide'; fieldA: string; fieldB: string }
  | { type: 'multiply'; fieldA: string; fieldB: string }
  | { type: 'add'; fieldA: string; fieldB: string }
  | { type: 'subtract'; fieldA: string; fieldB: string }
  | { type: 'addDays'; field: string; days: number }
  | { type: 'subtractDays'; field: string; days: number }
  | { type: 'daysBetween'; fieldA: string; fieldB: string }
  | { type: 'assign'; value: string };

export interface FilterCondition {
  field: string;
  operator: string;
  value: number;
  valueHigh?: number;
}

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

export interface ListResult {
  totalCount: number;
  hasMore: boolean;
  items: EntityResult[];
}

export interface UpdateQueryOptions {
  filters?: FilterCondition[];
  targetEntities?: string[];
  mutations?: Record<string, ComputeOp>;
  limit?: number;
  offset?: number;
}

export interface CausalResult {
  word: string;
  score: number;
}

export interface GraphQueryResult {
  word: string;
  score: number;
  t: number;
  distSqPerp: number;
  coord: Point2D;
}

export interface GraphResponse {
  anchor: Point2D;
  results: GraphQueryResult[];
}

export interface MathResponse {
  value: number;
  coord: Point2D;
  roles: Roles;
  neighbors: GraphQueryResult[];
}

export interface Frame {
  magic: number;
  version: number;
  opCode: OpCodeType | number;
  flags: number;
  seq: number;
  payload: Buffer;
}

export interface WireClientOptions {
  host?: string;
  port?: number;
  token?: string;
  model?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}
