/** A `DnsPublisher` that records each call and writes nothing. */
import type {
  DnsPublisher,
  DnsRecord,
} from '../../../src/adapters/dns/contract.ts';

export interface FakeDnsPublisherOptions {
  /** When set, `publish` records the call and then throws this message. */
  publishThrows?: string;
  /** When set, `withdraw` records the call and then throws this message. */
  withdrawThrows?: string;
}

export interface RecordedPublish {
  readonly name: string;
  readonly record: DnsRecord;
}

export class FakeDnsPublisher implements DnsPublisher {
  readonly published: RecordedPublish[] = [];
  readonly withdrawn: string[] = [];

  constructor(private readonly options: FakeDnsPublisherOptions = {}) {}

  async publish(name: string, record: DnsRecord): Promise<void> {
    this.published.push({ name, record });
    if (this.options.publishThrows !== undefined) {
      throw new Error(this.options.publishThrows);
    }
  }

  async withdraw(name: string): Promise<void> {
    this.withdrawn.push(name);
    if (this.options.withdrawThrows !== undefined) {
      throw new Error(this.options.withdrawThrows);
    }
  }
}
