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
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true });
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('CommHub API').setDescription('Internal communication management API').setVersion('0.1.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('api/docs', app, doc);
  app.enableShutdownHooks();
  await app.listen(cfg.PORT);
  Logger.log(`API listening on :${cfg.PORT} (provider mode: ${cfg.PROVIDER_MODE})`, 'Bootstrap');
}

if (require.main === module) void bootstrap();
