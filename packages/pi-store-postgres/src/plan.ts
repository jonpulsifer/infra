/**
 * The net effect of one commit's writes, so a commit costs a fixed number of
 * statements however many writes it carries. Writes apply in order: a later
 * value write replaces an earlier one, and a list delete drops every append
 * before it, stored or not.
 */
import {
  type CommittedWrite,
  type Entry,
  pendingAssistantFrames,
  type UsageRow,
  type Write,
} from '@earendil-works/pi-agent-core';
import { json } from './rows.ts';

export interface Address {
  namespace: string;
  key: string;
}

export interface Element extends Address {
  seq: number;
  value: string;
}

export interface CommitPlan {
  entries: Entry[];
  usage: UsageRow[];
  valueDeletes: Address[];
  valueSets: Element[];
  listDeletes: Address[];
  listAppends: Element[];
}

interface ListPlan {
  address: Address;
  deleted: boolean;
  appends: Element[];
}

const FRAMES = pendingAssistantFrames('', '').namespace;

function addressKey(address: Address): string {
  return JSON.stringify([address.namespace, address.key]);
}

export function planCommit(writes: readonly CommittedWrite[]): CommitPlan {
  const entries: Entry[] = [];
  const usage: UsageRow[] = [];
  const values = new Map<string, Address | Element>();
  const lists = new Map<string, ListPlan>();

  for (const write of writes) {
    if (write.kind === 'entry') {
      const { kind: _kind, ...entry } = write;
      entries.push(entry);
    } else if (write.kind === 'usage') {
      const { kind: _kind, ...row } = write;
      usage.push(row);
    } else if (write.kind === 'value') {
      const address = { namespace: write.namespace, key: write.key };
      values.set(
        addressKey(address),
        write.op === 'delete'
          ? address
          : {
              ...address,
              seq: write.seq,
              value: json(write.value, `value ${write.namespace}`),
            },
      );
    } else {
      const address = { namespace: write.namespace, key: write.key };
      const key = addressKey(address);
      const list = lists.get(key) ?? { address, deleted: false, appends: [] };
      lists.set(key, list);
      if (write.op === 'delete') {
        list.deleted = true;
        list.appends = [];
      } else {
        list.appends.push({
          ...address,
          seq: write.seq,
          value: json(write.value, `list ${write.namespace}`),
        });
      }
    }
  }

  const finals = [...values.values()];
  const plans = [...lists.values()];
  return {
    entries,
    usage,
    valueDeletes: finals.filter((final) => !('seq' in final)),
    valueSets: finals.filter((final): final is Element => 'seq' in final),
    listDeletes: plans
      .filter((list) => list.deleted)
      .map((list) => list.address),
    listAppends: plans.flatMap((list) => list.appends),
  };
}

/**
 * Streamed frames are progress pi can do without: after a crash it rebuilds
 * the partial reply from whichever frames survived. So they commit without
 * waiting for the WAL flush; a later synchronous commit flushes them anyway.
 */
export function isFrameOnly(writes: readonly Write[]): boolean {
  return (
    writes.length > 0 &&
    writes.every(
      (write) =>
        write.kind === 'list' &&
        write.op === 'append' &&
        write.namespace === FRAMES,
    )
  );
}
