import { describe, expect, test } from 'bun:test';
import { parseMetrics } from '../src/board/metrics.ts';

// Shaped like the folly PBX's /metrics, trimmed.
const SAMPLE = `# HELP asterisk_endpoints_state Individual endpoint states. 0=unknown; 1=offline; 2=online.
# TYPE asterisk_endpoints_state gauge
asterisk_endpoints_state{eid="02:00:00:00:00:01",id="PJSIP/line4",tech="PJSIP",resource="line4"} 2
asterisk_endpoints_state{eid="02:00:00:00:00:01",id="PJSIP/line3",tech="PJSIP",resource="line3"} 1
asterisk_pjsip_outbound_registration_status{eid="02:00:00:00:00:01",username="sip:168847_1994@pop.example",domain="sip:pop.example:5061;transport=tls",channel_type="PJSIP"} 1
asterisk_pjsip_outbound_registration_status{eid="02:00:00:00:00:01",username="sip:168847_sandbox@pop.example",domain="sip:pop.example:5061;transport=tls",channel_type="PJSIP"} 2
asterisk_pjsip_outbound_registration_status{eid="02:00:00:00:00:01",username="sip:168847_cathy@pop.example",domain="sip:pop.example:5061;transport=tls",channel_type="PJSIP"} 0
asterisk_core_properties{eid="02:00:00:00:00:01",version="22.8.2",build_options="OPTIONAL_API",build_os="Linux"} 1
asterisk_core_uptime_seconds{eid="02:00:00:00:00:01"} 56999
asterisk_calls_count{eid="02:00:00:00:00:01"} 0
`;

describe('the PBX metrics', () => {
  test('reads registrations, endpoints, version and uptime', () => {
    expect(parseMetrics(SAMPLE)).toEqual({
      registrations: {
        '168847_1994': 'registered',
        '168847_sandbox': 'rejected',
        '168847_cathy': 'unregistered',
      },
      endpoints: { line4: 'online', line3: 'offline' },
      version: '22.8.2',
      uptimeSeconds: 56999,
    });
  });

  test('survives an empty or foreign scrape', () => {
    expect(parseMetrics('garbage\nfoo{bar="1"} x\n')).toEqual({
      registrations: {},
      endpoints: {},
      version: undefined,
      uptimeSeconds: undefined,
    });
  });
});
