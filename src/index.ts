// Copyright 2022 Joshua Honig. All rights reserved.
// Use of this source code is governed by a MIT
// license that can be found in the LICENSE file.

import {
  Context,
  ContextGetter,
  ContextSetter,
  IContext,
  Maybe,
  withValue,
} from '@sabl/context';
import {
  ChangeSet,
  CtxCallback,
  Transactable,
  Txn,
  TxnAccessor,
  TxnCallback,
  TxnChangeSet,
  TxnOptions,
  TxnRunner,
  IsolationLevel,
} from './types';

export {
  IsolationLevel,
  TxnOptions,
  Txn,
  Transactable,
  CtxCallback,
  TxnCallback,
  TxnAccessor,
  TxnRunner,
  ChangeSet,
  TxnChangeSet,
};

const ctxKeyAccessor = Symbol('TransactionAccessor');

/**
 * Set the transaction accessors on the context, so
 * other locations can use transactions
 * with {@link txn} or {@link txnChangeSet} without
 * needing to know the underlying transaction type
 */
export function withTxnAccessor<T extends Txn>(
  ctx: IContext,
  accessor: TxnAccessor<T>
): Context {
  return withValue(ctx, ctxKeyAccessor, accessor);
}

/** Get the transaction accessor from the context */
export function getTxnAccessor(ctx: IContext): Maybe<TxnAccessor<Txn>> {
  return <Maybe<TxnAccessor<Txn>>>ctx.value(ctxKeyAccessor);
}

const csBuilder: Transactable<ChangeSet> = {
  beginTxn(ctx: IContext) {
    return Promise.resolve(new ChangeSetImpl(ctx));
  },
};

const ctxKeyChangeSet = Symbol('ChangeSet');

function getCsBuilder(): Maybe<Transactable<ChangeSet>> {
  return csBuilder;
}

function getChangeSet(ctx: IContext): Maybe<ChangeSet> {
  return <Maybe<ChangeSet>>ctx.value(ctxKeyChangeSet);
}

function withChangeSet(ctx: IContext, cs: ChangeSet): Context {
  return withValue(ctx, ctxKeyChangeSet, cs);
}

const ctxKeyTxnChangeSet = Symbol('TxnChangeSet');

function makeTxnCsAccessor<T extends Txn>(
  accessor: TxnAccessor<T>
): TxnAccessor<TxnChangeSet<T>> {
  return {
    getTransactable(): Maybe<Transactable<TxnChangeSet<T>>> {
      return {
        beginTxn(ctx: IContext) {
          const runner = txn(accessor);
          return Promise.resolve(new TxnChangeSetImpl(ctx, runner));
        },
      };
    },
    getTxn(ctx: IContext): Maybe<TxnChangeSet<T>> {
      return <Maybe<TxnChangeSet<T>>>ctx.value(ctxKeyTxnChangeSet);
    },
    withTxn(ctx: IContext, cs: TxnChangeSet<T>): Context {
      return withValue(ctx, ctxKeyTxnChangeSet, cs);
    },
  };
}

/**
 * Create a generic transaction runner.
 * Requires that context getters and setters
 * were themselves already added to the context
 * with {@link withTxnAccessor}.
 */
export function txn(ctx: IContext): TxnRunner<Txn>;

/**
 * Create a transaction runner for a particular
 * transaction type. Requires context getters
 * for the transaction type itself as well as
 * for an interface that can start the transaction,
 * and a context setter for the transaction type.
 */
export function txn<T extends Txn>(accessor: TxnAccessor<T>): TxnRunner<T>;

export function txn<T extends Txn>(
  ctxOrAccessor: IContext | TxnAccessor<T>
): TxnRunner<T> | TxnRunner<Txn> {
  if ('getTxn' in ctxOrAccessor) {
    return new TxnRunnerImpl<T>(ctxOrAccessor);
  }

  const baseAccessor = getTxnAccessor(ctxOrAccessor);
  if (baseAccessor == null) {
    throw new Error('No transaction accessors defined on context');
  }
  return new TxnRunnerImpl<Txn>(baseAccessor);
}

