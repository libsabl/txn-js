// Copyright 2022 Joshua Honig. All rights reserved.
// Use of this source code is governed by a MIT
// license that can be found in the LICENSE file.

import { ChangeSet, changeSet, Txn } from '$';
import { Context, IContext } from '@sabl/context';

type RunCallback<T extends Txn> = (
  ctx: IContext,
  fn: (ctx: IContext, txn: T) => void | Promise<void>
) => Promise<void>;

function changeSetTests(fnRunTxn: RunCallback<ChangeSet>): void {
  it('defers actions until commit', async () => {
    const stack: string[] = [];

    await fnRunTxn(Context.background, (_, cs) => {
      cs.defer(() => stack.push('a'));
      cs.defer(() => stack.push('b'));
      cs.defer(() => stack.push('c'));

      // Changes not yet committed
      expect(stack).toEqual([]);
    });

    // Now changes are committed
    expect(stack).toEqual(['a', 'b', 'c']);
  });

  it('does not execute any if rolled back', async () => {
    const stack: string[] = [];
    const failMsgs: string[] = [];

    await expect(() =>
      fnRunTxn(Context.background, (_, cs) => {
        cs.defer(() => stack.push('a'));
        cs.defer(() => stack.push('b'));
        cs.defer(() => stack.push('c'));

        cs.deferFail(() => failMsgs.push('failed1'));
        cs.deferFail(() => failMsgs.push('failed2'));

        // Changes not yet committed
        expect(stack).toEqual([]);

        throw new Error('Rolling back on purpose');
      })
    ).rejects.toThrow('Rolling back on purpose');

    // No defer callbacks were run
    expect(stack).toEqual([]);

    // deferFail callbacks were run
    expect(failMsgs).toEqual(['failed1', 'failed2']);
  });

  it('runs deferFail callbacks', async () => {
    const stack: string[] = [];
    const msgStack: string[] = [];

    await expect(() =>
      fnRunTxn(Context.background, (_, cs) => {
        cs.defer(() => {
          stack.push('a');
          msgStack.push('Pushed a');
        });
        cs.deferFail(() => {
          stack.splice(stack.indexOf('a'), 1);
          msgStack.push('Spliced out a');
        });

        cs.defer(() => {
          stack.push('b');
          msgStack.push('Pushed b');
        });
        cs.deferFail(() => {
          stack.splice(stack.indexOf('b'), 1);
          msgStack.push('Spliced out b');
        });

        cs.defer(() => {
          throw new Error('Rolling back on purpose');
        });

        cs.defer(() => {
          stack.push('c');
          msgStack.push('Pushed c');
        });
        cs.deferFail(() => {
          stack.splice(stack.indexOf('c'), 1);
          msgStack.push('Spliced out c');
        });

        // Changes not yet committed
        expect(stack).toEqual([]);
      })
    ).rejects.toThrow('Rolling back on purpose');

    // Net effect is nothing on stack
    expect(stack).toEqual([]);

    // But we have evidence of what actually happened
    expect(msgStack).toEqual([
      'Pushed a',
      'Pushed b',
      'Spliced out a',
      'Spliced out b',
      'Spliced out c',
    ]);
  });

  it('rejects attempts to commit or rollback multiple times', async () => {
    const stack: string[] = [];

    await expect(() =>
      fnRunTxn(Context.background, async (ctx, cs) => {
        cs.defer(() => {
          stack.push('a');
        });
        cs.deferFail(() => {
          stack.splice(stack.indexOf('a'), 1);
        });

        cs.defer(() => {
          stack.push('b');
        });
        cs.deferFail(() => {
          stack.splice(stack.indexOf('b'), 1);
        });

        cs.defer(() => {
          stack.push('c');
        });
        cs.deferFail(() => {
          stack.splice(stack.indexOf('c'), 1);
        });

        await cs.commit();

        // Changes committed now
        expect(stack).toEqual(['a', 'b', 'c']);
      })
    ).rejects.toThrow('Change set is already committed or rolled back');

    // Changes really were committed: Error was in calling commit twice
    expect(stack).toEqual(['a', 'b', 'c']);
  });

  it('provides context to defer callbacks', async () => {
    const stack: string[] = [];
    const ctx = Context.value('prefix', 'xyz: ');

    await fnRunTxn(ctx, (_, cs) => {
      cs.defer((ctx) => stack.push(ctx.value('prefix') + 'a'));
      cs.defer((ctx) => stack.push(ctx.value('prefix') + 'b'));
      cs.defer((ctx) => stack.push(ctx.value('prefix') + 'c'));

      // Changes not yet committed
      expect(stack).toEqual([]);
    });

    // Now changes are committed
    expect(stack).toEqual(['xyz: a', 'xyz: b', 'xyz: c']);
  });

  it('provides context to deferFail callbacks', async () => {
    const stack: string[] = [];
    const msgStack: string[] = [];

    function getStack(ctx: IContext): string[] {
      return <string[]>ctx.value('stack');
    }

    function getMsgs(ctx: IContext): string[] {
      return <string[]>ctx.value('msgstack');
    }

    const ctx = Context.value('stack', stack).withValue('msgstack', msgStack);

    await expect(() =>
      fnRunTxn(ctx, (_, cs) => {
        cs.defer((ctx) => {
          getStack(ctx).push('a');
          getMsgs(ctx).push('Pushed a');
        });
        cs.deferFail((ctx) => {
          getStack(ctx).splice(stack.indexOf('a'), 1);
          getMsgs(ctx).push('Spliced out a');
        });

        cs.defer((ctx) => {
          getStack(ctx).push('b');
          getMsgs(ctx).push('Pushed b');
        });
        cs.deferFail((ctx) => {
          getStack(ctx).splice(stack.indexOf('b'), 1);
          getMsgs(ctx).push('Spliced out b');
        });

        cs.defer(() => {
          throw new Error('Rolling back on purpose');
        });

        cs.defer((ctx) => {
          getStack(ctx).push('c');
          getMsgs(ctx).push('Pushed c');
        });
        cs.deferFail((ctx) => {
          getStack(ctx).splice(stack.indexOf('c'), 1);
          getMsgs(ctx).push('Spliced out c');
        });

        // Changes not yet committed
        expect(stack).toEqual([]);
      })
    ).rejects.toThrow('Rolling back on purpose');

    // Net effect is nothing on stack
    expect(stack).toEqual([]);

    // But we have evidence of what actually happened
    expect(msgStack).toEqual([
      'Pushed a',
      'Pushed b',
      'Spliced out a',
      'Spliced out b',
      'Spliced out c',
    ]);
  });
}

describe('changeSet', () => {
  const csRunner = changeSet();

  describe('run', () => {
    changeSetTests(csRunner.run.bind(csRunner));

    it('rejects nested transaction', async () => {
      const stack: string[] = ['a', 'b'];
      const ctxRoot = Context.background;

      await expect(() =>
        csRunner.run(ctxRoot, async (ctxOuter, csOuter) => {
          csOuter.defer(() => stack.push('c'));

          await csRunner.run(ctxOuter, async (ctxInner, csInner) => {
            csInner.defer(() => stack.push('c'));
          });
        })
      ).rejects.toThrow('does not support nested transactions');
    });
  });

  describe('in', () => {
    changeSetTests(csRunner.in.bind(csRunner));

    it('reuses existing changeSet', async () => {
      const stack: string[] = ['a', 'b'];
      const ctxRoot = Context.background;

      await csRunner.in(ctxRoot, async (ctxOuter, cs) => {
        await csRunner.in(ctxOuter, async (ctxInner, csInner) => {
          // Same context and txn
          expect(ctxInner).toBe(ctxOuter);
          expect(csInner).toBe(cs);

          csInner.defer(() => stack.push('c'));

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
});
