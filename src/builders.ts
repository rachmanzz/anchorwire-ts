import {
  ComputeOp,
  FilterCondition,
  GraphQueryResult,
  GraphResponse,
  ListResult,
  MathOperator,
  MathResponse,
  Point2D,
  Roles,
} from './types.js';
import { EntityResult } from './entity.js';
import { parseDate } from './date.js';
import { OrderByMode, OrderByModeType } from './constants.js';

/**
 * Interface representing the operations required by fluent query builders.
 */
export interface BuilderClientContext {
  get(name: string, select?: string[], computations?: Record<string, ComputeOp>): Promise<EntityResult>;
  list(options?: {
    limit?: number;
    offset?: number;
    includeAllOperations?: boolean;
    operationFilter?: number;
    allowedOperations?: number[];
    select?: string[];
    filters?: FilterCondition[];
    computations?: Record<string, ComputeOp>;
  }): Promise<ListResult>;
  update(options: {
    filters?: FilterCondition[];
    targetEntities?: string[];
    mutations?: Record<string, ComputeOp>;
    limit?: number;
    offset?: number;
  }): Promise<number>;
  graph(
    inputs: string[],
    relation: string,
    limitK?: number,
    orderMode?: OrderByModeType | number,
    beamWidth?: number,
  ): Promise<GraphResponse>;
  graphChain(options: { inputs: string[]; relationChain: string[]; limitK?: number; beamWidth?: number }): Promise<GraphQueryResult[]>;
  math(
    op: MathOperator,
    words: string[],
    limitK?: number,
  ): Promise<MathResponse>;
}

function normalizeFilterValue(val: number | string): number {
  if (typeof val === 'number') {
    return val;
  }
  const str = val.trim();
  // Check if it's an ISO date string
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return parseDate(str);
  }
  const parsed = Number.parseFloat(str);
  if (Number.isNaN(parsed)) {
    throw new Error(`cannot convert filter value "${val}" to float32`);
  }
  return parsed;
}

/**
 * Fluent builder for entity retrieval and read-time column projections/computations.
 */
export class GetBuilder {
  private client: BuilderClientContext;
  private targetName: string;
  private selectFields: string[] = [];
  private computations: Record<string, ComputeOp> = {};

  constructor(client: BuilderClientContext, name: string) {
    this.client = client;
    this.targetName = name;
  }

  /**
   * Restricts returned properties to specific attribute columns (projection).
   */
  public select(...fields: string[]): this {
    this.selectFields.push(...fields);
    return this;
  }

  /**
   * Adds an on-the-fly in-storage mathematical computation.
   */
  public compute(outputField: string, op: ComputeOp): this {
    this.computations[outputField] = op;
    return this;
  }

  /**
   * Executes the Get query on AnchorDB.
   */
  public async execute(): Promise<EntityResult> {
    return this.client.get(this.targetName, this.selectFields, this.computations);
  }
}

/**
 * Fluent builder for paged list queries, filtering, and aggregated calculations.
 */
export class ListBuilder {
  private client: BuilderClientContext;
  private selectFields: string[] = [];
  private filterList: FilterCondition[] = [];
  private computeMap: Record<string, ComputeOp> = {};
  private limitCount = 10;
  private offsetCount = 0;
  private includeAll = false;
  private opFilter?: number;
  private allowedOps?: number[];

  constructor(client: BuilderClientContext) {
    this.client = client;
  }

  /**
   * Restricts returned properties to specific attribute columns.
   */
  public select(...fields: string[]): this {
    this.selectFields.push(...fields);
    return this;
  }

  /**
   * Adds a filter predicate. Value can be a number or an ISO date string ("YYYY-MM-DD").
   */
  public where(field: string, operator: string, value: number | string): this {
    this.filterList.push({
      field,
      operator,
      value: normalizeFilterValue(value),
    });
    return this;
  }

  /**
   * Adds a range filter predicate (field BETWEEN low AND high).
   */
  public whereBetween(field: string, low: number | string, high: number | string): this {
    this.filterList.push({
      field,
      operator: 'BETWEEN',
      value: normalizeFilterValue(low),
      valueHigh: normalizeFilterValue(high),
    });
    return this;
  }

  /**
   * Adds an on-the-fly in-storage computation.
   */
  public compute(outputField: string, op: ComputeOp): this {
    this.computeMap[outputField] = op;
    return this;
  }

  /**
   * Caps maximum returned records.
   */
  public limit(n: number): this {
    this.limitCount = n;
    return this;
  }

  /**
   * Sets offset of records to skip.
   */
  public offset(n: number): this {
    this.offsetCount = n;
    return this;
  }

  /**
   * Sets pagination based on 1-based page number and page size.
   */
  public page(pageNumber: number, pageSize: number): this {
    this.limitCount = Math.max(pageSize, 1);
    this.offsetCount = Math.max(pageNumber - 1, 0) * this.limitCount;
    return this;
  }

  /**
   * Includes records with non-active lifecycle status.
   */
  public includeAllOperations(include = true): this {
    this.includeAll = include;
    return this;
  }

  /**
   * Restricts query to specific lifecycle operations.
   */
  public operation(op: number): this {
    this.opFilter = op;
    return this;
  }

  /**
   * Executes the List query.
   */
  public async execute(): Promise<ListResult> {
    return this.client.list({
      limit: this.limitCount,
      offset: this.offsetCount,
      select: this.selectFields.length > 0 ? this.selectFields : undefined,
      filters: this.filterList.length > 0 ? this.filterList : undefined,
      computations: Object.keys(this.computeMap).length > 0 ? this.computeMap : undefined,
      includeAllOperations: this.includeAll,
      operationFilter: this.opFilter,
      allowedOperations: this.allowedOps,
    });
  }
}