/**
 * Create a change set runner.
 */
export function changeSet(): TxnRunner<ChangeSet> {
  return new TxnRunnerImpl({
    getTransactable: getCsBuilder,
    getTxn: getChangeSet,
    withTxn: withChangeSet,
  });
}

/**
 * Create a a generic transaction change set
 * runner. Requires that context getters and setters
 * were themselves already added to the context
 * with {@link withTxnAccessor}.
 */
export function txnChangeSet(ctx: IContext): TxnRunner<TxnChangeSet<Txn>>;

/**
 * Create a {@link TxnChangeSet} runner for a particular
 * transaction type. Requires context getters
 * for the transaction type itself as well as
 * for an interface that can start the transaction,
 * and a context setter for the transaction type.
 */
export function txnChangeSet<T extends Txn>(
  accessor: TxnAccessor<T>
): TxnRunner<TxnChangeSet<T>>;

export function txnChangeSet<T extends Txn>(
  ctxOrAccessor: IContext | TxnAccessor<T>
): TxnRunner<TxnChangeSet<T>> | TxnRunner<TxnChangeSet<Txn>> {
  if ('getTxn' in ctxOrAccessor) {
    return new TxnRunnerImpl(makeTxnCsAccessor(ctxOrAccessor));
  }

  const baseAccessor = getTxnAccessor(ctxOrAccessor);
  if (baseAccessor == null) {
    throw new Error('No transaction accessors defined on context');
  }
  return new TxnRunnerImpl(makeTxnCsAccessor(baseAccessor));
}

function isTransactable<T extends Txn>(
  x: T | Transactable<T>
): x is Transactable<T> {
  if ('beginTxn' in x) {
    return true;
  }
  return false;
}

class TxnRunnerImpl<T extends Txn> implements TxnRunner<T> {
  readonly #getTransactable: ContextGetter<Transactable<T>>;
  readonly #getTxn: ContextGetter<T>;
  readonly #withTxn: ContextSetter<T>;

  constructor(accessor: TxnAccessor<T>) {
    this.#getTransactable = accessor.getTransactable;
    this.#getTxn = accessor.getTxn;
    this.#withTxn = accessor.withTxn;
  }

  run(
    ctx: IContext,
    fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown
  ): Promise<void>;
  run(
    ctx: IContext,
    opts: TxnOptions,
    fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown
  ): Promise<void>;
  async run(
    ctx: IContext,
    fnOrOpts: TxnOptions | TxnCallback<T>,
    maybeFn?: TxnCallback<T>
  ): Promise<void> {
    // Resolve the overloaded arguments
    let fn: TxnCallback<T>;
    let opts: TxnOptions | undefined;

    if (typeof fnOrOpts === 'function') {
      fn = fnOrOpts;
      opts = undefined;
    } else {
      fn = <TxnCallback<T>>maybeFn;
      opts = fnOrOpts;
    }

    // Get the transactable from the context. Usually
    // a database pool or connection
    let txnSrc = this.#getTransactable(ctx);
    if (txnSrc == null) {
      throw new Error('No transactable source present on context');
    }

    if (fn == null) {
      throw new Error('Missing callback function');
    }

    // Check for an existing transaction
    const existingTxn = this.#getTxn(ctx);
    if (existingTxn != null) {
      if (isTransactable(existingTxn)) {
        // Existing transaction supports nested transactions.
        txnSrc = existingTxn;
      } else {
        throw new Error(
          'There is already an open transaction, and it does not support nested transactions'
        );
      }
    }

    const txn = await txnSrc.beginTxn(ctx, opts);
    const txnContext = this.#withTxn(ctx, txn);
    try {
      await fn(txnContext, txn);
      await txn.commit();
    } catch (e) {
      await txn.rollback();
      let errSuffix = '';
      if (e != null) {
        errSuffix = ': ' + String(e);
      }
      throw new Error(`Transaction failed${errSuffix}`, {
        cause: e instanceof Error ? e : undefined,
      });
    }
  }

