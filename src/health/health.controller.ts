import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'openclaw-face-server',
    };
  }

  @Get('ready')
  ready() {
    return {
      status: 'ready',
      timestamp: new Date().toISOString(),
    };
  }
}