/**
 * Fluent builder for batch mutations and in-place arithmetic updates.
 */
export class UpdateBuilder {
  private client: BuilderClientContext;
  private targets: string[] = [];
  private filterList: FilterCondition[] = [];
  private mutationsMap: Record<string, ComputeOp> = {};
  private limitCount = 0;
  private offsetCount = 0;

  constructor(client: BuilderClientContext) {
    this.client = client;
  }

  /**
   * Scopes update to specific entity identifiers.
   */
  public in(...targetEntities: string[]): this {
    this.targets.push(...targetEntities);
    return this;
  }

  /**
   * Adds a filter predicate.
   */
  public where(field: string, operator: string, value: number | string): this {
    this.filterList.push({
      field,
      operator,
      value: normalizeFilterValue(value),
    });
    return this;
  }

  /**
   * Adds a range filter predicate.
   */
  public whereBetween(field: string, low: number | string, high: number | string): this {
    this.filterList.push({
      field,
      operator: 'BETWEEN',
      value: normalizeFilterValue(low),
      valueHigh: normalizeFilterValue(high),
    });
    return this;
  }

  /**
   * Adds a mutation rule for an attribute field.
   */
  public set(field: string, opOrValue: ComputeOp | number | string): this {
    if (typeof opOrValue === 'object' && opOrValue !== null && 'type' in opOrValue) {
      this.mutationsMap[field] = opOrValue as ComputeOp;
    } else {
      this.mutationsMap[field] = { type: 'assign', value: String(opOrValue) };
    }
    return this;
  }

  /**
   * Caps maximum records to update.
   */
  public limit(n: number): this {
    this.limitCount = n;
    return this;
  }

  /**
   * Executes the atomic batch update and returns number of records updated.
   */
  public async execute(): Promise<number> {
    return this.client.update({
      targetEntities: this.targets.length > 0 ? this.targets : undefined,
      filters: this.filterList.length > 0 ? this.filterList : undefined,
      mutations: this.mutationsMap,
      limit: this.limitCount > 0 ? this.limitCount : undefined,
      offset: this.offsetCount > 0 ? this.offsetCount : undefined,
    });
  }
}

/**
 * Fluent builder for spatial ray casting, role alignment, and multi-hop reasoning.
 */
export class GraphBuilder {
  private client: BuilderClientContext;
  private inputsList: string[] = [];
  private relationName = '';
  private relationChainList: string[] = [];
  private beamWidthVal = 0.5;
  private limitKVal = 10;
  private orderModeVal: OrderByModeType | number = OrderByMode.Composite;
  private isChaining = false;

  constructor(client: BuilderClientContext) {
    this.client = client;
  }

  /**
   * Sets input starting concept nodes.
   */
  public from(...words: string[]): this {
    this.inputsList.push(...words);
    return this;
  }

  /**
   * Sets the single relation along which to cast the spatial ray.
   */
  public relate(relation: string): this {
    this.relationName = relation;
    this.isChaining = false;
    return this;
  }

  /**
   * Sets a multi-hop sequence of relations for chained traversal.
   */
  public chain(...relations: string[]): this {
    this.relationChainList.push(...relations);
    this.isChaining = true;
    return this;
  }

  /**
   * Sets ordering strategy (OrderByMode.Distance, Score, Composite).
   */
  public orderBy(mode: OrderByModeType | number): this {
    this.orderModeVal = mode;
    return this;
  }

  /**
   * Sets beam cylinder tolerance width.
   */
  public beamWidth(width: number): this {
    this.beamWidthVal = width;
    return this;
  }

  /**
   * Maximum ranked neighbors to return.
   */
  public topK(k: number): this {
    this.limitKVal = k;
    return this;
  }

  /**
   * Executes the graph query.
   */
  public async execute(): Promise<GraphResponse> {
    if (this.isChaining && this.relationChainList.length > 0) {
      const results = await this.client.graphChain({
        inputs: this.inputsList,
        relationChain: this.relationChainList,
        limitK: this.limitKVal,
        beamWidth: this.beamWidthVal,
      });
      return {
        anchor: { x: 0, y: 0 },
        results,
      };
    }

    return this.client.graph(
      this.inputsList,
      this.relationName,
      this.limitKVal,
      this.orderModeVal,
      this.beamWidthVal,
    );
  }
}

/**
 * Geometric and mathematical operations engine on graph concepts.
 */
export class MathEngine {
  private client: BuilderClientContext;

  constructor(client: BuilderClientContext) {
    this.client = client;
  }

  /**
   * Computes Euclidean distance between two concept nodes.
   */
  public async distance(wordA: string, wordB: string): Promise<number> {
    const res = await this.client.math('distance', [wordA, wordB]);
    return res.value ?? 0;
  }

  /**
   * Calculates central mass coordinate and average role distribution of multiple words.
   */
  public async centroid(...words: string[]): Promise<{ coord: Point2D; roles: Roles }> {
    const res = await this.client.math('centroid', words);
    return {
      coord: res.coord ?? { x: 0, y: 0 },
      roles: res.roles ?? [0, 0, 0, 0],
    };
  }

  /**
   * Computes cosine angle between 4D semantic role vectors of two words.
   */
  public async cosineSimilarity(wordA: string, wordB: string): Promise<number> {
    const res = await this.client.math('cosine_similarity', [wordA, wordB]);
    return res.value ?? 0;
  }

  /**
   * Finds the K spatially closest concept nodes around a target word.
   */
  public async nearest(word: string, limitK = 10): Promise<GraphQueryResult[]> {
    const res = await this.client.math('nearest', [word], limitK);
    return res.neighbors ?? [];
  }
}
