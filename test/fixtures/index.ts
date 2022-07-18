// Copyright 2022 Joshua Honig. All rights reserved.
// Use of this source code is governed by a MIT
// license that can be found in the LICENSE file.

import { Transactable, Txn, TxnAccessor, TxnOptions } from '$';
import { PromiseHandle } from '$test/lib/util';
import { Canceler, Context, IContext, Maybe, withValue } from '@sabl/context';

export interface StackApi {
  push(ctx: IContext, val: unknown): Promise<number>;
  peek(ctx: IContext): Promise<unknown>;
  pop(ctx: IContext): Promise<unknown>;
}

export interface StackTxn extends Txn, StackApi {}

export interface StackTransactable extends Transactable<StackTxn> {
  beginTxn(ctx: IContext, opts?: TxnOptions): Promise<StackTxn>;
}

export interface StackConn extends StackApi, StackTransactable {
  close(): Promise<void>;
}

export interface StackPool extends StackApi, StackTransactable {
  conn(ctx: IContext): Promise<StackConn>;
  close(): Promise<void>;
}

const ctxKeyStackConn = Symbol('StackConn');
const ctxKeyStackTxn = Symbol('StackTxn');

/** Set the stack pool or connection on the context */
export function withStackConn(ctx: IContext, con: StackTransactable): Context {
  return withValue(ctx, ctxKeyStackConn, con);
}

/** Get the stack pool or connection from the context */
export function getStackConn(ctx: IContext): Maybe<StackTransactable> {
  return <Maybe<StackTransactable>>ctx.value(ctxKeyStackConn);
}

/** Set the stack transaction on the context */
export function withStackTxn(ctx: IContext, txn: StackTxn): Context {
  return withValue(ctx, ctxKeyStackTxn, txn);
}

/** Get the stack transaction from the context */
export function getStackTxn(ctx: IContext): Maybe<StackTxn> {
  return <Maybe<StackTxn>>ctx.value(ctxKeyStackTxn);
}

/**
 * Context accessor methods for the StackApi
 * compatible with the [`txn()` API](https://npmjs.com/package/@sabl/txn#api) from
 * [`@sabl/txn`](https://npmjs.com/package/@sabl/txn)
 * */
export const StackCtxAccessor: TxnAccessor<StackTxn> = {
  getTransactable: getStackConn,
  getTxn: getStackTxn,
  withTxn: withStackTxn,
};

export interface StackConnOptions {
  nestedTxn?: boolean;
}

interface StackOp {
  op: 'push' | 'pop' | 'txn';
  val?: unknown;
  txn?: MemStackTxn;
}

interface TxnRunner {
  _txnDone(txn: MemStackTxn): null | Promise<void>;
}

class MemStackTxn implements StackTxn {
  readonly #con: TxnRunner & StackApi;
  readonly #snap: unknown[];
  readonly #ops: StackOp[] = [];
  readonly #readonly: boolean;
  readonly #connOpts: StackConnOptions;
  readonly #txns: MemStackTxn[] = [];

  #done = false;
  #clr?: Canceler;
  #onCancel: null | (() => void) = null;
  #closeResolve: PromiseHandle<void> | null = null;

