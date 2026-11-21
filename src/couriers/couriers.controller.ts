import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { ApiKeyGuard, CurrentTenant } from '../auth/auth.guard';
import { CourierRegistry } from './courier.registry';

@Controller('v1/couriers')
@UseGuards(ApiKeyGuard)
export class CouriersController {
  constructor(private registry: CourierRegistry, private accounts: AccountsService) {}

  /** Supported couriers, the credentials each needs, and which features are verified vs. best-effort. */
  @Get()
  list() {
    return this.registry.list().map((a) => ({ courier: a.courier, requiredCredentials: a.requiredCredentials, capabilities: a.capabilities }));
  }

  @Get(':courier/cities')
  async cities(@CurrentTenant() t: Tenant, @Param('courier') courier: string, @Query('accountId') accountId?: string) {
    const c = this.registry.parse(courier);
    const acc = await this.accounts.resolve(t.id, c, accountId);
    const cities = await this.registry.get(c).getCities(this.accounts.toContext(acc));
    return { count: cities.length, cities };
  }

  /** The courier's own status list (PostEx get-order-status, TCS delivery status list). */
  @Get(':courier/status-catalog')
  async catalog(@CurrentTenant() t: Tenant, @Param('courier') courier: string, @Query('accountId') accountId?: string) {
    const c = this.registry.parse(courier);
    const adapter = this.registry.get(c);
    if (!adapter.getStatusCatalog) throw new BadRequestException(`${c} does not expose a status catalog`);
    const acc = await this.accounts.resolve(t.id, c, accountId);
    return adapter.getStatusCatalog(this.accounts.toContext(acc));
  }
}
