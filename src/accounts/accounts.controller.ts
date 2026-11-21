import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { ApiKeyGuard, CurrentTenant } from '../auth/auth.guard';
import { CourierRegistry } from '../couriers/courier.registry';
import { AccountsService } from './accounts.service';

class CreateAccountDto {
  @IsString() courier: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsBoolean() sandbox?: boolean;
  /** Set false to skip the live credential check. */
  @IsOptional() @IsBoolean() verify?: boolean;
  @IsObject() credentials: Record<string, any>;
}

class SetActiveDto {
  @IsBoolean() active: boolean;
}

@Controller('v1/accounts')
@UseGuards(ApiKeyGuard)
export class AccountsController {
  constructor(private svc: AccountsService, private registry: CourierRegistry) {}

  @Post()
  create(@CurrentTenant() t: Tenant, @Body() dto: CreateAccountDto) {
    return this.svc.create(t.id, { ...dto, courier: this.registry.parse(dto.courier) });
  }

  @Get()
  list(@CurrentTenant() t: Tenant) {
    return this.svc.list(t.id);
  }

  @Post(':id/verify')
  verify(@CurrentTenant() t: Tenant, @Param('id') id: string) {
    return this.svc.verify(t.id, id);
  }

  @Patch(':id')
  setActive(@CurrentTenant() t: Tenant, @Param('id') id: string, @Body() dto: SetActiveDto) {
    return this.svc.setActive(t.id, id, dto.active);
  }

  @Delete(':id')
  remove(@CurrentTenant() t: Tenant, @Param('id') id: string) {
    return this.svc.remove(t.id, id);
  }
}
