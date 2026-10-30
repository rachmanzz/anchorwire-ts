/**
 * Constants for the AnchorWire binary protocol.
 */
export const MAGIC = 0xA5;
export const VERSION = 0x01;
export const HEADER_SIZE = 16;
export const MAX_PAYLOAD_SIZE = 64 * 1024 * 1024; // 64 MiB

export const OpCode = {
  // Core & Session
  Ping: 0x01,
  Pong: 0x02,
  Auth: 0x03,
  SelectModel: 0x04,
  NegotiateMemory: 0x05,

  // Mutations & Queries
  Save: 0x10,
  SaveBatch: 0x11,
  Get: 0x12,
  Edge: 0x13,
  Causal: 0x14,
  Sync: 0x15,
  List: 0x16,
  Update: 0x17,
  Graph: 0x18,
  GraphChain: 0x19,
  AttachSchema: 0x1A,
  GetSchema: 0x1B,
  Math: 0x1C,
  ResetModel: 0x1D,

  // Cold Storage & Tiered Partition
  PartitionCatalog: 0x20,
  PartitionInspect: 0x21,

  // Cluster & Replication
  PromoteToPrimary: 0x30,
  DemoteToReplica: 0x31,
  ReplicationStream: 0x32,

  // Responses
  ResponseOK: 0x80,
  ResponseError: 0x81,
} as const;

export type OpCodeType = (typeof OpCode)[keyof typeof OpCode];

export const Flags = {
  None: 0x00,
  Compressed: 0x01,
  Oneway: 0x02,
  MemoryPressure: 0x04,
  ColdTier: 0x08,
  RoutePrimary: 0x10,
  RouteReplica: 0x20,
  EpochFenced: 0x40,
} as const;

export type FlagsType = (typeof Flags)[keyof typeof Flags];

export const OpStatus = {
  SafeDelete: 0,
  Active: 1,
  Archived: 2,
  Retry: 3,
} as const;

export type OpStatusType = (typeof OpStatus)[keyof typeof OpStatus];

export const OrderByMode = {
  Score: 0,
  AxisDistance: 1,
  Composite: 2,
} as const;

export type OrderByModeType = (typeof OrderByMode)[keyof typeof OrderByMode];
