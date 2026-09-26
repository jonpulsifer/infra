import { readFileSync } from 'node:fs';
import { ConfigError } from '../config.ts';
import type { Log } from '../log.ts';
import { AriClient } from './ari.ts';
import { readBoardConfig } from './config.ts';
import { parseLinePlan } from './lines.ts';
import { BoardModel } from './model.ts';
import { createBoardApp } from './server.ts';

function readPlan(path: string) {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`SWITCHBOARD_PJSIP_CONF cannot be read: ${path}`);
  }
  const plan = parseLinePlan(text);
  if (plan.length === 0) {
    throw new ConfigError(`SWITCHBOARD_PJSIP_CONF names no lines: ${path}`);
  }
  return plan;
}

/**
 * The board: reads the lines from pjsip.conf, polls the PBX's ARI lists, and
 * serves the page. The port opens at once, so the page can say the PBX is
 * unreachable rather than the pod never becoming ready.
 */
export async function startBoard(
  env: Record<string, string | undefined>,
  log: Log,
): Promise<void> {
  const config = readBoardConfig(env);
  const plan = readPlan(config.pjsipConf);
  const model = new BoardModel({
    plan,
    recentLimit: config.recentLimit,
    // One line per finished call for the pod log. The caller's number and
    // name, and the number a handset dialled, stay on the page.
    onEnded: (call) =>
      log.info('call ended', {
        direction: call.direction,
        line: call.line,
        verdict: call.verdict,
        trail: call.trail.join(' '),
        seconds: call.seconds,
        talkedSeconds: call.talkedSeconds,
      }),
  });
  new AriClient({ config, model, log }).start();
  const app = createBoardApp({ board: model });
  Bun.serve({
    port: config.port,
    hostname: '0.0.0.0',
    // An open event stream is idle between pings; Bun's default of 10 s
    // would close it before the 15 s heartbeat.
    idleTimeout: 60,
    fetch: app.fetch,
  });
  log.info('switchboard board listening', {
    port: config.port,
    lines: plan.length,
  });
}
