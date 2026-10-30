import {
  MAGIC,
  VERSION,
  HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
  Flags,
  OpStatus,
  StructuredAuthMagic,
  StructuredRespMagic,
  SubCodeRotationStaged,
  AuthType,
} from './constants.js';
import { crc32IEEE } from './crc.js';
import {
  Frame,
  RecordItem,
  EntityResult,
  ComputeOp,
  FilterCondition,
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
  AuthRequest,
  MemoryNegotiationRequest,
  MemoryNegotiationResponse,
} from './types.js';
import { parseDate } from './date.js';

// --- BUFFER UTILITIES --------------------------------------------------------

/**
 * Appends a length-prefixed UTF-8 string (uint16 LE byte length + UTF-8 bytes) to chunks.
 */
export function appendString(chunks: Buffer[], str: string): void {
  const strBuf = Buffer.from(str, 'utf-8');
  if (strBuf.length > 0xFFFF) {
    throw new RangeError(`String byte length (${strBuf.length}) exceeds maximum uint16 wire limit (65535)`);
  }
  const lenBuf = Buffer.allocUnsafe(2);
  lenBuf.writeUInt16LE(strBuf.length, 0);
  chunks.push(lenBuf);
  chunks.push(strBuf);
}

/**
 * Reads a length-prefixed UTF-8 string from data starting at offset.
 */
export function readString(data: Buffer, offset: number): { value: string; nextOffset: number } {
  if (offset + 2 > data.length) {
    throw new Error('Truncated string length prefix');
  }
  const len = data.readUInt16LE(offset);
  offset += 2;
  if (offset + len > data.length) {
    throw new Error(`Truncated string content: expected ${len} bytes, got ${data.length - offset}`);
  }
  const value = data.toString('utf-8', offset, offset + len);
  return { value, nextOffset: offset + len };
}

// --- FRAME ENCODING & DECODING -----------------------------------------------

/**
 * Serializes a Frame into a 16-byte header followed by payload bytes with IEEE CRC32 checksum.
 */
export function encodeFrame(frame: Frame): Buffer {
  const payload = frame.payload ?? Buffer.alloc(0);
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new RangeError(`Payload length ${payload.length} exceeds max allowed ${MAX_PAYLOAD_SIZE}`);
  }
  const header = Buffer.allocUnsafe(HEADER_SIZE);

  header[0] = MAGIC;
  header[1] = VERSION;
  header[2] = frame.opCode;
  header[3] = frame.flags;
  header.writeUInt32LE(frame.seq >>> 0, 4);
  header.writeUInt32LE(payload.length >>> 0, 8);

  const checksum = payload.length > 0 ? crc32IEEE(payload) : 0;
  header.writeUInt32LE(checksum >>> 0, 12);

  return Buffer.concat([header, payload]);
}

/**
 * Attempts to decode a single Frame from the start of a stream buffer.
 * Returns null if the buffer contains fewer bytes than a complete frame.
 */
