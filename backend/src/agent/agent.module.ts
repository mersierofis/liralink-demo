import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { AuthModule } from '../auth/auth.module';
import { FxModule } from '../fx/fx.module';
import { LinksModule } from '../links/links.module';
import { AgentAuditService } from './agent-audit.service';
import { AgentController } from './agent.controller';
import { AgentService, LLM_CLIENT } from './agent.service';
import { AgentToolsService } from './agent-tools.service';
import { ConversationStore } from './conversation.store';
import { DailyLimiter } from './daily-limiter';
import { MerchantThrottlerGuard } from './merchant-throttler.guard';
import { ProposalStore } from './proposal.store';

@Module({
  imports: [AuthModule, LinksModule, FxModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentToolsService,
    AgentAuditService,
    ConversationStore,
    ProposalStore,
    DailyLimiter,
    MerchantThrottlerGuard,
    {
      // null when no key is set: /agent/chat answers 503, the rest of the app is unaffected.
      provide: LLM_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.get<string>('ANTHROPIC_API_KEY');
        return apiKey ? new Anthropic({ apiKey }) : null;
      },
    },
  ],
})
export class AgentModule {}
