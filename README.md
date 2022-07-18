<!-- BEGIN:REMOVE_FOR_NPM -->
[![codecov](https://codecov.io/gh/libsabl/txn-js/branch/main/graph/badge.svg?token=TVL1XYSJHA)](https://app.codecov.io/gh/libsabl/txn-js/branch/main)
<span class="badge-npmversion"><a href="https://npmjs.org/package/@sabl/txn" title="View this project on NPM"><img src="https://img.shields.io/npm/v/@sabl/txn.svg" alt="NPM version" /></a></span>

<!-- END:REMOVE_FOR_NPM -->

# @sabl/txn

**txn** is a simple, [context](https://github.com/libsabl/patterns/blob/main/patterns/context.md)-aware pattern for describing transactions - batches of operations which should all succeed together or be rolled back. The pattern can be used to run actual storage system transactions, but it is also useful for running conceptual transactions purely in a client runtime, which avoid the blocking costs of native database transactions but still allow clean up of resources if a series of operations does not all succeed. 

Defining these interfaces and algorithms in the abstract allows authors to write effective business logic that includes transaction workflows, without depending on a specific storage type, let alone a specific proprietary driver. This is in turn allows concise and testable code while avoiding over-dependence on implementation details of underlying storage choices.
   
For more detail on the txn pattern, see sabl / [patterns](https://github.com/libsabl/patterns#patterns) / [txn](https://github.com/libsabl/patterns/blob/main/patterns/txn.md). 

<!-- BEGIN:REMOVE_FOR_NPM -->
> [**sabl**](https://github.com/libsabl/patterns) is an open-source project to identify, describe, and implement effective software patterns which solve small problems clearly, can be composed to solve big problems, and which work consistently across many programming languages.

## Developer orientation

See [SETUP.md](./docs/SETUP.md), [CONFIG.md](./docs/CONFIG.md).
<!-- END:REMOVE_FOR_NPM -->

## Concepts
  
This library contains interfaces, [context getters and setters](https://github.com/libsabl/patterns/blob/main/patterns/context.md#getter--setter-pattern), and several generic algorithms for running transactions. The APIs support situations where the underlying transaction type is known to the code initiating the transaction (say, a `MySQLTxn`), as well as patterns that allow transactions to be run even without the code initiating the transaction knowing the underlying type.

The `ChangeSet` type included in the library is an entirely client-side transaction, which simply accumulates a set of callbacks to execute on commit and/or on rollback. It can be combined with an underlying storage transaction with `TxnChangeSet`, illustrated below.

### `Txn` interface

A simple representation of a transaction which can be either committed or rolled back.

```ts
interface Txn {
  commit(ctx: IContext): Promise<void>;
  rollback(ctx: IContext): Promise<void>;
}
```

### `Transactable` interface

A transactable is any object that can start a transaction. Often this is a database pool or connection. If an underlying service supports nested transactions, the transactable could itself be a transaction.

```ts
export interface Transactable<T extends Txn> {
  beginTxn(ctx: IContext, opts?: TxnOptions): Promise<T>;
}
```

Transaction options mostly apply to common relational database patterns, and can always be omitted:

```ts
interface TxnOptions {
  readonly isolationLevel?: IsolationLevel;
  readonly readOnly?: boolean;
}
 
enum IsolationLevel {
  default = 1,
  readUncommitted = 2,
  readCommitted = 3,
  writeCommitted = 4,
  repeatableRead = 5,
  snapshot = 6,
  serializable = 7,
  linearizable = 8,
}
```

### `ChangeSet`

A ChangeSet is an in-memory transaction which simply accumulates a list of callbacks to invoke either on commit or rollback. 

```ts
interface ChangeSet extends Txn {
  defer(fn: (ctx: IContext) => Promise<void>): void;
  deferFail(fn: (ctx: IContext) => Promise<void>): void;
  commit(ctx: IContext): Promise<void>;
  rollback(ctx: IContext): Promise<void>;
}
```

All callbacks registered with `defer` are executed in order when `commit` is called. If any of them fail, or if `rollback` is called explicitly, then all the callbacks registered with `deferFail` are executed in order.

### `TxnChangeSet`

A TxnChangeSet combines both the in-memory ChangeSet and an underlying transaction, usually in a database.
 
```ts
 interface TxnChangeSet<T extends Txn> extends ChangeSet {
  deferTxn(fn: (ctx: IContext, txn: T) => Promise<void>): void;
  defer(fn: (ctx: IContext) => Promise<void>): void;
  deferFail(fn: (ctx: IContext) => Promise<void>): void;
  commit(ctx: IContext): Promise<void>;
  rollback(ctx: IContext): Promise<void>;
}
```

Callbacks registered with `deferTxn` will be run in a single underlying transaction. Callbacks registered with the base `defer` will be run only after the transaction, if needed, has successfully committed. Callbacks registered with `deferFail` are run if there are any errors in either the transaction or non-transaction callbacks, if committing the underlying transaction fails, or if `rollback` is called explicitly.

## Context

The `Txn` and `Transactable` types are abstract. To be useful as wrappers for actual storage transactions, authors must implement a handful of wrappers:

- Implementations of `Txn` which wrap some platform-specific transaction API
- Implementations of `Transactable` which wrap some platform-specific connection and/or pool API
- A context getter and setter for their Transactable type
- A context getter and setter for their Txn type

### Example - MySQL

As an example, here is a summarized implementation for MySQL which wraps the [`mysql2/promise`](https://www.npmjs.com/package/mysql2#using-promise-wrapper) APIs:

```ts
import { IContext } from '@sabl/txn';
import { Txn, TxnOptions, Transactable } from '@sabl/txn';
import { Connection } from 'mysql2/promise';

interface MySQLApi {
  execute(...);
  query(...);
}

class MySQLTxn implements Txn, MySQLApi {
  constructor(readonly con: Connection) {}
  begin(ctx: IContext, opts?: TxnOptions) {
    return this.con.execute('START TRANSACTION');
  }
  async commit(ctx: IContext): Promise<void> {
    await this.con.execute('COMMIT');
  }
  async rollback(ctx: IContext): Promise<void>{
    await this.con.execute('ROLLBACK');
  }
  execute(...) { return this.con.execute(...) }
  query(...) { return this.con.query(...) } 
}

class MySQLCon implements Transactable<MySQLTxn>, MySQLApi {
  constructor(readonly con: Connection) {}
  async beginTxn(ctx: IContext, opts?: TxnOptions): Promise<MySQLTxn> {
    const txn = new MySQLTxn(this.con);
    await txn.begin(ctx, otps);
    return txn;
  }
  execute(...) { return this.con.execute(...) }
  query(...) { return this.con.query(...) } 
}
```

All we need to use this with the transaction running API in this library are a few context getters and setters:

```ts
import { IContext, Context, Maybe, withValue } from '@sabl/txn';

const ctxKeyMySQLCon = Symbol('MySQLCon');
const ctxKeyMySQLTxn = Symbol('MySQLTxn');

function withMySQLCon(ctx: IContext, con: MySQLCon): Context {
  return withValue(ctx, ctxKeyMySQLCon, con);
}
function getMySQLCon(ctx: IContext): Maybe<MySQLCon> {
  return <Maybe<MySQLCon>>ctx.value(ctxKeyMySQLCon);
}
function withMySQLTxn(ctx: IContext, con: MySQLTxn): Context {
  return withValue(ctx, ctxKeyMySQLTxn, con);
}
function getMySQLTxn(ctx: IContext): Maybe<MySQLTxn> {
  return <Maybe<MySQLTxn>>ctx.value(ctxKeyMySQLTxn);
}

// Get either Con or Txn to run queries
function getMySQLApi(ctx: IContext): Maybe<MySQLApi> {
  return getMySQLTxn(ctx) || getMySQLCon(ctx);
}
```

We can now run transactions where we know we're working with MySQL:

```ts
import { txn } from '@sabl/txn';

const con = getMySQLConnection();
const ctx = Context.value(withMySQLCon, con);

await txn({
  getTransactable: getMySQLCon,
  getTxn: getMySQLTxn,
  withTxn: withMySQLTxn
}).run(ctx, async (ctx, txn) => {
  await txn.execute('insert x into y')
  await txn.execute('delete from w from z = 1')
})
```

Alternatively, we can register the transaction accessors on the context itself and allow downstream code to run transactions without knowing or caring about what kind of database it is:

**server.ts**
```ts
import { withTxnAccessor } from '@sabl/txn';

const con = getMySQLConnection();
const ctx = Context.background.
  withValue(withMySQLCon, con).
  withValue(withTxnAccessor, {
    getTransactable: getMySQLCon,
    getTxn: getMySQLTxn,
    withTxn: withMySQLTxn
  })
;

// ... inject ctx into all requests ...
```

**ecommerce-service.ts**
```ts
import { txn } from '@sabl/txn';

export async function buySomething(ctx: IContext, ...) {
  const [ repo, taxSvc ] = Context.as(ctx).require(
    getRepo,
    getTaxSvc
  );

  // Uses getMySQLCon, getMySQLTxn, withMySQLTxn registered upstream
  await txn(ctx).run(ctx, async (ctx) => {
    const invoice = await repo.createInvoice(ctx, ...);
    const invoiceLine = await repo.createInvoiceLine(ctx, invoice, ...);
    const taxItem = await taxSvc.addTaxes(ctx, invoice);
  })
}
```