// Copyright 2022 Joshua Honig. All rights reserved.
// Use of this source code is governed by a MIT
// license that can be found in the LICENSE file.

import { IsolationLevel } from '$/types';

describe('IsolationLevel', () => {
  it('defines isolation levels', () => {
    expect(IsolationLevel.default).toBe(1);
    expect(IsolationLevel.readUncommitted).toBe(2);
    expect(IsolationLevel.readCommitted).toBe(3);
    expect(IsolationLevel.writeCommitted).toBe(4);
    expect(IsolationLevel.repeatableRead).toBe(5);
    expect(IsolationLevel.snapshot).toBe(6);
    expect(IsolationLevel.serializable).toBe(7);
    expect(IsolationLevel.linearizable).toBe(8);
  });
});