  constructor(
    con: TxnRunner & StackApi,
    stack: unknown[],
    opts: TxnOptions | undefined,
    clr: Canceler | null,
    connOpts?: StackConnOptions
  ) {
    this.#con = con;
    this.#snap = stack.concat();
    this.#readonly = (opts || {}).readOnly === true;
    this.#connOpts = connOpts || {};

    if (clr != null) {
      this.#clr = clr;
      clr.onCancel(
        (this.#onCancel = this.#cancel.bind(this, Context.background))
      );
    }

    if (this.#connOpts.nestedTxn === true) {
      Object.defineProperty(this, 'beginTxn', { value: this.#beginTxn });
    }
  }

  #beginTxn(ctx: IContext, opts?: TxnOptions | undefined): Promise<StackTxn> {
    this.#checkStatus();
    const txn = new MemStackTxn(
      this,
      this.#snap,
      opts,
      ctx.canceler,
      this.#connOpts
    );
    this.#txns.push(txn);
    this.#ops.push({ op: 'txn', txn });
    return Promise.resolve(txn);
  }

  #cancel(ctx: IContext) {
    if (this.#onCancel) {
      this.#clr?.off(this.#onCancel);
      this.#onCancel = null;
    }
    if (!this.#done) {
      this.rollback(ctx);
    }
  }

  #checkStatus(mod = false) {
    if (this.#done) {
      throw new Error('Transaction is already complete');
    }
    if (mod && this.#readonly) {
      throw new Error('Cannot push or pop: Transaction is read-only');
    }
  }

