import 'reflect-metadata';
import { ConsoleLogger, type INestApplication, type NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

export function createApplication(options: NestApplicationOptions = {}): Promise<INestApplication> {
  return NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true }),
    ...options,
    abortOnError: false,
  });
}
