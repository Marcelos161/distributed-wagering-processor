import { ConsoleLogger } from '@nestjs/common';
import { createApplication } from './create-application.js';
import { readHttpConfiguration } from './infrastructure/config/http-configuration.js';

async function bootstrap(): Promise<void> {
  const { host, port } = readHttpConfiguration(process.env);
  const app = await createApplication();
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);

  try {
    await app.listen(port, host);
  } catch (error: unknown) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  const logger = new ConsoleLogger('Bootstrap', { json: true });
  logger.error(error instanceof Error ? error.message : 'Unknown startup failure');
  process.exitCode = 1;
});
