import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './config';

/** Shared app configuration used by main.ts and integration tests. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  const express = app.getHttpAdapter().getInstance();
  express.set('trust proxy', 'loopback');
  express.disable('x-powered-by');
  return app;
}

async function bootstrap() {
  const cfg = config();
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: false });
  configureApp(app);
  const origins = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim());
  app.enableCors({ origin: origins, credentials: true });
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('CommHub API').setDescription('Internal communication management API').setVersion('0.1.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('api/docs', app, doc);
  app.enableShutdownHooks();
  await app.listen(cfg.PORT);
  Logger.log(`API listening on :${cfg.PORT} (provider mode: ${cfg.PROVIDER_MODE})`, 'Bootstrap');

  // Optional embedded worker mode for zero-cost single-container free tiers (local/prod still supports separate apps/worker process).
  if (process.env.EMBED_WORKER === 'true') {
    const { startWorkerRuntime } = await import('@commhub/worker');
    const rt = await startWorkerRuntime();
    setInterval(() => void rt.publishOutboxOnce(), 1500);
    setInterval(() => void rt.reconcileOnce(), 30_000);
    Logger.log('Embedded BullMQ worker started (EMBED_WORKER=true)', 'Bootstrap');
  }
}

if (require.main === module) void bootstrap();
