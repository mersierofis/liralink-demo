import { Injectable } from '@nestjs/common';

export type ListenerStatus = 'running' | 'stopped';

// A tiny shared flag the PaymentListener (built in a later step) flips on connect/disconnect,
// so /health can report listener state without HealthController depending on the listener module.
@Injectable()
export class ListenerStatusService {
  private status: ListenerStatus = 'stopped';

  set(status: ListenerStatus): void {
    this.status = status;
  }

  get(): ListenerStatus {
    return this.status;
  }
}
