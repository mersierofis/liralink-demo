import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());

  const corsOrigins = config
    .get<string>('CORS_ORIGINS')!
    .split(',')
    .map((o) => o.trim());
  app.enableCors({ origin: corsOrigins });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('LiraLink API')
    .setDescription('Payment link → USDC on Stellar → TRY settlement')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = config.get<number>('PORT')!;
  await app.listen(port);
  Logger.log(
    `LiraLink backend listening on :${port} (docs at /docs)`,
    'Bootstrap',
  );
}
bootstrap().catch((err: unknown) => {
  Logger.error(
    'Failed to start LiraLink backend',
    err instanceof Error ? err.stack : String(err),
    'Bootstrap',
  );
  process.exit(1);
});
