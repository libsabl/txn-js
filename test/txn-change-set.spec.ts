// Copyright 2022 Joshua Honig. All rights reserved.
// Use of this source code is governed by a MIT
// license that can be found in the LICENSE file.

import { txnChangeSet, withTxnAccessor } from '$';
import { Context } from '@sabl/context';
import { openStackPool, StackCtxAccessor, withStackConn } from './fixtures';

describe('txnChangeSet', () => {
  const txnCsRunner = txnChangeSet(StackCtxAccessor);

  describe('commit', () => {
    it('commits both txn and non-txn callbacks', async () => {
      const stack: unknown[] = ['a', 'b'];
      const pool = openStackPool(stack);
      const ctxRoot = Context.value(withStackConn, pool);

      const msgLog: string[] = [];
      const errLog: string[] = [];

      await txnCsRunner.run(ctxRoot, (ctx, cs) => {
        cs.deferTxn(async (ctx, txn) => {
          await txn.push(ctx, 'c');
        });

        cs.defer(() => msgLog.push('Pushed c!'));

        cs.deferFail(() => errLog.push('Called error callback'));

        // No callbacks executed yet
        expect(stack).toEqual(['a', 'b']);
        expect(msgLog).toEqual([]);
        expect(errLog).toEqual([]);
      });

      // Txn was committed:
      expect(stack).toEqual(['a', 'b', 'c']);

      // Non-txn callback was invoked:
      expect(msgLog).toEqual(['Pushed c!']);

      // Error callback was NOT invoked:
      expect(errLog).toEqual([]);
    });

    it('does not open a transaction if no txn callbacks', async () => {
      const stack: unknown[] = ['a', 'b'];
      const pool = openStackPool(stack);
      const ctxRoot = Context.value(withStackConn, pool);

      const msgLog: string[] = [];
      const errLog: string[] = [];

      // Booby-trap the beginTxn method!
      pool.beginTxn = function () {
        throw new Error('No transactions for you!');
      };

      await expect(() => pool.beginTxn(ctxRoot)).toThrow(
        'No transactions for you!'
      );

      await txnCsRunner.run(ctxRoot, (ctx, cs) => {
        cs.defer((ctx) => pool.push(ctx, 'c'));

        cs.defer(() => msgLog.push('Pushed c!'));

        cs.deferFail(() => errLog.push('Called error callback'));

        // No callbacks executed yet
        expect(stack).toEqual(['a', 'b']);
        expect(msgLog).toEqual([]);
        expect(errLog).toEqual([]);
      });

      // pool.push callback was run:
      expect(stack).toEqual(['a', 'b', 'c']);

      // Non-txn callback was invoked:
      expect(msgLog).toEqual(['Pushed c!']);

      // Error callback was NOT invoked:
      expect(errLog).toEqual([]);
    });
  });

  describe('rollback', () => {
    it('within txn rolls back underlying transaction', async () => {
      const stack: unknown[] = ['a', 'b'];
      const pool = openStackPool(stack);
      const ctxRoot = Context.value(withStackConn, pool);

      const msgLog: string[] = [];
      const errLog: string[] = [];

      await expect(
        txnCsRunner.run(ctxRoot, (_, cs) => {
          cs.deferTxn(async (ctx, txn) => {
            await txn.push(ctx, 'c');

            const v = await txn.peek(ctx);
            expect(v).toBe('c');
          });

          cs.deferTxn(() => {
            throw new Error('Failing on purpose');
          });

          cs.defer(() => msgLog.push('Pushed c!'));

          cs.deferFail(() => errLog.push('Called error callback'));

          // No callbacks executed yet
          expect(stack).toEqual(['a', 'b']);
          expect(msgLog).toEqual([]);
          expect(errLog).toEqual([]);
        })
      ).rejects.toThrow('Failing on purpose');

      // Txn was NOT committed:
      expect(stack).toEqual(['a', 'b']);

      // Non-txn callback was NOT invoked:
      expect(msgLog).toEqual([]);

      // Error callback WAS invoked:
      expect(errLog).toEqual(['Called error callback']);
    });

    it('after txn cannot roll back txn', async () => {
      const stack: unknown[] = ['a', 'b'];
      const pool = openStackPool(stack);
      const ctxRoot = Context.value(withStackConn, pool);

      const msgLog: string[] = [];
      const errLog: string[] = [];

      await expect(
        txnCsRunner.run(ctxRoot, (_, cs) => {
          cs.deferTxn(async (ctx, txn) => {
            await txn.push(ctx, 'c');

            const v = await txn.peek(ctx);
            expect(v).toBe('c');
          });

          cs.defer(() => {
            throw new Error('Failing on purpose');
          });

          cs.defer(() => msgLog.push('Pushed c!'));

          cs.deferFail(() => errLog.push('Called error callback'));

          // No callbacks executed yet
          expect(stack).toEqual(['a', 'b']);
          expect(msgLog).toEqual([]);
          expect(errLog).toEqual([]);
        })
      ).rejects.toThrow('Failing on purpose');

      // Txn WAS committed:
      expect(stack).toEqual(['a', 'b', 'c']);

      // Second non-txn callback was NOT invoked:
      expect(msgLog).toEqual([]);

      // Error callback WAS invoked:
      expect(errLog).toEqual(['Called error callback']);
    });
  });

  describe('context accessors', () => {
    it('gets accessors from context', () => {
      const rootCtx = Context.value(withTxnAccessor, StackCtxAccessor);
      const runner = txnChangeSet(rootCtx);
      expect(runner.run).toBeInstanceOf(Function);
    });

    it('fails if no accessors set', () => {
      expect(() => txnChangeSet(Context.background)).toThrow(
        'No transaction accessors defined on context'
      );
    });
  });
});
