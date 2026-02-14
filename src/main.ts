import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS
  const allowedOrigins = configService
    .get<string>('ALLOWED_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  });

  const port = configService.get<number>('PORT', 18795);
  await app.listen(port);

  console.log(`🚀 OpenClaw Face Server running on port ${port}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${port}/chat`);
  console.log(`🔐 Auth endpoint: POST http://localhost:${port}/auth/token`);
  console.log(`❤️  Health endpoint: GET http://localhost:${port}/health`);
}
bootstrap();
