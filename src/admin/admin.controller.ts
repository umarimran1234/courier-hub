import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { IsOptional, IsString, IsUrl } from 'class-validator';
import { randomBytes } from 'crypto';
import { AdminGuard, ApiKeyGuard, CurrentTenant } from '../auth/auth.guard';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

class CreateTenantDto {
  @IsString() name: string;
  @IsOptional() @IsUrl({ require_tld: false }) webhookUrl?: string;
}

class WebhookDto {
  @IsUrl({ require_tld: false }) url: string;
  @IsOptional() @IsString() secret?: string;
}

/** Operator endpoints (x-admin-key). */
@Controller('v1/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private prisma: PrismaService) {}

  /** Creates a tenant and returns its API key ONCE. */
  @Post('tenants')
  async createTenant(@Body() dto: CreateTenantDto) {
    const apiKey = CryptoService.randomApiKey();
    const webhookSecret = dto.webhookUrl ? randomBytes(24).toString('hex') : null;
    const t = await this.prisma.tenant.create({
      data: { name: dto.name, apiKeyHash: CryptoService.hashApiKey(apiKey), webhookUrl: dto.webhookUrl, webhookSecret },
    });
    return { id: t.id, name: t.name, apiKey, webhookSecret, note: 'Store the apiKey now; it cannot be shown again.' };
  }

  /** Raw courier statuses the mapper could not classify. Extend RULES in status-mapper.ts for these. */
  @Get('unmapped-statuses')
  unmapped() {
    return this.prisma.unmappedStatus.findMany({ orderBy: [{ count: 'desc' }], take: 200 });
  }
}

/** Tenant self-service. */
@Controller('v1/tenant')
@UseGuards(ApiKeyGuard)
export class TenantController {
  constructor(private prisma: PrismaService) {}

  @Get()
  me(@CurrentTenant() t: Tenant) {
    return { id: t.id, name: t.name, webhookUrl: t.webhookUrl };
  }

  @Patch('webhook')
  async setWebhook(@CurrentTenant() t: Tenant, @Body() dto: WebhookDto) {
    const secret = dto.secret ?? t.webhookSecret ?? randomBytes(24).toString('hex');
    await this.prisma.tenant.update({ where: { id: t.id }, data: { webhookUrl: dto.url, webhookSecret: secret } });
    return { webhookUrl: dto.url, webhookSecret: secret, signatureHeader: 'x-courierhub-signature (HMAC-SHA256 hex of raw body)' };
  }
}
