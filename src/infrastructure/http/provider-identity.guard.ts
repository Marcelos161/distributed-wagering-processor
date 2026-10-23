import { Injectable, type CanActivate } from '@nestjs/common';
/** Local challenge only. Replace with OIDC validation + provider/resource authorization before exposure. */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
