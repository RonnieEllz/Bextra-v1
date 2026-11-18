import 'reflect-metadata';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
const cwdEnv = path.resolve(process.cwd(), '.env');
const workspaceEnv = path.resolve(process.cwd(), '../../.env');
dotenv.config({ path: fs.existsSync(cwdEnv) ? cwdEnv : workspaceEnv });
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';

async function bootstrap() {
  if (process.env.NODE_ENV === 'production' &&
      (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    throw new Error('JWT_SECRET must contain at least 32 characters in production');
  }
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalFilters(new ProblemFilter());
  app.useLogger(['log', 'error', 'warn']);

  const config = new DocumentBuilder()
    .setTitle('BeXtra API')
    .setDescription('BeXtra NFC payments pilot API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('v1/docs', app, document);

  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
  console.log(`BeXtra API listening on port ${process.env.PORT ?? 3000}`);
}

bootstrap();
