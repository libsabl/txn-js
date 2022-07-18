// Copyright 2022 Joshua Honig. All rights reserved.
// Use of this source code is governed by a MIT
// license that can be found in the LICENSE file.

/* eslint-disable @typescript-eslint/no-non-null-assertion */

export function hasFlag<T extends number>(flags: T, flag: T): boolean {
  return (flags & flag) === flag;
}

export type FnReject = (reason: unknown) => void;
export type FnResolve<T> = (value: T | PromiseLike<T>) => void;

export class PromiseHandle<T> {
  constructor();
  constructor(p: Promise<T>, rslv: FnResolve<T>, rjct: FnReject);
  constructor(p?: Promise<T>, rslv?: FnResolve<T>, rjct?: FnReject) {
    if (p != null) {
      this.#promise = p;
      this.#reject = rjct!;
      this.#resolve = rslv!;
      return;
    }

    let res: FnResolve<T>;
    let rej: FnReject;

    this.#promise = new Promise<T>((resolve, reject) => {
      res = resolve;
      rej = reject;
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.#resolve = res!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.#reject = rej!;
  }

  readonly #resolve: FnResolve<T>;
  resolve(value: T | PromiseLike<T>): void {
    return this.#resolve(value);
  }

  readonly #reject: FnReject;
  reject(reason?: unknown): void {
    return this.#reject(reason);
  }

  readonly #promise: Promise<T>;
  get promise(): Promise<T> {
    return this.#promise;
  }
}
