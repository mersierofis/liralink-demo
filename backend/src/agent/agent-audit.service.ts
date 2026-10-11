import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Append-only JSON lines, the same shape as the terminal agent's log
 * ({time, tool, input, outcome}) plus who and where. Never logs message text, keys or tokens.
 */
@Injectable()
export class AgentAuditService {
  private readonly logger = new Logger(AgentAuditService.name);
  private readonly file =
    process.env.AGENT_AUDIT_LOG ?? path.join(process.cwd(), 'agent-audit.log');

  record(
    merchantId: string,
    tool: string,
    input: unknown,
    outcome: string,
  ): void {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      tool,
      input,
      outcome,
      merchantId,
      source: 'web',
    });
    try {
      fs.appendFileSync(this.file, line + '\n');
    } catch (e) {
      this.logger.warn(`audit log not written: ${(e as Error).message}`);
    }
  }
}
