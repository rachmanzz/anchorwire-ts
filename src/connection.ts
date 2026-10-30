import * as net from 'node:net';
import { OpCode, Flags } from './constants.js';
import { encodeFrame, decodeFrame, encodeAuthPayload, encodeSelectModelPayload, decodeErrorPayload } from './protocol.js';
import { Frame, WireClientOptions } from './types.js';

interface PendingRequest {
  resolve: (frame: Frame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class WireConnection {
  private socket: net.Socket | null = null;
  private host: string;
  private port: number;
  private token: string;
  private model: string;
  private connectTimeoutMs: number;
  private requestTimeoutMs: number;

  private seqCounter = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private isConnected = false;
  private isConnecting = false;

  constructor(options: WireClientOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7448;
    this.token = options.token ?? '';
    this.model = options.model ?? 'default';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  }

  public async connect(): Promise<void> {
    if (this.isConnected) return;
    if (this.isConnecting) {
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (this.isConnected) {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });
      return;
    }

    this.isConnecting = true;
    try {
      await this.establishSocket();
      this.isConnected = true;

      // 1. Authenticate if token provided
      if (this.token) {
        const authPayload = encodeAuthPayload(this.token);
        const resp = await this.request(OpCode.Auth, authPayload);
        if (resp.opCode === OpCode.ResponseError) {
          const err = decodeErrorPayload(resp.payload);
          throw new Error(`Authentication failed (${err.code}): ${err.message}`);
        }
      }

      // 2. Select initial model
      if (this.model) {
        const modelPayload = encodeSelectModelPayload(this.model);
        const resp = await this.request(OpCode.SelectModel, modelPayload);
        if (resp.opCode === OpCode.ResponseError) {
          const err = decodeErrorPayload(resp.payload);
          throw new Error(`Select model failed (${err.code}): ${err.message}`);
        }
      }
    } finally {
      this.isConnecting = false;
    }
  }

  private establishSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection to AnchorWire at ${this.host}:${this.port} timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      socket.connect(this.port, this.host, () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve();
      });

      socket.on('data', (chunk: Buffer) => {
        this.onData(chunk);
      });

      socket.on('error', (err: Error) => {
        clearTimeout(timer);
        this.onError(err);
      });

      socket.on('close', () => {
        this.onClose();
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length > 0) {
      try {
        const decoded = decodeFrame(this.buffer);
        if (!decoded) {
          break; // Need more data for full frame
        }

        this.buffer = this.buffer.subarray(decoded.bytesConsumed);
        this.dispatchFrame(decoded.frame);
      } catch (err) {
        this.buffer = Buffer.alloc(0);
        this.onError(err instanceof Error ? err : new Error(String(err)));
        break;
      }
    }
  }

  private dispatchFrame(frame: Frame): void {
    const p = this.pending.get(frame.seq);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(frame.seq);
      p.resolve(frame);
    }
  }

  private onError(err: Error): void {
    for (const [seq, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
    this.isConnected = false;
  }

  private onClose(): void {
    for (const [seq, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error('Connection closed'));
    }
    this.pending.clear();
    this.isConnected = false;
    this.socket = null;
  }

  public async request(opCode: number, payload: Buffer = Buffer.alloc(0), flags = Flags.None): Promise<Frame> {
    if (!this.isConnected && opCode !== OpCode.Auth && opCode !== OpCode.SelectModel) {
      await this.connect();
    }

    if (!this.socket || this.socket.destroyed) {
      await this.connect();
    }

    const seq = this.seqCounter++ >>> 0;
    const frame: Frame = {
      magic: 0xA5,
      version: 0x01,
      opCode,
      flags,
      seq,
      payload,
    };

    const wireBytes = encodeFrame(frame);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`AnchorWire request OpCode 0x${opCode.toString(16)} (seq ${seq}) timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(seq, { resolve, reject, timer });

      this.socket!.write(wireBytes, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(seq);
          reject(err);
        }
      });
    });
  }

  public async setModel(modelName: string): Promise<void> {
    this.model = modelName;
    if (this.isConnected) {
      const resp = await this.request(OpCode.SelectModel, encodeSelectModelPayload(modelName));
      if (resp.opCode === OpCode.ResponseError) {
        const err = decodeErrorPayload(resp.payload);
        throw new Error(`Select model failed: ${err.message}`);
      }
    }
  }

  public close(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
      this.socket.destroy();
    }
    this.isConnected = false;
    this.socket = null;
  }
}