  #complete(ctx: IContext): Promise<void> {
    this.#cancel(ctx);
    return this.#con._txnDone(this) || Promise.resolve();
  }

  async commit(ctx: IContext): Promise<void> {
    this.#checkStatus();
    this.#done = true;

    for (const op of this.#ops) {
      if (op.op == 'pop') {
        await this.#con.pop(ctx);
      } else if (op.op == 'push') {
        await this.#con.push(ctx, op.val);
      } else if (op.op == 'txn') {
        const txn = op.txn;
        if (txn != null && !txn.#done) {
          await txn.commit(ctx);
        }
      }
    }

    return this.#complete(ctx);
  }

  async rollback(ctx: IContext): Promise<void> {
    this.#checkStatus();
    this.#done = true;

    if (this.#txns.length > 0) {
      const promises = [];
      for (const txn of this.#txns) {
        promises.push(promises.push(txn.rollback(ctx)));
      }
      this.#txns.splice(0, this.#txns.length);
      await Promise.all(promises);
    }
    return this.#complete(ctx);
  }

  push(ctx: IContext, val: unknown): Promise<number> {
    this.#checkStatus(true);
    this.#ops.push({ op: 'push', val });
    this.#snap.push(val);
    return Promise.resolve(this.#snap.length);
  }

  pop(/* ctx: IContext */): Promise<unknown> {
    this.#checkStatus(true);
    this.#ops.push({ op: 'pop' });
    return Promise.resolve(this.#snap.pop());
  }

  peek(/* ctx: IContext */): Promise<unknown> {
    this.#checkStatus();
    return Promise.resolve(this.#snap[this.#snap.length - 1]);
  }

  _txnDone(txn: MemStackTxn): null {
    const ix = this.#txns.indexOf(txn);
    if (ix < 0) {
      return null;
    }

    this.#txns.splice(ix, 1);

    if (this.#txns.length == 0) {
      if (this.#closeResolve != null) {
        if (this.#txns.length > 0) {
          // Still a child transaction open.
          return null;
        }
        // No more child transactions open.
        return null;
      }
    }

    return null;
  }
}

class MemStackConn implements StackConn {
  readonly #stack: unknown[];
  readonly #txns: MemStackTxn[] = [];
  readonly #pool: MemStackPool;
  readonly #opts: StackConnOptions;

  #keepOpen = false;
  #closed = false;
  #closeResolve: PromiseHandle<void> | null = null;

  constructor(
    pool: MemStackPool,
    stack: unknown[],
    keepOpen: boolean,
    opts?: StackConnOptions
  ) {
    this.#pool = pool;
    this.#stack = stack;
    this.#keepOpen = keepOpen;
    this.#opts = opts || {};
  }

  #checkStatus() {
    if (this.#closed) {
      throw new Error('Connection is closed');
    }
  }

  close(): Promise<void> {
    this.#checkStatus();
    this.#closed = true;
    for (const txnId in this.#txns) {
      // Still a transaction open.
      return (this.#closeResolve = new PromiseHandle<void>()).promise;
    }
    this.#pool._release(this);
    return Promise.resolve();
  }

  beginTxn(ctx: IContext, opts?: TxnOptions | undefined): Promise<StackTxn> {
    this.#checkStatus();
    const txn = new MemStackTxn(
      this,
      this.#stack,
      opts,
      ctx.canceler,
      this.#opts
    );
    this.#txns.push(txn);
    return Promise.resolve(txn);
  }

  push(ctx: IContext, val: unknown): Promise<number> {
    this.#checkStatus();
    this.#stack.push(val);
    return Promise.resolve(this.#stack.length);
  }

  pop(/* ctx: IContext */): Promise<unknown> {
    this.#checkStatus();
    return Promise.resolve(this.#stack.pop());
  }

  peek(/* ctx: IContext */): Promise<unknown> {
    this.#checkStatus();
    return Promise.resolve(this.#stack[this.#stack.length - 1]);
  }

  _txnDone(txn: MemStackTxn): null | Promise<void> {
    const ix = this.#txns.indexOf(txn);
    if (ix < 0) {
      return null;
    }

    this.#txns.splice(ix, 1);

    if (this.#txns.length == 0) {
      if (this.#closeResolve != null) {
        if (this.#txns.length > 0) {
          // Still a transaction open.
          return null;
        }
        // No more transactions open.
        // Release the connection and resolve the close call
        this.#pool._release(this);
        this.#closeResolve.resolve();
        return null;
      }

      if (!this.#keepOpen) {
        return this.close();
      }
    }

    return null;
  }
}

class MemStackPool implements StackPool {
  readonly #stack: unknown[];
  readonly #active: MemStackConn[] = [];
  readonly #opts: StackConnOptions;
  #closed = false;
  #waitClose: PromiseHandle<void> | null = null;

  constructor(stack: unknown[], opts?: StackConnOptions) {
    this.#stack = stack;
    this.#opts = opts || {};
  }

  #checkStatus() {
    if (this.#closed) {
      throw new Error('Pool is closed');
    }
  }

  conn(/* ctx: IContext */): Promise<StackConn> {
    this.#checkStatus();
    return Promise.resolve(
      new MemStackConn(this, this.#stack, true, this.#opts)
    );
  }

  close(): Promise<void> {
    if (this.#closed) {
      return this.#waitClose?.promise || Promise.resolve();
    }

    this.#closed = true;
    if (this.#active.length > 0) {
      const p = (this.#waitClose = new PromiseHandle<void>()).promise;
      for (const c of this.#active) {
        // Signal all connections to close
        // NOT awaiting here. We want to signal
        // all connections immediately
        c.close();
      }
      return p;
    }

    return Promise.resolve();
  }

  beginTxn(ctx: IContext, opts?: TxnOptions | undefined): Promise<StackTxn> {
    this.#checkStatus();
    const con = new MemStackConn(this, this.#stack, false, this.#opts);
    return con.beginTxn(ctx, opts);
  }

  async push(ctx: IContext, val: unknown): Promise<number> {
    this.#checkStatus();
    const con = await this.conn();
    try {
      return con.push(ctx, val);
    } finally {
      con.close();
    }
  }

  async pop(ctx: IContext): Promise<unknown> {
    this.#checkStatus();
    const con = await this.conn();
    try {
      return con.pop(ctx);
    } finally {
      con.close();
    }
  }

  async peek(ctx: IContext): Promise<unknown> {
    this.#checkStatus();
    const con = await this.conn();
    try {
      return con.peek(ctx);
    } finally {
      con.close();
    }
  }

  _release(con: MemStackConn): void {
    const ix = this.#active.indexOf(con);
    if (ix < 0) {
      return;
    }
    this.#active.splice(ix, 1);

    if (this.#active.length == 0) {
      const wc = this.#waitClose;
      if (wc != null) {
        this.#waitClose = null;
        wc.resolve();
      }
    }
  }
}

export function openStackPool(
  stack: unknown[],
  opts?: StackConnOptions
): StackPool {
  return new MemStackPool(stack, opts);
}
