// Copyright 2022 Joshua Honig. All rights reserved.
// Use of this source code is governed by a MIT
// license that can be found in the LICENSE file.

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  Txn,
  txn,
  TxnCallback,
  TxnOptions,
  TxnRunner,
  withTxnAccessor,
} from '$';
import { Context, IContext } from '@sabl/context';
import {
  openStackPool,
  StackCtxAccessor,
  StackTxn,
  withStackConn,
} from './fixtures';

type RunCallback<T extends Txn> = (
  ctx: IContext,
  fn: (ctx: IContext, txn: T) => Promise<void>
) => Promise<void>;

function testRunTxn(fnRunTxn: RunCallback<StackTxn>): void {
  it('runs operations inside a transaction', async () => {
    const stack: unknown[] = [];
    stack.push('a', 'b');

    const pool = openStackPool(stack);
    const ctxRoot = Context.value(withStackConn, pool);

    await fnRunTxn(ctxRoot, async (ctx, txn) => {
      await txn.push(ctx, 'c');

      // Not yet committed
      expect(stack).toEqual(['a', 'b']);
    });

    // Automatically committed
    expect(stack).toEqual(['a', 'b', 'c']);
  });

  it('handles throw non-error', async () => {
    const pool = openStackPool([]);
    const ctxRoot = Context.value(withStackConn, pool);

    // Actual error thrown is provided in cause
    let err: Error | null = null;
    const innerError = new Error('I am a real error');
    try {
      await fnRunTxn(ctxRoot, () => {
        throw innerError;
      });
    } catch (e) {
      err = <Error>e;
    }
    expect(err!.cause).toBe(innerError);
    expect(err?.message).toEqual(
      'Transaction failed: Error: I am a real error'
    );

    // Non-error is stringified
    await expect(() =>
      fnRunTxn(ctxRoot, () => {
        throw 'Not an error object';
      })
    ).rejects.toThrow('Transaction failed: Not an error object');

    // Null is ignored
    await expect(() =>
      fnRunTxn(ctxRoot, () => {
        throw null;
      })
    ).rejects.toThrow('Transaction failed');
  });

  it('uses provided options', async () => {
    const stack: unknown[] = [];
    stack.push('a', 'b');

    const pool = openStackPool(stack);
    const ctxRoot = Context.value(withStackConn, pool);

    const runWithOpts = <
      (
        ctx: IContext,
        opts: TxnOptions,
        cb: TxnCallback<StackTxn>
      ) => Promise<void>
    >(<unknown>fnRunTxn);

    await expect(() =>
      runWithOpts(ctxRoot, { readOnly: true }, async (ctx, txn) => {
        await txn.push(ctx, 'c');

        // Not yet committed
        expect(stack).toEqual(['a', 'b']);
      })
    ).rejects.toThrow('Transaction is read-only');

    // Not committed
    expect(stack).toEqual(['a', 'b']);
  });

  it('rolls back on error', async () => {
    const stack: unknown[] = [];
    stack.push('a', 'b');

    const pool = openStackPool(stack);
    const ctxRoot = Context.value(withStackConn, pool);

    await expect(async () =>
      fnRunTxn(ctxRoot, async (ctx, txn) => {
        await txn.push(ctx, 'c');

        // Within txn, tail is 'c'
        const val = await txn.peek(ctx);
        expect(val).toBe('c');

        throw new Error('Failing on purpose');
      })
    ).rejects.toThrow();

    // Changes were not committed
    expect(stack).toEqual(['a', 'b']);
  });

  it('throws if there is no storage api', async () => {
    const ctxRoot = Context.background;

    await expect(() =>
      fnRunTxn(ctxRoot, () => Promise.resolve())
    ).rejects.toThrow('No transactable source present on context');
  });

  it('throws if no callback', async () => {
    const stack: unknown[] = [];
    stack.push('a', 'b');

    const pool = openStackPool(stack);
    const ctxRoot = Context.value(withStackConn, pool);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await expect(() => fnRunTxn(ctxRoot, null!)).rejects.toThrow(
      'Missing callback function'
    );
  });
}

function testTxnModes(txnRunner: TxnRunner<StackTxn>): void {
  describe('run', () => {
    testRunTxn(txnRunner.run.bind(txnRunner));

    it('rejects nested transaction', async () => {
      const stack: unknown[] = [];
      stack.push('a', 'b');

      const pool = openStackPool(stack);
      const ctxRoot = Context.value(withStackConn, pool);

      await expect(() =>
        txnRunner.run(ctxRoot, async (ctxOuter, txnOuter) => {
          await txnOuter.push(ctxOuter, 'c');

          await txnRunner.run(ctxOuter, async (ctxInner, txnInner) => {
            await txnInner.push(ctxInner, 'd');
          });
        })
      ).rejects.toThrow('does not support nested transactions');
    });

    it('supports nested transaction', async () => {
      const stack: unknown[] = [];
      stack.push('a', 'b');

      const pool = openStackPool(stack, { nestedTxn: true });
      const ctxRoot = Context.value(withStackConn, pool);

      await txnRunner.run(ctxRoot, async (ctxOuter, txnOuter) => {
        await txnOuter.push(ctxOuter, 'c');

        await txnRunner.run(ctxOuter, async (ctxInner, txnInner) => {
          await txnInner.push(ctxInner, 'd');

          // Last item is visible within inner transaction
          const last = await txnInner.peek(ctxInner);
          expect(last).toBe('d');

          // Within outer transaction last item is still 'c'
          const lastOuter = await txnOuter.peek(ctxOuter);
          expect(lastOuter).toBe('c');

          // Within base transaction last item is still 'b'
          const lastBase = await pool.peek(ctxOuter);
          expect(lastBase).toBe('b');
        });

        // Now inner is committed to outer:
        // Within outer transaction last item is now 'd'
        const lastOuter = await txnOuter.peek(ctxOuter);
        expect(lastOuter).toBe('d');

        // Within base transaction last item is still 'b'
        const lastBase = await pool.peek(ctxOuter);
        expect(lastBase).toBe('b');
      });

      // Now both are committed
      expect(stack).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('in', () => {
    testRunTxn(txnRunner.in.bind(txnRunner));

    it('reuses existing transaction', async () => {
      const stack: unknown[] = [];
      stack.push('a', 'b');

      const pool = openStackPool(stack);
      const ctxRoot = Context.value(withStackConn, pool);

      await txnRunner.in(ctxRoot, async (ctxOuter, txn) => {
        await txnRunner.in(ctxOuter, async (ctxInner, txnInner) => {
          // Same context and txn
          expect(ctxInner).toBe(ctxOuter);
          expect(txnInner).toBe(txn);

          await txnInner.push(ctxOuter, 'c');

          // Not yet committed
          expect(stack).toEqual(['a', 'b']);
        });

        // Still not committed
        expect(stack).toEqual(['a', 'b']);
      });

      // Automatically committed
      expect(stack).toEqual(['a', 'b', 'c']);
    });
  });
}

describe('explicit accessor', () => {
  testTxnModes(txn(StackCtxAccessor));
});

describe('context accessor', () => {
  const rootCtx = Context.value(withTxnAccessor, StackCtxAccessor);

  testTxnModes(<TxnRunner<StackTxn>>txn(rootCtx));

  it('throws if no accessor on context', () => {
    expect(() => txn(Context.background)).toThrow('No transaction accessors');
  });
});
