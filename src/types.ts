// Copyright 2022 Joshua Honig. All rights reserved.
// Use of this source code is governed by a MIT
// license that can be found in the LICENSE file.

import { ContextGetter, ContextSetter, IContext } from '@sabl/context';

/**
 * Various isolation levels that storage drivers may support in beginTxn.
 * If a driver does not support a given isolation level an error may be returned.
 */
export enum IsolationLevel {
  default = 1,
  readUncommitted = 2,
  readCommitted = 3,
  writeCommitted = 4,
  repeatableRead = 5,
  snapshot = 6,
  serializable = 7,
  linearizable = 8,
}

/** Options to be used in beginTxn */
export interface TxnOptions {
  readonly isolationLevel?: IsolationLevel;
  readonly readOnly?: boolean;
}

/** An abstract transaction that can be committed or rolled back */
export interface Txn {
  /** Commit all pending operations */
  commit(ctx: IContext): Promise<void>;

  /** Rollback all pending operations. */
  rollback(ctx: IContext): Promise<void>;
}

/** An interface that can start a transaction of a given type */
export interface Transactable<T extends Txn> {
  beginTxn(ctx: IContext, opts?: TxnOptions): Promise<T>;
}

/** A simple asynchronous callback which accepts a context */
export type CtxCallback = (ctx: IContext) => Promise<unknown> | unknown;

/** An asynchronous callback which accepts a context and a transaction */
export type TxnCallback<T extends Txn> = (
  ctx: IContext,
  txn: T
) => Promise<unknown> | unknown;

/**
 * A bundle of context getters and setters
 * that facilitates running transactions
 * of a given type.
 */
export interface TxnAccessor<T extends Txn> {
  getTransactable: ContextGetter<Transactable<T>>;
  getTxn: ContextGetter<T>;
  withTxn: ContextSetter<T>;
}

/** Abstract transaction runner */
export interface TxnRunner<T extends Txn> {
  /**
   * Run a callback in a new transaction. If the callback
   * succeeds, commit the transaction. If it fails,
   * rollback the transaction. This method will fail
   * if there is already a transaction on the context
   * and it does not support nested transactions.
   */
  run(
    ctx: IContext,
    fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown
  ): Promise<void>;
  run(
    ctx: IContext,
    opts: TxnOptions,
    fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown
  ): Promise<void>;

  /**
   * Run a callback in a transaction. If there is
   * already a transaction in `ctx`, use it. If not,
   * run and complete a new transaction as in `run()`.
   */
  in(
    ctx: IContext,
    fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown
  ): Promise<void>;
  in(
    ctx: IContext,
    opts: TxnOptions,
    fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown
  ): Promise<void>;
}

/**
 * A change set is a client-side transaction which
 * supports scheduling callbacks to be executed in
 * series. When the change set is committed, all
 * the deferred callbacks are executed in series.
 * If any of them rejects, then any failure callbacks
 * scheduled with `deferFail` are executed.
 */
export interface ChangeSet extends Txn {
  /** Defer a callback be executed on commit. */
  defer(fn: (ctx: IContext) => Promise<unknown> | unknown): void;

  /** Defer a callback to be executed on rollback. */
  deferFail(fn: (ctx: IContext) => Promise<unknown> | unknown): void;

  /** Execute the deferred callbacks */
  commit(ctx: IContext): Promise<void>;

  /** Cancel execution of any further `defer` callbacks
   * and executed any scheduled `deferFail` callbacks. */
  rollback(ctx: IContext): Promise<void>;
}

/**
 * A {@link ChangeSet} that can also schedule callbacks
 * to be executed within a true underlying transaction.
 * When the changeset is committed, first the a transaction
 * is opened and all transaction callbacks are executed.
 * Any non-transaction callbacks registered with `defer`
 * are executed after the transactions is successfully
 * committed.
 *
 * The `deferFail` callbacks are invoked if the
 * transaction fails and is rolled back, or if
 * any of the non-transaction callbacks rejects.
 */
export interface TxnChangeSet<T extends Txn> extends ChangeSet {
  /** Defer a callback be executed within an underlying transaction. */
  deferTxn(fn: (ctx: IContext, txn: T) => Promise<unknown> | unknown): void;
}
