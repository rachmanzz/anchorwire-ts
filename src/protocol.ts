import {
  MAGIC,
  VERSION,
  HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
  OpCode,
  OpStatus,
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
  MathResponse,
  Point2D,
  Roles,
} from './types.js';

// --- BUFFER UTILITIES --------------------------------------------------------

export function appendString(chunks: Buffer[], str: string): void {
  const strBuf = Buffer.from(str, 'utf-8');
  const len = Math.min(strBuf.length, 0xFFFF);
  const lenBuf = Buffer.allocUnsafe(2);
  lenBuf.writeUInt16LE(len, 0);
  chunks.push(lenBuf);
  chunks.push(strBuf.subarray(0, len));
}

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

export function encodeFrame(frame: Frame): Buffer {
  const payload = frame.payload ?? Buffer.alloc(0);
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

export function encodeAuthPayload(token: string): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, token);
  return Buffer.concat(chunks);
}

export function encodeSelectModelPayload(model: string): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, model);
  return Buffer.concat(chunks);
}

export function encodeSavePayload(item: RecordItem): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, item.name);

  const opByte = Buffer.allocUnsafe(1);
  opByte[0] = item.operation ?? OpStatus.Active;
  chunks.push(opByte);

  const propKeys = Object.keys(item.props);
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

export function encodeSaveBatchPayload(items: RecordItem[]): Buffer {
  const chunks: Buffer[] = [];
  const countBuf = Buffer.allocUnsafe(4);
  countBuf.writeUInt32LE(items.length, 0);
  chunks.push(countBuf);

  for (const item of items) {
    const recBytes = encodeSavePayload(item);
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32LE(recBytes.length, 0);
    chunks.push(lenBuf);
    chunks.push(recBytes);
  }

  return Buffer.concat(chunks);
}

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

export function encodeGetRequest(name: string, selectFields: string[] = [], computations: Record<string, ComputeOp> = {}): Buffer {
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

export function decodeGetResultPayload(data: Buffer, name: string): EntityResult {
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

  return { name, operation, props };
}

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
  kBuf.writeUInt32LE(limitK, 0);
  chunks.push(kBuf);

  return Buffer.concat(chunks);
}

export function decodeCausalResultPayload(data: Buffer): CausalResult[] {
  if (data.length < 4) {
    return [];
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

export function encodeListRequest(opts: ListQueryOptions): Buffer {
  const chunks: Buffer[] = [];
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const b8 = Buffer.allocUnsafe(8);
  b8.writeUInt32LE(limit, 0);
  b8.writeUInt32LE(offset, 4);
  chunks.push(b8);

  let flags = 0;
  if (opts.includeAllOperations) flags |= 1;
  if (opts.operationFilter !== undefined) flags |= 2;
  chunks.push(Buffer.from([flags]));

  if (opts.operationFilter !== undefined) {
    chunks.push(Buffer.from([opts.operationFilter]));
  }

  const allowed = opts.allowedOperations ?? [];
  chunks.push(Buffer.from([allowed.length, ...allowed]));

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

    items.push({ name, operation, props });
  }

  return { totalCount, hasMore, items };
}

export function encodeUpdateRequest(opts: UpdateQueryOptions): Buffer {
  const chunks: Buffer[] = [];
  const limit = opts.limit ?? 10000;
  const offset = opts.offset ?? 0;

  const b8 = Buffer.allocUnsafe(8);
  b8.writeUInt32LE(limit, 0);
  b8.writeUInt32LE(offset, 4);
  chunks.push(b8);

  const targets = opts.targetEntities ?? [];
  const tBuf = Buffer.allocUnsafe(4);
  tBuf.writeUInt32LE(targets.length, 0);
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

export function decodeUpdateResponse(data: Buffer): number {
  if (data.length < 4) {
    throw new Error('Truncated update response');
  }
  return data.readUInt32LE(0);
}

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
  b9.writeUInt32LE(limitK, 0);
  b9[4] = orderMode;
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

export function encodeMathRequest(op: string, words: string[], limitK: number): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, op);

  const b4 = Buffer.allocUnsafe(4);
  b4.writeUInt32LE(limitK, 0);
  chunks.push(b4);

  const cBuf = Buffer.allocUnsafe(2);
  cBuf.writeUInt16LE(words.length, 0);
  chunks.push(cBuf);
  for (const w of words) {
    appendString(chunks, w);
  }

  return Buffer.concat(chunks);
}

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

export function encodeResetModelPayload(confirm: boolean): Buffer {
  return Buffer.from([confirm ? 1 : 0]);
}

export function encodeOKPayload(message: string): Buffer {
  const chunks: Buffer[] = [];
  appendString(chunks, message);
  return Buffer.concat(chunks);
}

export function decodeOKPayload(data: Buffer): string {
  const { value } = readString(data, 0);
  return value;
}

export function encodeErrorPayload(code: number, message: string): Buffer {
  const codeBuf = Buffer.allocUnsafe(2);
  codeBuf.writeUInt16LE(code, 0);
  const chunks: Buffer[] = [codeBuf];
  appendString(chunks, message);
  return Buffer.concat(chunks);
}

export function decodeErrorPayload(data: Buffer): { code: number; message: string } {
  if (data.length < 2) {
    throw new Error('Truncated error payload');
  }
  const code = data.readUInt16LE(0);
  const { value: message } = readString(data, 2);
  return { code, message };
}

// --- FILTER & COMPUTE HELPERS ------------------------------------------------

function appendFilterCondition(chunks: Buffer[], f: FilterCondition): void {
  appendString(chunks, f.field);
  appendString(chunks, f.operator);
  const vBuf = Buffer.allocUnsafe(8);
  vBuf.writeFloatLE(f.value, 0);
  vBuf.writeFloatLE(f.valueHigh ?? 0, 4);
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
