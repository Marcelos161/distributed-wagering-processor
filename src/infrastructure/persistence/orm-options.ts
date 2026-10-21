import { defineConfig } from '@mikro-orm/postgresql';
import { ConsoleLogger } from '@nestjs/common';

const logger = new ConsoleLogger('MikroORM', { json: true });

export function createOrmOptions(clientUrl: string) {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    ensureDatabase: false,
    ensureIndexes: false,
    allowGlobalContext: false,
    pool: { min: 0, max: 5 },
    debug: false,
    logger: (message) => logger.log(message),
  });
}
