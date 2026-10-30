import * as net from 'node:net';
import { MAGIC, VERSION, OpCode, Flags } from './constants.js';
import { encodeFrame, decodeFrame, encodeAuthPayload, encodeSelectModelPayload, decodeErrorPayload } from './protocol.js';
import { Frame, WireClientOptions } from './types.js';

interface PendingRequest {
  resolve: (frame: Frame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Manages the persistent multiplexed TCP socket connection to an AnchorDB AnchorWire server.
 */
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
  private connectPromise: Promise<void> | null = null;
  private modelSwitchQueue: Promise<void> = Promise.resolve();

  constructor(options: WireClientOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7448;
    this.token = options.token ?? '';
    this.model = options.model ?? 'default';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  }

  /**
   * Establishes the TCP socket connection and completes authentication and initial model selection.
   * Safe to call concurrently; concurrent callers share the in-flight handshake promise.
   */
  public async connect(): Promise<void> {
    if (this.isConnected && this.socket && !this.socket.destroyed) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = (async () => {
      try {
        await this.establishSocket();

        // 1. Authenticate if token provided
        if (this.token) {
          const authPayload = encodeAuthPayload(this.token);
          const resp = await this.sendRaw(OpCode.Auth, authPayload, Flags.None);
          if (resp.opCode === OpCode.ResponseError) {
            const err = decodeErrorPayload(resp.payload);
            throw new Error(`Authentication failed (${err.code}): ${err.message}`);
          }
        }

        // 2. Select initial model
        if (this.model) {
          const modelPayload = encodeSelectModelPayload(this.model);
          const resp = await this.sendRaw(OpCode.SelectModel, modelPayload, Flags.None);
          if (resp.opCode === OpCode.ResponseError) {
            const err = decodeErrorPayload(resp.payload);
            throw new Error(`Select model failed (${err.code}): ${err.message}`);
          }
        }

        this.isConnected = true;
      } catch (err) {
        this.cleanupSocket();
        throw err;
      } finally {
        this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  private establishSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`Connection to AnchorWire at ${this.host}:${this.port} timed out after ${this.connectTimeoutMs}ms`));
        }
      }, this.connectTimeoutMs);

      socket.connect(this.port, this.host, () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.setNoDelay(true);
          resolve();
        }
      });

      socket.on('data', (chunk: Buffer) => {
        this.onData(chunk);
      });

      socket.on('error', (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.onError(err);
      });

      socket.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(`Connection to AnchorWire at ${this.host}:${this.port} closed before handshake completed`));
        }
        this.onClose();
      });
    });
  }

  private onData(chunk: Buffer): void {
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }

    while (this.buffer.length > 0) {
      try {
        const decoded = decodeFrame(this.buffer);
        if (!decoded) {
          break; // Need more data for full frame
        }

        if (decoded.bytesConsumed === this.buffer.length) {
          this.buffer = Buffer.alloc(0);
        } else {
          this.buffer = this.buffer.subarray(decoded.bytesConsumed);
        }

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
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
    this.isConnected = false;
  }

  private onClose(): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(new Error('Connection closed'));
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.isConnected = false;
    this.socket = null;
  }

  private nextSeq(): number {
    const seq = this.seqCounter >>> 0;
    this.seqCounter = (this.seqCounter + 1) >>> 0;
    if (this.seqCounter === 0) {
      this.seqCounter = 1;
    }
    return seq;
  }

  private sendRaw(opCode: number, payload: Buffer, flags: number): Promise<Frame> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('Socket is not connected'));
    }

    const seq = this.nextSeq();
    const frame: Frame = {
      magic: MAGIC,
      version: VERSION,
      opCode,
      flags,
      seq,
      payload,
    };

    const wireBytes = encodeFrame(frame);

    if ((flags & Flags.Oneway) !== 0) {
      return new Promise((resolve, reject) => {
        socket.write(wireBytes, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve({
              magic: MAGIC,
              version: VERSION,
              opCode: OpCode.ResponseOK,
              flags: Flags.None,
              seq,
              payload: Buffer.alloc(0),
            });
          }
        });
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`AnchorWire request OpCode 0x${opCode.toString(16)} (seq ${seq}) timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(seq, { resolve, reject, timer });

      socket.write(wireBytes, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(seq);
          reject(err);
        }
      });
    });
  }

  /**
   * Sends a framed request to the AnchorWire server and awaits the matching response frame.
   * If targetModel is provided and differs from the active session model, switches the model first.
   */
  public async request(
    opCode: number,
    payload: Buffer = Buffer.alloc(0),
    flags: number = Flags.None,
    targetModel?: string,
  ): Promise<Frame> {
    if (!this.isConnected || !this.socket || this.socket.destroyed) {
      await this.connect();
    }

    if (targetModel && targetModel !== this.model && opCode !== OpCode.Auth && opCode !== OpCode.SelectModel) {
      await this.setModel(targetModel);
    }

    return this.sendRaw(opCode, payload, flags);
  }

  /**
   * Switches the active model on the connection session.
   */
  public async setModel(modelName: string): Promise<void> {
    const runSwitch = async () => {
      if (!this.isConnected || !this.socket || this.socket.destroyed) {
        this.model = modelName;
        await this.connect();
        return;
      }
      if (this.model === modelName) {
        return;
      }
      const resp = await this.sendRaw(OpCode.SelectModel, encodeSelectModelPayload(modelName), Flags.None);
      if (resp.opCode === OpCode.ResponseError) {
        const err = decodeErrorPayload(resp.payload);
        throw new Error(`Select model failed (${err.code}): ${err.message}`);
      }
      this.model = modelName;
    };

    const next = this.modelSwitchQueue.then(runSwitch, runSwitch);
    this.modelSwitchQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Returns the currently selected model name on this connection.
   */
  public getActiveModel(): string {
    return this.model;
  }

  private cleanupSocket(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.isConnected = false;
    this.socket = null;
  }

  /**
   * Closes the underlying TCP socket and rejects any pending in-flight requests.
   */
  public close(): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(new Error('Connection closed'));
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);

    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
      this.socket.destroy();
    }
    this.isConnected = false;
    this.socket = null;
  }
}