  in(
    ctx: IContext,
    fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown
  ): Promise<void>;
  in(
    ctx: IContext,
    opts: TxnOptions,
    fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown
  ): Promise<void>;
  async in(
    ctx: IContext,
    fnOrOpts: TxnOptions | TxnCallback<T>,
    maybeFn?: TxnCallback<T>
  ): Promise<void> {
    // Resolve the overloaded arguments
    let fn: TxnCallback<T>;
    let opts: TxnOptions | undefined;

    if (typeof fnOrOpts === 'function') {
      fn = fnOrOpts;
      opts = undefined;
    } else {
      fn = <TxnCallback<T>>maybeFn;
      opts = fnOrOpts;
    }

    // Look for an existing transaction
    const existingTxn = this.#getTxn(ctx);
    if (existingTxn != null) {
      // Already an existing transaction. Run the callback
      // using provided context and existing transaction
      await fn(ctx, existingTxn);
      return;
    }

    if (opts == undefined) {
      return this.run(ctx, fn);
    } else {
      return this.run(ctx, opts, fn);
    }
  }
}

class ChangeSetImpl implements ChangeSet {
  protected readonly commitFns: CtxCallback[] = [];
  protected readonly rollbackFns: CtxCallback[] = [];
  protected readonly ctx: IContext;

  protected done = false;
  protected ignoreStatus = false;

  constructor(ctx: IContext) {
    this.ctx = ctx;
  }

  protected checkStatus() {
    if (this.done) {
      throw new Error('Change set is already committed or rolled back');
    }
  }

  defer(fn: (ctx: IContext) => Promise<unknown> | unknown): void {
    this.checkStatus();
    this.commitFns.push(fn);
  }

  deferFail(fn: (ctx: IContext) => Promise<unknown> | unknown): void {
    this.checkStatus();
    this.rollbackFns.push(fn);
  }

  async commit(): Promise<void> {
    this.checkStatus();
    this.done = true;
    const ctx = this.ctx;
    let ok = false;
    try {
      for (const fn of this.commitFns) {
        await fn(ctx);
      }
      ok = true;
    } finally {
      this.ignoreStatus = !ok;
    }
  }

  async rollback(): Promise<void> {
    if (this.ignoreStatus) {
      // rollback is being called after commit() failed
      this.ignoreStatus = false;
    } else {
      this.checkStatus();
    }
    this.done = true;
    const ctx = this.ctx;
    for (const fn of this.rollbackFns) {
      await fn(ctx);
    }
  }
}

class TxnChangeSetImpl<T extends Txn>
  extends ChangeSetImpl
  implements TxnChangeSet<T>
{
  readonly #commitTxn: TxnCallback<T>[] = [];
  readonly #txnRunner: TxnRunner<T>;

  constructor(ctx: IContext, txnRunner: TxnRunner<T>) {
    super(ctx);
    this.#txnRunner = txnRunner;
  }

  deferTxn(fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown): void {
    this.#commitTxn.push(fn);
  }

  async commit(): Promise<void> {
    this.checkStatus();
    this.done = true;
    let ok = false;
    const ctx = this.ctx;

    if (this.#commitTxn.length > 0) {
      try {
        await this.#txnRunner.run(ctx, async (txCtx, txn) => {
          for (const fn of this.#commitTxn) {
            await fn(txCtx, txn);
          }
        });
        ok = true;
      } finally {
        this.ignoreStatus = !ok;
      }
    }

    ok = false;
    try {
      for (const fn of this.commitFns) {
        await fn(ctx);
      }
      ok = true;
    } finally {
      this.ignoreStatus = !ok;
    }
  }
}