export function decodeFrame(buf: Buffer): { frame: Frame; bytesConsumed: number } | null {
  if (buf.length < HEADER_SIZE) {
    return null; // Need more data for header
  }

  const magic = buf[0];
  const version = buf[1];
  if (magic !== MAGIC) {
    throw new Error(`Invalid AnchorWire magic byte: 0x${magic.toString(16).toUpperCase()} (expected 0x${MAGIC.toString(16).toUpperCase()})`);
  }
  if (version !== VERSION) {
    throw new Error(`Unsupported AnchorWire version: ${version} (expected ${VERSION})`);
  }

  const opCode = buf[2];
  const flags = buf[3];
  const seq = buf.readUInt32LE(4);
  const payloadLen = buf.readUInt32LE(8);
  const expectedChecksum = buf.readUInt32LE(12);

  if (payloadLen > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload length ${payloadLen} exceeds max allowed ${MAX_PAYLOAD_SIZE}`);
  }

  const totalLength = HEADER_SIZE + payloadLen;
  if (buf.length < totalLength) {
    return null; // Need more data for full payload
  }

  const payload = buf.subarray(HEADER_SIZE, totalLength);
  if (payloadLen > 0) {
    const actualChecksum = crc32IEEE(payload);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`Checksum mismatch: expected 0x${expectedChecksum.toString(16)}, got 0x${actualChecksum.toString(16)}`);
    }
  } else if (expectedChecksum !== 0) {
    throw new Error('Non-zero checksum for empty payload');
  }

  return {
    frame: {
      magic,
      version,
      opCode,
      flags,
      seq,
      payload: Buffer.from(payload),
    },
    bytesConsumed: totalLength,
  };
}

// --- PAYLOAD CODECS ----------------------------------------------------------

/**
 * Encodes an authentication token payload for OpCode.Auth.
 */
export function encodeAuthPayload(token: string): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, token);
  return Buffer.concat(chunks);
}

/**
 * Encodes a structured authentication request for OpCode.Auth (gateway/connector handshake).
 */
export function encodeStructuredAuth(req: AuthRequest): Buffer {
  const nodeIDBytes = Buffer.from(req.nodeID, 'utf-8');
  const nodeIDLen = Math.min(nodeIDBytes.length, 0xffff);

  if (req.type === AuthType.StagedReauth) {
    const totalLen = 1 + 1 + 2 + nodeIDLen + 2 + 32 + 2 + 32;
    const buf = Buffer.alloc(totalLen);
    buf[0] = StructuredAuthMagic;
    buf[1] = AuthType.StagedReauth;

    let offset = 2;
    buf.writeUInt16LE(nodeIDLen, offset);
    offset += 2;
    nodeIDBytes.copy(buf, offset, 0, nodeIDLen);
    offset += nodeIDLen;

    buf.writeUInt16LE(32, offset);
    offset += 2;
    if (req.validator) {
      Buffer.from(req.validator).copy(buf, offset, 0, 32);
    }
    offset += 32;

    buf.writeUInt16LE(32, offset);
    offset += 2;
    if (req.nextCommitment) {
      Buffer.from(req.nextCommitment).copy(buf, offset, 0, 32);
    }
    return buf;
  }

  const credBytes = req.credential ? Buffer.from(req.credential, 'utf-8') : Buffer.alloc(0);
  const credLen = Math.min(credBytes.length, 0xffff);

  let totalLen = 1 + 1 + 2 + nodeIDLen + 2 + credLen;
  if (req.hasCommitment || req.initialCommitment) {
    totalLen += 2 + 32;
  }
  const buf = Buffer.alloc(totalLen);

  buf[0] = StructuredAuthMagic;
  buf[1] = req.type;

  let offset = 2;
  buf.writeUInt16LE(nodeIDLen, offset);
  offset += 2;
  nodeIDBytes.copy(buf, offset, 0, nodeIDLen);
  offset += nodeIDLen;

  buf.writeUInt16LE(credLen, offset);
  offset += 2;
  credBytes.copy(buf, offset, 0, credLen);
  offset += credLen;

  if (req.hasCommitment || req.initialCommitment) {
    buf.writeUInt16LE(32, offset);
    offset += 2;
    if (req.initialCommitment) {
      Buffer.from(req.initialCommitment).copy(buf, offset, 0, 32);
    }
  }

  return buf;
}

/**
 * Decodes an AuthRequest from a binary payload, falling back to legacy static token if magic is absent.
 */
export function decodeStructuredAuth(payload: Buffer): AuthRequest {
  if (payload.length === 0) {
    throw new Error('Malformed structured auth request payload: empty');
  }

  if (payload[0] !== StructuredAuthMagic) {
    const { value: credential } = readString(payload, 0);
    return {
      type: AuthType.Static,
      nodeID: '',
      credential,
    };
  }

  if (payload.length < 6) {
    throw new Error('Malformed structured auth request payload: too short');
  }

  const authType = payload[1];
  let offset = 2;

  const nodeIDLen = payload.readUInt16LE(offset);
  offset += 2;
  if (payload.length < offset + nodeIDLen) {
    throw new Error('Malformed structured auth request: truncated nodeID');
  }
  const nodeID = payload.toString('utf-8', offset, offset + nodeIDLen);
  offset += nodeIDLen;

  if (authType === AuthType.StagedReauth) {
    if (payload.length < offset + 4 + 64) {
      throw new Error('Malformed structured auth request: truncated staged reauth');
    }
    const valLen = payload.readUInt16LE(offset);
    offset += 2;
    if (valLen !== 32 || payload.length < offset + 32 + 2 + 32) {
      throw new Error('Malformed structured auth request: invalid validator length');
    }
    const validator = Buffer.from(payload.subarray(offset, offset + 32));
    offset += 32;

    const nextLen = payload.readUInt16LE(offset);
    offset += 2;
    if (nextLen !== 32 || payload.length < offset + 32) {
      throw new Error('Malformed structured auth request: invalid nextCommitment length');
    }
    const nextCommitment = Buffer.from(payload.subarray(offset, offset + 32));

    return {
      type: AuthType.StagedReauth,
      nodeID,
      validator,
      nextCommitment,
    };
  }

  if (payload.length < offset + 2) {
    throw new Error('Malformed structured auth request: missing credential length');
  }
  const credLen = payload.readUInt16LE(offset);
  offset += 2;
  if (payload.length < offset + credLen) {
    throw new Error('Malformed structured auth request: truncated credential');
  }
  const credential = payload.toString('utf-8', offset, offset + credLen);
  offset += credLen;

  const req: AuthRequest = {
    type: authType,
    nodeID,
    credential,
  };

  if (payload.length >= offset + 2 + 32) {
    const commLen = payload.readUInt16LE(offset);
    if (commLen === 32) {
      offset += 2;
      req.initialCommitment = Buffer.from(payload.subarray(offset, offset + 32));
      req.hasCommitment = true;
    }
  }

  return req;
}

/**
 * Encodes an issued session key into an OpResponseOK payload.
 */
export function encodeAuthResponse(sessionKey: string): Buffer {
  const keyBytes = Buffer.from(sessionKey, 'utf-8');
  const keyLen = Math.min(keyBytes.length, 0xffff);
  const buf = Buffer.alloc(1 + 2 + keyLen);
  buf[0] = StructuredRespMagic;
  buf.writeUInt16LE(keyLen, 1);
  keyBytes.copy(buf, 3, 0, keyLen);
  return buf;
}

/**
 * Decodes an issued session key from a structured OpResponseOK payload.
 */
export function decodeAuthResponse(payload: Buffer): string {
  if (payload.length < 3) {
    throw new Error('Malformed structured auth response: truncated');
  }
  if (payload[0] !== StructuredRespMagic) {
    throw new Error('Auth response is not a structured session response');
  }
  const keyLen = payload.readUInt16LE(1);
  if (payload.length < 3 + keyLen) {
    throw new Error('Malformed structured auth response: truncated key bytes');
  }
  return payload.toString('utf-8', 3, 3 + keyLen);
}

/**
 * Encodes an OpResponseOK payload carrying SubCodeRotationStaged.
 */
export function encodeRotationStagedResponse(msg: string): Buffer {
  const msgBytes = Buffer.from(msg, 'utf-8');
  const msgLen = Math.min(msgBytes.length, 0xffff);
  const buf = Buffer.alloc(1 + 1 + 2 + msgLen);
  buf[0] = StructuredRespMagic;
  buf[1] = SubCodeRotationStaged;
  buf.writeUInt16LE(msgLen, 2);
  msgBytes.copy(buf, 4, 0, msgLen);
  return buf;
}

/**
 * Decodes an OpResponseOK payload carrying SubCodeRotationStaged.
 */
export function decodeRotationStagedResponse(payload: Buffer): { subCode: number; message: string } {
  if (payload.length < 4) {
    throw new Error('Malformed structured rotation response: truncated');
  }
  if (payload[0] !== StructuredRespMagic) {
    throw new Error('Auth response is not a structured response');
  }
  const subCode = payload[1];
  const msgLen = payload.readUInt16LE(2);
  if (payload.length < 4 + msgLen) {
    throw new Error('Malformed structured rotation response: truncated message bytes');
  }
  return { subCode, message: payload.toString('utf-8', 4, 4 + msgLen) };
}

/**
 * Encodes client workload estimation for OpCode.NegotiateMemory.
 */
export function encodeMemoryNegotiationRequest(req: MemoryNegotiationRequest): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(req.targetRecords >>> 0, 0);
  buf.writeUInt32LE(req.estimatedRecordSizeBytes >>> 0, 4);
  buf.writeUInt32LE(req.clientBatchSize >>> 0, 8);
  return buf;
}

/**
 * Decodes client workload estimation from OpCode.NegotiateMemory request.
 */
export function decodeMemoryNegotiationRequest(data: Buffer): MemoryNegotiationRequest {
  if (data.length < 12) {
    throw new Error('Truncated memory negotiation request');
  }
  return {
    targetRecords: data.readUInt32LE(0),
    estimatedRecordSizeBytes: data.readUInt32LE(4),
    clientBatchSize: data.readUInt32LE(8),
  };
}

/**
 * Encodes server pacing strategy for OpCode.NegotiateMemory response.
 */
export function encodeMemoryNegotiationResponse(resp: MemoryNegotiationResponse): Buffer {
  const buf = Buffer.alloc(18);
  buf[0] = resp.status;
  buf[1] = resp.hostUsedPct;
  buf.writeBigUInt64LE(resp.headroomBytes, 2);
  buf.writeUInt32LE(resp.allocatedBatchSize >>> 0, 10);
  buf.writeUInt32LE(resp.releaseIntervalMs >>> 0, 14);
  return buf;
}

/**
 * Decodes server pacing strategy from OpCode.NegotiateMemory response.
 */
export function decodeMemoryNegotiationResponse(data: Buffer): MemoryNegotiationResponse {
  if (data.length < 18) {
    throw new Error('Truncated memory negotiation response');
  }
  return {
    status: data[0],
    hostUsedPct: data[1],
    headroomBytes: data.readBigUInt64LE(2),
    allocatedBatchSize: data.readUInt32LE(10),
    releaseIntervalMs: data.readUInt32LE(14),
  };
}

/**
 * Encodes a model selection payload for OpCode.SelectModel.
 */
export function encodeSelectModelPayload(model: string): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, model);
  return Buffer.concat(chunks);
}

/**
 * Encodes a single entity RecordItem for OpCode.Save.
 */
export function encodeSavePayload(item: RecordItem): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, item.name);

  const opByte = Buffer.allocUnsafe(1);
  opByte[0] = item.operation ?? OpStatus.Active;
  chunks.push(opByte);

  const propKeys = Object.keys(item.props);
  if (propKeys.length > 0xFFFF) {
    throw new RangeError(`Property count (${propKeys.length}) exceeds uint16 limit (65535)`);
  }
  const countBuf = Buffer.allocUnsafe(2);
  countBuf.writeUInt16LE(propKeys.length, 0);
  chunks.push(countBuf);

  for (const k of propKeys) {
    appendString(chunks, k);
    const valBuf = Buffer.allocUnsafe(4);
    valBuf.writeFloatLE(item.props[k], 0);
    chunks.push(valBuf);
  }

  if (item.coord || item.roles) {
    chunks.push(Buffer.from([1])); // has node
    const geoBuf = Buffer.allocUnsafe(24);
    geoBuf.writeFloatLE(item.coord?.x ?? 0, 0);
    geoBuf.writeFloatLE(item.coord?.y ?? 0, 4);
    for (let r = 0; r < 4; r++) {
      geoBuf.writeFloatLE(item.roles ? item.roles[r] : 0, 8 + r * 4);
    }
    chunks.push(geoBuf);
  } else {
    chunks.push(Buffer.from([0])); // no node
  }

  return Buffer.concat(chunks);
}

/**
 * Decodes a single entity RecordItem from OpCode.Save wire format.
 */
export function decodeSavePayload(data: Buffer): RecordItem {
  const { value: name, nextOffset: o1 } = readString(data, 0);
  let offset = o1;
  if (offset + 1 > data.length) {
    throw new Error('Truncated operation byte');
  }
  const operation = data[offset++];

  if (offset + 2 > data.length) {
    throw new Error('Truncated attr count');
  }
  const attrCount = data.readUInt16LE(offset);
  offset += 2;

  const props: Record<string, number> = {};
  for (let i = 0; i < attrCount; i++) {
    const { value: key, nextOffset } = readString(data, offset);
    offset = nextOffset;
    if (offset + 4 > data.length) {
      throw new Error('Truncated attr value');
    }
    props[key] = data.readFloatLE(offset);
    offset += 4;
  }

  const item: RecordItem = {
    name,
    operation,
    props,
  };

  if (offset < data.length && data[offset] === 1) {
    offset++;
    if (offset + 24 > data.length) {
      throw new Error('Truncated geometry bytes');
    }
    const x = data.readFloatLE(offset);
    const y = data.readFloatLE(offset + 4);
    const roles: Roles = [
      data.readFloatLE(offset + 8),
      data.readFloatLE(offset + 12),
      data.readFloatLE(offset + 16),
      data.readFloatLE(offset + 20),
    ];
    item.coord = { x, y };
    item.roles = roles;
  }

  return item;
}

/**
 * Encodes an array of RecordItems for OpCode.SaveBatch.
 */
export function encodeSaveBatchPayload(items: RecordItem[]): Buffer {
  const chunks: Buffer[] = [];
  const countBuf = Buffer.allocUnsafe(4);
  countBuf.writeUInt32LE(items.length >>> 0, 0);
  chunks.push(countBuf);

  for (const item of items) {
    const recBytes = encodeSavePayload(item);
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32LE(recBytes.length >>> 0, 0);
    chunks.push(lenBuf);
    chunks.push(recBytes);
  }

  return Buffer.concat(chunks);
}

/**
 * Decodes an array of RecordItems from OpCode.SaveBatch wire format.
 */
export function decodeSaveBatchPayload(data: Buffer): RecordItem[] {
  if (data.length < 4) {
    throw new Error('Truncated batch count');
  }
  const count = data.readUInt32LE(0);
  let offset = 4;
  const items: RecordItem[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 4 > data.length) {
      throw new Error('Truncated record length in batch');
    }
    const recLen = data.readUInt32LE(offset);
    offset += 4;
    if (offset + recLen > data.length) {
      throw new Error('Truncated record bytes in batch');
    }
    const item = decodeSavePayload(data.subarray(offset, offset + recLen));
    items.push(item);
    offset += recLen;
  }
  return items;
}

/**
 * Encodes an entity Get request with optional field projection and in-storage computations.
 */
export function encodeGetRequest(
  name: string,
  selectFields: string[] = [],
  computations: Record<string, ComputeOp> = {},
): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, name);

  const compKeys = Object.keys(computations);
  if (selectFields.length === 0 && compKeys.length === 0) {
    return Buffer.concat(chunks);
  }

  const selCountBuf = Buffer.allocUnsafe(2);
  selCountBuf.writeUInt16LE(selectFields.length, 0);
  chunks.push(selCountBuf);
  for (const s of selectFields) {
    appendString(chunks, s);
  }

  const compCountBuf = Buffer.allocUnsafe(2);
  compCountBuf.writeUInt16LE(compKeys.length, 0);
  chunks.push(compCountBuf);
  for (const k of compKeys) {
    appendString(chunks, k);
    appendComputeOp(chunks, computations[k]);
  }

  return Buffer.concat(chunks);
}

/**
 * Decodes the response payload of OpCode.Get into an EntityResult.
 */
export function decodeGetResultPayload(data: Buffer, name: string, flags: number = Flags.None): EntityResult {
  if (data.length < 3) {
    throw new Error('Truncated Get result payload');
  }
  const operation = data[0];
  const attrCount = data.readUInt16LE(1);
  let offset = 3;

  const props: Record<string, number> = {};
  for (let i = 0; i < attrCount; i++) {
    const { value: key, nextOffset } = readString(data, offset);
    offset = nextOffset;
    if (offset + 4 > data.length) {
      throw new Error('Truncated attr value in Get result');
    }
    props[key] = data.readFloatLE(offset);
    offset += 4;
  }

  const isColdTier = (flags & Flags.ColdTier) !== 0;
  return new EntityResult(name, operation, props, isColdTier);
}

/**
 * Encodes an edge mutation or spatial relation definition for OpCode.Edge.
 */
export function encodeEdgePayload(
  action: 'add' | 'remove' | 'set_relation',
  source: string,
  relation: string,
  target: string,
  weight: number = 1.0,
  direction?: Point2D,
): Buffer {
  let actByte = 0;
  if (action === 'remove') actByte = 1;
  else if (action === 'set_relation') actByte = 2;

  const chunks: Buffer[] = [Buffer.from([actByte])];
  appendString(chunks, source);
  appendString(chunks, relation);
  appendString(chunks, target);

  const wBuf = Buffer.allocUnsafe(4);
  wBuf.writeFloatLE(weight, 0);
  chunks.push(wBuf);

  if (direction) {
    const dirBuf = Buffer.allocUnsafe(8);
    dirBuf.writeFloatLE(direction.x, 0);
    dirBuf.writeFloatLE(direction.y, 4);
    chunks.push(dirBuf);
  }

  return Buffer.concat(chunks);
}

/**
 * Encodes a multi-hop causal query payload for OpCode.Causal.
 */
export function encodeCausalPayload(seeds: string[], relation: string, limitK: number): Buffer {
  const chunks: Buffer[] = [];
  const countBuf = Buffer.allocUnsafe(2);
  countBuf.writeUInt16LE(seeds.length, 0);
  chunks.push(countBuf);

  for (const seed of seeds) {
    appendString(chunks, seed);
  }
  appendString(chunks, relation);

  const kBuf = Buffer.allocUnsafe(4);
  kBuf.writeUInt32LE(limitK >>> 0, 0);
  chunks.push(kBuf);

  return Buffer.concat(chunks);
}

/**
 * Decodes the response payload of OpCode.Causal into scored CausalResult items.
 */
export function decodeCausalResultPayload(data: Buffer): CausalResult[] {
  if (data.length === 0) {
    return [];
  }
  if (data.length < 4) {
    throw new Error('Truncated causal result count');
  }
  const count = data.readUInt32LE(0);
  let offset = 4;
  const results: CausalResult[] = [];

  for (let i = 0; i < count; i++) {
    const { value: word, nextOffset } = readString(data, offset);
    offset = nextOffset;
    if (offset + 4 > data.length) {
      throw new Error('Truncated score in causal result');
    }
    const score = data.readFloatLE(offset);
    offset += 4;
    results.push({ word, score });
  }

  return results;
}

/**
 * Encodes a structured List query request for OpCode.List.
 */
export function encodeListRequest(opts: ListQueryOptions): Buffer {
  const chunks: Buffer[] = [];
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const b8 = Buffer.allocUnsafe(8);
  b8.writeUInt32LE(limit >>> 0, 0);
  b8.writeUInt32LE(offset >>> 0, 4);
  chunks.push(b8);

  let flags = 0;
  if (opts.includeAllOperations) flags |= 1;
  if (opts.operationFilter !== undefined) flags |= 2;
  chunks.push(Buffer.from([flags]));

  if (opts.operationFilter !== undefined) {
    chunks.push(Buffer.from([opts.operationFilter & 0xFF]));
  }

  const allowed = opts.allowedOperations ?? [];
  if (allowed.length > 0xFF) {
    throw new RangeError(`allowedOperations length (${allowed.length}) exceeds uint8 limit (255)`);
  }
  chunks.push(Buffer.from([allowed.length, ...allowed.map((op) => op & 0xFF)]));

  const select = opts.select ?? [];
  const selBuf = Buffer.allocUnsafe(2);
  selBuf.writeUInt16LE(select.length, 0);
  chunks.push(selBuf);
  for (const s of select) {
    appendString(chunks, s);
  }

  const filters = opts.filters ?? [];
  const filterBuf = Buffer.allocUnsafe(2);
  filterBuf.writeUInt16LE(filters.length, 0);
  chunks.push(filterBuf);
  for (const f of filters) {
    appendFilterCondition(chunks, f);
  }

  const computations = opts.computations ?? {};
  const compKeys = Object.keys(computations);
  const compBuf = Buffer.allocUnsafe(2);
  compBuf.writeUInt16LE(compKeys.length, 0);
  chunks.push(compBuf);
  for (const k of compKeys) {
    appendString(chunks, k);
    appendComputeOp(chunks, computations[k]);
  }

  return Buffer.concat(chunks);
}

/**
 * Decodes the paginated response of OpCode.List.
 */
export function decodeListResponse(data: Buffer): ListResult {
  if (data.length < 9) {
    throw new Error('Truncated list response header');
  }
  const totalCount = data.readUInt32LE(0);
  const hasMore = data[4] === 1;
  const itemCount = data.readUInt32LE(5);
  let offset = 9;

  const items: EntityResult[] = [];
  for (let i = 0; i < itemCount; i++) {
    const { value: name, nextOffset } = readString(data, offset);
    offset = nextOffset;
    if (offset + 1 > data.length) {
      throw new Error('Truncated item operation byte');
    }
    const operation = data[offset];
    offset += 1;

    if (offset + 2 > data.length) {
      throw new Error('Truncated item attr count');
    }
    const attrCount = data.readUInt16LE(offset);
    offset += 2;

    const props: Record<string, number> = {};
    for (let j = 0; j < attrCount; j++) {
      const { value: key, nextOffset: no } = readString(data, offset);
      offset = no;
      if (offset + 4 > data.length) {
        throw new Error('Truncated item attr value');
      }
      props[key] = data.readFloatLE(offset);
      offset += 4;
    }

    items.push(new EntityResult(name, operation, props));
  }

  return { totalCount, hasMore, items };
}

/**
 * Encodes a batch Update request for OpCode.Update.
 */
export function encodeUpdateRequest(opts: UpdateQueryOptions): Buffer {
  const chunks: Buffer[] = [];
  const limit = opts.limit ?? 10000;
  const offset = opts.offset ?? 0;

  const b8 = Buffer.allocUnsafe(8);
  b8.writeUInt32LE(limit >>> 0, 0);
  b8.writeUInt32LE(offset >>> 0, 4);
  chunks.push(b8);

  const targets = opts.targetEntities ?? [];
  const tBuf = Buffer.allocUnsafe(4);
  tBuf.writeUInt32LE(targets.length >>> 0, 0);
  chunks.push(tBuf);
  for (const t of targets) {
    appendString(chunks, t);
  }

  const filters = opts.filters ?? [];
  const fBuf = Buffer.allocUnsafe(2);
  fBuf.writeUInt16LE(filters.length, 0);
  chunks.push(fBuf);
  for (const f of filters) {
    appendFilterCondition(chunks, f);
  }

  const mutations = opts.mutations ?? {};
  const mutKeys = Object.keys(mutations);
  const mBuf = Buffer.allocUnsafe(2);
  mBuf.writeUInt16LE(mutKeys.length, 0);
  chunks.push(mBuf);
  for (const k of mutKeys) {
    appendString(chunks, k);
    appendComputeOp(chunks, mutations[k]);
  }

  return Buffer.concat(chunks);
}

/**
 * Decodes the updated entity count from OpCode.Update response.
 */
export function decodeUpdateResponse(data: Buffer): number {
  if (data.length < 4) {
    throw new Error('Truncated update response');
  }
  return data.readUInt32LE(0);
}

/**
 * Encodes a spatial beam Graph traversal request for OpCode.Graph.
 */
export function encodeGraphRequest(
  inputs: string[],
  relation: string,
  limitK: number,
  orderMode: number,
  beamWidth: number,
): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, relation);

  const b9 = Buffer.allocUnsafe(9);
  b9.writeUInt32LE(limitK >>> 0, 0);
  b9[4] = orderMode & 0xFF;
  b9.writeFloatLE(beamWidth, 5);
  chunks.push(b9);

  const cBuf = Buffer.allocUnsafe(2);
  cBuf.writeUInt16LE(inputs.length, 0);
  chunks.push(cBuf);
  for (const inWord of inputs) {
    appendString(chunks, inWord);
  }

  return Buffer.concat(chunks);
}

/**
 * Decodes a GraphResponse from OpCode.Graph or OpCode.GraphChain.
 */
export function decodeGraphResponse(data: Buffer): GraphResponse {
  if (data.length < 12) {
    throw new Error('Truncated graph response header');
  }
  const anchor: Point2D = {
    x: data.readFloatLE(0),
    y: data.readFloatLE(4),
  };
  const resultCount = data.readUInt32LE(8);
  let offset = 12;

  const results: GraphQueryResult[] = [];
  for (let i = 0; i < resultCount; i++) {
    const { value: word, nextOffset } = readString(data, offset);
    offset = nextOffset;
    if (offset + 20 > data.length) {
      throw new Error('Truncated graph result item');
    }
    const score = data.readFloatLE(offset);
    const t = data.readFloatLE(offset + 4);
    const distSqPerp = data.readFloatLE(offset + 8);
    const x = data.readFloatLE(offset + 12);
    const y = data.readFloatLE(offset + 16);
    offset += 20;

    results.push({
      word,
      score,
      t,
      distSqPerp,
      coord: { x, y },
    });
  }

  return { anchor, results };
}

/**
 * Encodes a multi-hop GraphChain request for OpCode.GraphChain.
 */
export function encodeGraphChainRequest(opts: GraphChainOptions): Buffer {
  const chunks: Buffer[] = [];
  const limitK = opts.limitK ?? 10;
  const beamWidth = opts.beamWidth ?? 0.5;

  const b8 = Buffer.allocUnsafe(8);
  b8.writeUInt32LE(limitK >>> 0, 0);
  b8.writeFloatLE(beamWidth, 4);
  chunks.push(b8);

  const inBuf = Buffer.allocUnsafe(2);
  inBuf.writeUInt16LE(opts.inputs.length, 0);
  chunks.push(inBuf);
  for (const input of opts.inputs) {
    appendString(chunks, input);
  }

  const relBuf = Buffer.allocUnsafe(2);
  relBuf.writeUInt16LE(opts.relationChain.length, 0);
  chunks.push(relBuf);
  for (const rel of opts.relationChain) {
    appendString(chunks, rel);
  }

  return Buffer.concat(chunks);
}

/**
 * Encodes a schema JSON string for OpCode.AttachSchema.
 */
export function encodeAttachSchemaPayload(schemaJSON: string): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, schemaJSON);
  return Buffer.concat(chunks);
}

/**
 * Decodes a schema JSON string from OpCode.GetSchema response.
 */
export function decodeGetSchemaPayload(data: Buffer): string {
  const { value } = readString(data, 0);
  return value;
}

/**
 * Encodes an in-storage geometric Math request for OpCode.Math.
 */
export function encodeMathRequest(op: string, words: string[], limitK: number): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, op);

  const b4 = Buffer.allocUnsafe(4);
  b4.writeUInt32LE(limitK >>> 0, 0);
  chunks.push(b4);

  const cBuf = Buffer.allocUnsafe(2);
  cBuf.writeUInt16LE(words.length, 0);
  chunks.push(cBuf);
  for (const w of words) {
    appendString(chunks, w);
  }

  return Buffer.concat(chunks);
}

/**
 * Decodes a MathResponse from OpCode.Math.
 */
export function decodeMathResponse(data: Buffer): MathResponse {
  if (data.length < 32) {
    throw new Error('Truncated math response');
  }
  const value = data.readFloatLE(0);
  const coord: Point2D = {
    x: data.readFloatLE(4),
    y: data.readFloatLE(8),
  };
  const roles: Roles = [
    data.readFloatLE(12),
    data.readFloatLE(16),
    data.readFloatLE(20),
    data.readFloatLE(24),
  ];
  const neighborCount = data.readUInt32LE(28);
  let offset = 32;

  const neighbors: GraphQueryResult[] = [];
  for (let i = 0; i < neighborCount; i++) {
    const { value: word, nextOffset } = readString(data, offset);
    offset = nextOffset;
    if (offset + 20 > data.length) {
      throw new Error('Truncated math neighbor item');
    }
    const score = data.readFloatLE(offset);
    const t = data.readFloatLE(offset + 4);
    const distSqPerp = data.readFloatLE(offset + 8);
    const x = data.readFloatLE(offset + 12);
    const y = data.readFloatLE(offset + 16);
    offset += 20;

    neighbors.push({
      word,
      score,
      t,
      distSqPerp,
      coord: { x, y },
    });
  }

  return { value, coord, roles, neighbors };
}

/**
 * Encodes the confirmation flag for OpCode.ResetModel.
 */
export function encodeResetModelPayload(confirm: boolean): Buffer {
  return Buffer.from([confirm ? 1 : 0]);
}

/**
 * Encodes a model filter for OpCode.PartitionCatalog.
 */
export function encodePartitionCatalogRequest(model: string = ''): Buffer {
  return Buffer.from(model, 'utf-8');
}

/**
 * Decodes the JSON catalog entries from OpCode.PartitionCatalog response.
 */
export function decodePartitionCatalogResponse(data: Buffer): PartitionCatalogItem[] {
  if (data.length === 0) return [];
  const parsed = JSON.parse(data.toString('utf-8')) as PartitionCatalogItem[] | null;
  return parsed ?? [];
}

/**
 * Encodes a partition inspect request for OpCode.PartitionInspect.
 */
export function encodePartitionInspectRequest(req: PartitionInspectRequest): Buffer {
  return Buffer.from(JSON.stringify(req), 'utf-8');
}

/**
 * Decodes a partition inspect response from OpCode.PartitionInspect.
 */
export function decodePartitionInspectResponse(data: Buffer): PartitionInspectResponse {
  return JSON.parse(data.toString('utf-8')) as PartitionInspectResponse;
}

/**
 * Encodes a length-prefixed OK status message.
 */
export function encodeOKPayload(message: string): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, message);
  return Buffer.concat(chunks);
}

/**
 * Decodes a length-prefixed OK status message.
 */
export function decodeOKPayload(data: Buffer): string {
  const { value } = readString(data, 0);
  return value;
}

/**
 * Encodes a 2-byte error code and length-prefixed error message.
 */
export function encodeErrorPayload(code: number, message: string): Buffer {
  const codeBuf = Buffer.allocUnsafe(2);
  codeBuf.writeUInt16LE(code, 0);
  const chunks: Buffer[] = [codeBuf];
  appendString(chunks, message);
  return Buffer.concat(chunks);
}

/**
 * Decodes a 2-byte error code and length-prefixed error message from OpCode.ResponseError.
 */
export function decodeErrorPayload(data: Buffer): { code: number; message: string } {
  if (data.length < 2) {
    throw new Error('Truncated error payload');
  }
  const code = data.readUInt16LE(0);
  const { value: message } = readString(data, 2);
  return { code, message };
}

// --- FILTER & COMPUTE HELPERS ------------------------------------------------

function parseFilterValueToFloat(v: number | string): number {
  if (typeof v === 'number') {
    return v;
  }
  const str = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return parseDate(str);
  }
  const parsed = Number.parseFloat(str);
  if (Number.isNaN(parsed)) {
    throw new Error(`cannot convert filter value "${v}" to float32`);
  }
  return parsed;
}

function appendFilterCondition(chunks: Buffer[], f: FilterCondition): void {
  appendString(chunks, f.field);
  appendString(chunks, f.operator);
  const val = parseFilterValueToFloat(f.value);
  const valHigh = f.valueHigh !== undefined ? parseFilterValueToFloat(f.valueHigh) : 0;
  const vBuf = Buffer.allocUnsafe(8);
  vBuf.writeFloatLE(val, 0);
  vBuf.writeFloatLE(valHigh, 4);
  chunks.push(vBuf);
}

function appendComputeOp(chunks: Buffer[], op: ComputeOp): void {
  switch (op.type) {
    case 'divide':
      chunks.push(Buffer.from([1]));
      appendString(chunks, op.fieldA);
      appendString(chunks, op.fieldB);
      break;
    case 'multiply':
      chunks.push(Buffer.from([2]));
      appendString(chunks, op.fieldA);
      appendString(chunks, op.fieldB);
      break;
    case 'add':
      chunks.push(Buffer.from([3]));
      appendString(chunks, op.fieldA);
      appendString(chunks, op.fieldB);
      break;
    case 'subtract':
      chunks.push(Buffer.from([4]));
      appendString(chunks, op.fieldA);
      appendString(chunks, op.fieldB);
      break;
    case 'addDays': {
      chunks.push(Buffer.from([5]));
      appendString(chunks, op.field);
      const b = Buffer.allocUnsafe(4);
      b.writeFloatLE(op.days, 0);
      chunks.push(b);
      break;
    }
    case 'subtractDays': {
      chunks.push(Buffer.from([6]));
      appendString(chunks, op.field);
      const b = Buffer.allocUnsafe(4);
      b.writeFloatLE(op.days, 0);
      chunks.push(b);
      break;
    }
    case 'daysBetween':
      chunks.push(Buffer.from([7]));
      appendString(chunks, op.fieldA);
      appendString(chunks, op.fieldB);
      break;
    case 'assign':
      chunks.push(Buffer.from([8]));
      appendString(chunks, op.value);
      break;
  }
}
