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

void bootstrap().catch(() => {
  const logger = new ConsoleLogger('Bootstrap', { json: true });
  logger.error('Application startup failed; verify local configuration and dependencies');
  process.exitCode = 1;
});
