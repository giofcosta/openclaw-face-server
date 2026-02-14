import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { BridgeService } from './bridge.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [ChatGateway, BridgeService],
})
export class ChatModule {}
