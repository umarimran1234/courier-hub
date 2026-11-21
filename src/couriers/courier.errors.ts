import { Courier } from '@prisma/client';

export class CourierError extends Error {
  constructor(
    public readonly courier: Courier | string,
    message: string,
    public readonly opts: { retriable?: boolean; httpStatus?: number; raw?: unknown } = {},
  ) {
    super(`[${courier}] ${message}`);
    this.name = 'CourierError';
  }
  get retriable() {
    return !!this.opts.retriable;
  }
}

export class NotSupportedError extends CourierError {
  constructor(courier: Courier | string, feature: string) {
    super(courier, `${feature} is not supported for this courier`, { retriable: false });
    this.name = 'NotSupportedError';
  }
}
