import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

@Injectable()
export class ApplicationDatabaseCheck implements OnModuleInit {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onModuleInit(): Promise<void> {
    const roles = await this.orm.em.fork().execute<Array<{
      rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean;
    }>>('SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    const role = roles[0];
    if (!role || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolbypassrls) {
      throw new Error('DATABASE_URL must use a non-administrative application role');
    }
  }
}
