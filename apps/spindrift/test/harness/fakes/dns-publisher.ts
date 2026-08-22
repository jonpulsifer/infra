/**
 * A fake `DnsPublisher` (§9).
 *
 * `deploy-loop.ts`'s subject here is *when* it calls `publish`/`withdraw`,
 * never a backend's own write — the real seam that call reaches is
 * `ClusterDnsPublisher`, covered against a fake cluster in
 * `test/adapters/dns-cluster.test.ts`. This one only records.
 */
import type {
  DnsPublisher,
  DnsRecord,
} from '../../../src/adapters/dns/contract.ts';

export interface FakeDnsPublisherOptions {
  /** When set, `publish` throws — the far side that refused the write. */
  publishThrows?: string;
  /** When set, `withdraw` throws. */
  withdrawThrows?: string;
}

export interface RecordedPublish {
  readonly name: string;
  readonly record: DnsRecord;
}

export class FakeDnsPublisher implements DnsPublisher {
  /** Every `publish`, in call order. */
  readonly published: RecordedPublish[] = [];
  /** Every `withdraw`, in call order. */
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
